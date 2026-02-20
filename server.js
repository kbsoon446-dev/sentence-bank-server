import cors from "cors";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import { XMLParser } from "fast-xml-parser";
// ✅ .env 파일 읽기 (키 노출 방지)
import "dotenv/config";

// ✅ Supabase 연결
import { createClient } from "@supabase/supabase-js";


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT ? Number(process.env.PORT) : 8000;
const DATA_FILE = path.join(__dirname, "data.json");

const app = express();
// ✅ Netlify 같은 다른 도메인에서 API 호출 허용
app.use(cors());
// ===============================
// ✅ Supabase 연결 설정
// ===============================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ .env에 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY가 없습니다.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
});

function nowIso() {
  return new Date().toISOString();
}

function decodeEntities(s = "") {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function genId() {
  // short random id, good enough for local use
  return Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
}

async function loadDb() {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf-8");
    const db = JSON.parse(raw);
    if (!db || typeof db !== "object") return { segments: [] };
    if (!Array.isArray(db.segments)) db.segments = [];
    return db;
  } catch (e) {
    return { segments: [] };
  }
}

async function saveDb(db) {
  await fs.writeFile(DATA_FILE, JSON.stringify(db, null, 2), "utf-8");
}

function parseVideoId(urlOrId) {
  const s = String(urlOrId || "").trim();
  if (!s) return "";

  // if already looks like an id
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;

  // common patterns
  // https://www.youtube.com/watch?v=VIDEOID
  const m1 = s.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (m1) return m1[1];

  // https://youtu.be/VIDEOID
  const m2 = s.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (m2) return m2[1];

  // https://www.youtube.com/embed/VIDEOID
  const m3 = s.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
  if (m3) return m3[1];

  return "";
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

// --- Captions (English preferred, fallback ASR) ---
async function fetchCaptionEvents(videoId) {
  const tries = [
    `https://video.google.com/timedtext?lang=en&v=${encodeURIComponent(videoId)}`,
    `https://video.google.com/timedtext?lang=en&kind=asr&v=${encodeURIComponent(videoId)}`,
  ];

  for (const url of tries) {
    const res = await fetch(url);
    const xml = await res.text();
    if (xml && xml.includes("<text")) {
      const obj = xmlParser.parse(xml);
      const texts = obj?.transcript?.text;
      const arr = Array.isArray(texts) ? texts : texts ? [texts] : [];
      const events = arr
        .map((t) => {
          const start = parseFloat(t.start ?? "0");
          const dur = parseFloat(t.dur ?? "0");
          return {
            start,
            end: start + dur,
            text: decodeEntities(String(t["#text"] ?? "")),
          };
        })
        .filter((e) => e.text.length > 0);
      if (events.length) return events;
    }
  }
  return [];
}

function segmentTextFromEvents(events, startSec, endSec) {
  const picked = events
    .filter((e) => e.end > startSec && e.start < endSec)
    .map((e) => e.text);

  const joined = decodeEntities(picked.join(" "));
  const maxLen = 180;
  if (!joined) return "";
  return joined.length > maxLen ? joined.slice(0, maxLen).trim() + "…" : joined;
}

// --- SRS (simple Leitner-like levels) ---
const LEVEL_INTERVAL_DAYS = [0, 1, 3, 7, 14, 30, 60, 120];

function addMinutes(date, minutes) {
  const d = new Date(date.getTime());
  d.setMinutes(d.getMinutes() + minutes);
  return d;
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

function srsUpdate(seg, grade) {
  // grade: again | hard | good | easy
  const maxLevel = LEVEL_INTERVAL_DAYS.length - 1;
  const now = new Date();

  seg.lastReviewedAt = nowIso();
  seg.reviewCount = (seg.reviewCount ?? 0) + 1;

  seg.level = Number.isFinite(seg.level) ? seg.level : 0;
  seg.lapseCount = seg.lapseCount ?? 0;

  if (grade === "again") {
    seg.lapseCount += 1;
    seg.level = clamp(seg.level - 1, 0, maxLevel);
    seg.dueAt = addMinutes(now, 10).toISOString(); // quick retry
    seg.lastGrade = "again";
    return seg;
  }

  if (grade === "hard") {
    // keep level, but make it due sooner (1 day)
    seg.dueAt = addDays(now, 1).toISOString();
    seg.lastGrade = "hard";
    return seg;
  }

  if (grade === "good") {
    seg.level = clamp(seg.level + 1, 0, maxLevel);
    seg.dueAt = addDays(now, LEVEL_INTERVAL_DAYS[seg.level]).toISOString();
    seg.lastGrade = "good";
    return seg;
  }

  if (grade === "easy") {
    seg.level = clamp(seg.level + 2, 0, maxLevel);
    seg.dueAt = addDays(now, LEVEL_INTERVAL_DAYS[seg.level]).toISOString();
    seg.lastGrade = "easy";
    return seg;
  }

  // default: treat as good
  seg.level = clamp(seg.level + 1, 0, maxLevel);
  seg.dueAt = addDays(now, LEVEL_INTERVAL_DAYS[seg.level]).toISOString();
  seg.lastGrade = "good";
  return seg;
}

// --- APIs ---
app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: nowIso() });
});

app.get("/api/caption", async (req, res) => {
  try {
    const videoId = parseVideoId(req.query.videoId);
    const start = Number(req.query.start);
    const end = Number(req.query.end);

    if (!videoId || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return res.status(400).json({ error: "videoId/start/end invalid" });
    }

    const events = await fetchCaptionEvents(videoId);
    const text = events.length ? segmentTextFromEvents(events, start, end) : "";
    return res.json({ text });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// ===============================
// ✅ (1) 세그먼트 목록 가져오기
// GET /api/segments
// ===============================
app.get("/api/segments", async (req, res) => {
  try {
    // 정렬/검색/필터가 더 있으면 나중에 확장 가능
    const { data, error } = await supabase
      .from("segments")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    // ✅ 프론트(app.js)가 기대하는 필드명으로 맞춰주기
    const segments = (data || []).map(row => ({
      id: row.id,
      videoId: row.video_id,
      start: Number(row.start_sec),
      end: Number(row.end_sec),
      text: row.text_en,
      note: row.note,
      level: row.level,
      dueAt: row.due_at
    }));

    return res.json({ segments });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// ===============================
// ✅ (2) 세그먼트 추가
// POST /api/segments
// body: { videoId, start, end, text, note }
// ===============================
app.post("/api/segments", async (req, res) => {
  try {
    const { videoId, start, end, text, note } = req.body || {};

    if (!videoId || typeof start !== "number" || typeof end !== "number") {
      return res.status(400).json({ error: "videoId/start/end required" });
    }

    const nowIso = new Date().toISOString();

    const { data, error } = await supabase
      .from("segments")
      .insert([{
        video_id: String(videoId).trim(),
        start_sec: start,
        end_sec: end,
        text_en: typeof text === "string" ? text : "",
        note: typeof note === "string" ? note : "",
        level: 0,
        due_at: nowIso,
        updated_at: nowIso
      }])
      .select("*")
      .single();

    if (error) return res.status(500).json({ error: error.message });

    return res.json({ ok: true, id: data.id });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// ===============================
// ✅ (3) 세그먼트 수정 (Edit)
// PUT /api/segments/:id
// body: { text, note, videoId, start, end, level, dueAt }
// ===============================
app.put("/api/segments/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const { text, note, videoId, start, end, level, dueAt } = req.body || {};

    // ✅ 업데이트할 값만 구성
    const patch = {};
    if (typeof text === "string") patch.text_en = text;
    if (typeof note === "string") patch.note = note;
    if (typeof videoId === "string" && videoId.trim()) patch.video_id = videoId.trim();
    if (typeof start === "number" && Number.isFinite(start)) patch.start_sec = start;
    if (typeof end === "number" && Number.isFinite(end)) patch.end_sec = end;
    if (typeof level === "number" && Number.isFinite(level)) patch.level = level;
    if (typeof dueAt === "string" && dueAt) patch.due_at = dueAt;

    patch.updated_at = new Date().toISOString();

    const { error } = await supabase
      .from("segments")
      .update(patch)
      .eq("id", id);

    if (error) return res.status(500).json({ error: error.message });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// ===============================
// ✅ (4) 세그먼트 삭제
// DELETE /api/segments/:id
// ===============================
app.delete("/api/segments/:id", async (req, res) => {
  try {
    const id = req.params.id;

    const { error } = await supabase
      .from("segments")
      .delete()
      .eq("id", id);

    if (error) return res.status(500).json({ error: error.message });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// ===============================
// ✅ 리뷰(grade) → Supabase 반영
// POST /api/review/:id
// body: { grade }
// ===============================
app.post("/api/review/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const grade = String(req.body.grade || "good");

    // 1️⃣ 현재 세그먼트 조회
    const { data: seg, error: fetchError } = await supabase
      .from("segments")
      .select("*")
      .eq("id", id)
      .single();

    if (fetchError || !seg) {
      return res.status(404).json({ error: "not found" });
    }

    // 2️⃣ SRS 계산 (기존 함수 재사용)
    const updated = {
      level: seg.level,
      due_at: seg.due_at,
      reviewCount: seg.reviewCount ?? 0,
      lapseCount: seg.lapseCount ?? 0,
      lastReviewedAt: null,
      lastGrade: null
    };

    // 기존 srsUpdate 함수 활용
    const temp = {
      level: seg.level,
      dueAt: seg.due_at,
      reviewCount: seg.reviewCount,
      lapseCount: seg.lapseCount
    };

    srsUpdate(temp, grade);

    updated.level = temp.level;
    updated.due_at = temp.dueAt;
    updated.reviewCount = temp.reviewCount;
    updated.lapseCount = temp.lapseCount;
    updated.lastReviewedAt = new Date().toISOString();
    updated.lastGrade = grade;

    // 3️⃣ Supabase 업데이트
    const { error: updateError } = await supabase
      .from("segments")
      .update(updated)
      .eq("id", id);

    if (updateError) {
      return res.status(500).json({ error: updateError.message });
    }

    return res.json({ ok: true });

  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// fallback -> index.html (for direct open)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Sentence Bank running: http://localhost:${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
});
