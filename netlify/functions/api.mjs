import { createClient } from "@supabase/supabase-js";
import { XMLParser } from "fast-xml-parser";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
});

const LEVEL_INTERVAL_DAYS = [0, 1, 3, 7, 14, 30, 60, 120];

function env(name) {
  return globalThis.Netlify?.env?.get(name) ?? process.env[name];
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    },
  });
}

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

function parseVideoId(urlOrId) {
  const s = String(urlOrId || "").trim();
  if (!s) return "";
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;

  const m1 = s.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (m1) return m1[1];

  const m2 = s.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (m2) return m2[1];

  const m3 = s.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
  if (m3) return m3[1];

  return "";
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function normalizeCaptionLanguage(lang) {
  const requested = String(lang || "en").trim().toLowerCase();
  return requested || "en";
}

async function fetchCaptionEvents(videoId, lang = "en") {
  const captionLang = normalizeCaptionLanguage(lang);
  const video = encodeURIComponent(videoId);
  const encodedLang = encodeURIComponent(captionLang);
  const isEnglish = captionLang === "en" || captionLang.startsWith("en-");
  const tries = isEnglish
    ? [
        `https://video.google.com/timedtext?lang=${encodedLang}&v=${video}`,
        `https://video.google.com/timedtext?lang=${encodedLang}&kind=asr&v=${video}`,
      ]
    : [`https://video.google.com/timedtext?lang=${encodedLang}&kind=asr&v=${video}`];

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
        .filter((event) => event.text.length > 0);
      if (events.length) return events;
    }
  }
  return [];
}

function segmentTextFromEvents(events, startSec, endSec) {
  const picked = events
    .filter((event) => event.end > startSec && event.start < endSec)
    .map((event) => event.text);

  const joined = decodeEntities(picked.join(" "));
  const maxLen = 180;
  if (!joined) return "";
  return joined.length > maxLen ? joined.slice(0, maxLen).trim() + "..." : joined;
}

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
  const maxLevel = LEVEL_INTERVAL_DAYS.length - 1;
  const now = new Date();

  seg.lastReviewedAt = nowIso();
  seg.reviewCount = (seg.reviewCount ?? 0) + 1;
  seg.level = Number.isFinite(seg.level) ? seg.level : 0;
  seg.lapseCount = seg.lapseCount ?? 0;

  if (grade === "again") {
    seg.lapseCount += 1;
    seg.level = clamp(seg.level - 1, 0, maxLevel);
    seg.dueAt = addMinutes(now, 10).toISOString();
    seg.lastGrade = "again";
    return seg;
  }

  if (grade === "hard") {
    seg.dueAt = addDays(now, 1).toISOString();
    seg.lastGrade = "hard";
    return seg;
  }

  if (grade === "easy") {
    seg.level = clamp(seg.level + 2, 0, maxLevel);
    seg.dueAt = addDays(now, LEVEL_INTERVAL_DAYS[seg.level]).toISOString();
    seg.lastGrade = "easy";
    return seg;
  }

  seg.level = clamp(seg.level + 1, 0, maxLevel);
  seg.dueAt = addDays(now, LEVEL_INTERVAL_DAYS[seg.level]).toISOString();
  seg.lastGrade = "good";
  return seg;
}

function getSupabase() {
  const supabaseUrl = env("SUPABASE_URL");
  const supabaseServiceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY is not configured in Netlify environment variables.");
  }

  return createClient(supabaseUrl, supabaseServiceRoleKey);
}

function segmentFromRow(row) {
  return {
    id: row.id,
    videoId: row.video_id,
    start: Number(row.start_sec),
    end: Number(row.end_sec),
    text: row.text_en,
    note: row.note,
    level: row.level,
    dueAt: row.due_at,
  };
}

async function handleCaption(url) {
  const videoId = parseVideoId(url.searchParams.get("videoId"));
  const lang = normalizeCaptionLanguage(url.searchParams.get("lang"));
  const start = Number(url.searchParams.get("start"));
  const end = Number(url.searchParams.get("end"));

  if (!videoId || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return json({ error: "videoId/start/end invalid" }, 400);
  }

  const events = await fetchCaptionEvents(videoId, lang);
  const text = events.length ? segmentTextFromEvents(events, start, end) : "";
  return json({ text, lang });
}

async function handleSegments(req, url, id) {
  const supabase = getSupabase();

  if (req.method === "GET" && !id) {
    const filter = url.searchParams.get("filter");
    const sort = url.searchParams.get("sort");
    const q = (url.searchParams.get("q") || "").trim();

    let query = supabase.from("segments").select("*");

    if (filter === "due") {
      query = query.lte("due_at", new Date().toISOString());
    }

    if (q) {
      query = query.or(`text_en.ilike.%${q}%,note.ilike.%${q}%,video_id.ilike.%${q}%`);
    }

    if (sort === "due") {
      query = query.order("due_at", { ascending: true });
    } else if (sort === "oldest") {
      query = query.order("created_at", { ascending: true });
    } else {
      query = query.order("created_at", { ascending: false });
    }

    const { data, error } = await query;
    if (error) return json({ error: error.message }, 500);
    return json({ segments: (data || []).map(segmentFromRow) });
  }

  if (req.method === "POST" && !id) {
    const { videoId, start, end, text, note } = await req.json().catch(() => ({}));

    if (!videoId || typeof start !== "number" || typeof end !== "number") {
      return json({ error: "videoId/start/end required" }, 400);
    }

    const createdAt = nowIso();
    const { data, error } = await supabase
      .from("segments")
      .insert([
        {
          video_id: String(videoId).trim(),
          start_sec: start,
          end_sec: end,
          text_en: typeof text === "string" ? text : "",
          note: typeof note === "string" ? note : "",
          level: 0,
          due_at: createdAt,
          updated_at: createdAt,
        },
      ])
      .select("*")
      .single();

    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, id: data.id });
  }

  if (req.method === "PUT" && id) {
    const { text, note, videoId, start, end, level, dueAt } = await req.json().catch(() => ({}));
    const patch = {};

    if (typeof text === "string") patch.text_en = text;
    if (typeof note === "string") patch.note = note;
    if (typeof videoId === "string" && videoId.trim()) patch.video_id = videoId.trim();
    if (typeof start === "number" && Number.isFinite(start)) patch.start_sec = start;
    if (typeof end === "number" && Number.isFinite(end)) patch.end_sec = end;
    if (typeof level === "number" && Number.isFinite(level)) patch.level = level;
    if (typeof dueAt === "string" && dueAt) patch.due_at = dueAt;
    patch.updated_at = nowIso();

    const { error } = await supabase.from("segments").update(patch).eq("id", id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (req.method === "DELETE" && id) {
    const { error } = await supabase.from("segments").delete().eq("id", id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
}

async function handleReview(req, id) {
  if (req.method !== "POST" || !id) return json({ error: "not found" }, 404);

  const supabase = getSupabase();
  const { grade = "good" } = await req.json().catch(() => ({}));
  const { data: seg, error: fetchError } = await supabase
    .from("segments")
    .select("id, level, due_at")
    .eq("id", id)
    .single();

  if (fetchError || !seg) return json({ error: "not found" }, 404);

  const temp = { level: seg.level ?? 0, dueAt: seg.due_at };
  srsUpdate(temp, String(grade));

  const { error: updateError } = await supabase
    .from("segments")
    .update({ level: temp.level, due_at: temp.dueAt, updated_at: nowIso() })
    .eq("id", id);

  if (updateError) return json({ error: updateError.message }, 500);
  return json({ ok: true });
}

export default async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });

  try {
    const url = new URL(req.url);
    const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
    const [resource, id] = parts;

    if (resource === "health") return json({ ok: true, time: nowIso(), build: "netlify-function-v1" });
    if (resource === "caption") return handleCaption(url);
    if (resource === "segments") return handleSegments(req, url, id);
    if (resource === "review") return handleReview(req, id);

    return json({ error: "not found" }, 404);
  } catch (error) {
    return json({ error: String(error?.message || error) }, 500);
  }
};

export const config = {
  path: "/api/*",
};
