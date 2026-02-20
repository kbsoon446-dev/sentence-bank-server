import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import { XMLParser } from "fast-xml-parser";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT ? Number(process.env.PORT) : 8000;
const DATA_FILE = path.join(__dirname, "data.json");

const app = express();
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

app.get("/api/segments", async (req, res) => {
  const db = await loadDb();
  let items = db.segments.slice();

  const q = String(req.query.q || "").trim().toLowerCase();
  if (q) {
    items = items.filter((s) =>
      String(s.text || "").toLowerCase().includes(q) ||
      String(s.note || "").toLowerCase().includes(q) ||
      String(s.videoId || "").toLowerCase().includes(q)
    );
  }

  const filter = String(req.query.filter || "all");
  if (filter === "due") {
    const now = Date.now();
    items = items.filter((s) => new Date(s.dueAt || s.createdAt || 0).getTime() <= now);
  }

  const sort = String(req.query.sort || "newest");
  if (sort === "newest") {
    items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  } else if (sort === "oldest") {
    items.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  } else if (sort === "due") {
    items.sort((a, b) => new Date(a.dueAt || a.createdAt).getTime() - new Date(b.dueAt || b.createdAt).getTime());
  } else if (sort === "random") {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
  }

  res.json({ segments: items });
});

app.post("/api/segments", async (req, res) => {
  const db = await loadDb();

  const youtube = String(req.body.youtube || "").trim();
  const videoId = parseVideoId(req.body.videoId || youtube);
  const start = Number(req.body.start);
  const end = Number(req.body.end);

  if (!videoId || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return res.status(400).json({ error: "videoId/start/end invalid" });
  }

  let text = String(req.body.text || "").trim();
  const note = String(req.body.note || "").trim();

  if (!text) {
    try {
      const events = await fetchCaptionEvents(videoId);
      text = events.length ? segmentTextFromEvents(events, start, end) : "";
    } catch {}
  }

  const seg = {
    id: genId(),
    videoId,
    start,
    end,
    text: text || "(no captions)",
    note,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    // SRS fields
    level: 0,
    dueAt: nowIso(),
    reviewCount: 0,
    lapseCount: 0,
    lastReviewedAt: null,
    lastGrade: null,
  };

  db.segments.unshift(seg);
  await saveDb(db);
  res.json({ segment: seg });
});

app.delete("/api/segments/:id", async (req, res) => {
  const db = await loadDb();
  const before = db.segments.length;
  db.segments = db.segments.filter((s) => s.id !== req.params.id);
  const after = db.segments.length;
  await saveDb(db);
  res.json({ ok: true, removed: before - after });
});

app.put("/api/segments/:id", (req, res) => {
  const { id } = req.params;
  const { videoId, start, end, text, note } = req.body || {};

  const idx = data.segments.findIndex(s => s.id === id);
  if (idx === -1) return res.status(404).json({ error: "not found" });

  // 필요한 값만 업데이트(빈 값은 유지)
  if (typeof videoId === "string" && videoId.trim()) data.segments[idx].videoId = videoId.trim();
  if (typeof start === "number" && Number.isFinite(start)) data.segments[idx].start = start;
  if (typeof end === "number" && Number.isFinite(end)) data.segments[idx].end = end;
  if (typeof text === "string") data.segments[idx].text = text;
  if (typeof note === "string") data.segments[idx].note = note;

  data.segments[idx].updatedAt = Date.now();

  saveData(); // data.json 저장하는 함수(기존에 있을 거야)
  res.json({ ok: true, segment: data.segments[idx] });
});

app.post("/api/review/:id", async (req, res) => {
  const db = await loadDb();
  const id = req.params.id;
  const grade = String(req.body.grade || "good");

  const seg = db.segments.find((s) => s.id === id);
  if (!seg) return res.status(404).json({ error: "not found" });

  srsUpdate(seg, grade);
  seg.updatedAt = nowIso();

  await saveDb(db);
  res.json({ segment: seg });
});

// fallback -> index.html (for direct open)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Sentence Bank running: http://localhost:${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
});
