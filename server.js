import cors from "cors";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import { XMLParser } from "fast-xml-parser";
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import ytdl from "@distube/ytdl-core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT ? Number(process.env.PORT) : 8000;
const DATA_FILE = path.join(__dirname, "data.json");

const app = express();
app.use(cors());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const YOUTUBE_TRANSCRIPT_IO_TOKEN = process.env.YOUTUBE_TRANSCRIPT_IO_TOKEN;
const OPENAI_TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1";
const MAX_AI_AUDIO_BYTES = Number(process.env.MAX_AI_AUDIO_BYTES || 24 * 1024 * 1024);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.");
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

function extractJsonAfter(html, marker) {
  const start = html.indexOf(marker);
  if (start === -1) return null;

  const jsonStart = html.indexOf("{", start + marker.length);
  if (jsonStart === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = jsonStart; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;

    if (depth === 0) {
      try {
        return JSON.parse(html.slice(jsonStart, i + 1));
      } catch {
        return null;
      }
    }
  }

  return null;
}

function extractYtcfg(html) {
  const merged = {};
  let offset = 0;

  while (offset < html.length) {
    const markerIndex = html.indexOf("ytcfg.set(", offset);
    if (markerIndex === -1) break;
    const value = extractJsonAfter(html.slice(markerIndex), "ytcfg.set(");
    if (value && typeof value === "object") Object.assign(merged, value);
    offset = markerIndex + 10;
  }

  const apiKey = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/)?.[1];
  if (apiKey) merged.INNERTUBE_API_KEY = apiKey;

  const clientVersion = html.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/)?.[1];
  if (clientVersion) merged.INNERTUBE_CLIENT_VERSION = clientVersion;

  const contextIndex = html.indexOf('"INNERTUBE_CONTEXT"');
  if (contextIndex !== -1) {
    const contextStart = html.indexOf("{", contextIndex);
    const context = contextStart !== -1 ? extractJsonAfter(html.slice(contextStart), "") : null;
    if (context?.client) merged.INNERTUBE_CONTEXT = context;
  }

  return merged;
}

function playerResponseCaptionTracks(player) {
  return player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
}

function pickCaptionTrack(tracks, lang) {
  const captionLang = normalizeCaptionLanguage(lang);
  const isEnglish = captionLang === "en" || captionLang.startsWith("en-");
  const candidates = isEnglish
    ? tracks
    : tracks.filter((track) => track.kind === "asr");

  const manualCandidates = candidates.filter((track) => track.kind !== "asr");
  const exactManual = manualCandidates.find((track) => track.languageCode === captionLang);
  if (exactManual) return exactManual;

  const prefixManual = manualCandidates.find((track) => track.languageCode?.startsWith(`${captionLang}-`));
  if (prefixManual) return prefixManual;

  const exact = candidates.find((track) => track.languageCode === captionLang);
  if (exact) return exact;

  const prefix = candidates.find((track) => track.languageCode?.startsWith(`${captionLang}-`));
  if (prefix) return prefix;

  if (isEnglish) {
    return (
      candidates.find((track) => track.languageCode === "en" && track.kind !== "asr") ||
      candidates.find((track) => track.languageCode === "en") ||
      candidates.find((track) => track.languageCode?.startsWith("en-"))
    );
  }

  return null;
}

function parseJson3Caption(data) {
  return (data.events || [])
    .filter((event) => event.segs?.length)
    .map((event) => {
      const start = (event.tStartMs || 0) / 1000;
      const dur = (event.dDurationMs || 0) / 1000;
      return {
        start,
        end: start + dur,
        text: decodeEntities(event.segs.map((seg) => seg.utf8 || "").join("")),
      };
    })
    .filter((event) => event.text.length > 0);
}

async function captionEventsFromTrack(track) {
  if (!track?.baseUrl) return [];

  const url = new URL(track.baseUrl);
  url.searchParams.set("fmt", "json3");

  const captionRes = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
      "accept-language": "en-US,en;q=0.9,ko;q=0.8",
    },
  });
  if (!captionRes.ok) return [];
  const body = await captionRes.text();
  if (!body.trim()) return [];

  try {
    return parseJson3Caption(JSON.parse(body));
  } catch {
    return [];
  }
}

function innertubeClientContexts(ytcfg) {
  const webClientVersion = ytcfg?.INNERTUBE_CLIENT_VERSION || "2.20260101.00.00";
  const webContext = ytcfg?.INNERTUBE_CONTEXT;
  const contexts = [];

  if (webContext?.client) contexts.push(webContext);

  contexts.push(
    {
      client: {
        clientName: "WEB",
        clientVersion: webClientVersion,
        hl: "en",
        gl: "US",
      },
    },
    {
      client: {
        clientName: "WEB_EMBEDDED_PLAYER",
        clientVersion: webClientVersion,
        hl: "en",
        gl: "US",
        clientScreen: "EMBED",
      },
    },
    {
      client: {
        clientName: "ANDROID",
        clientVersion: "19.09.37",
        androidSdkVersion: 30,
        hl: "en",
        gl: "US",
      },
    },
    {
      client: {
        clientName: "IOS",
        clientVersion: "19.09.3",
        deviceMake: "Apple",
        deviceModel: "iPhone16,2",
        osName: "iPhone",
        osVersion: "17.5.1.21F90",
        hl: "en",
        gl: "US",
      },
    }
  );

  const seen = new Set();
  return contexts.filter((context) => {
    const key = `${context.client?.clientName}:${context.client?.clientVersion}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchCaptionEventsFromInnertube(videoId, lang, ytcfg = {}) {
  const apiKey = ytcfg?.INNERTUBE_API_KEY;
  if (!apiKey) return [];

  for (const context of innertubeClientContexts(ytcfg)) {
    try {
      const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
          "accept-language": "en-US,en;q=0.9,ko;q=0.8",
          origin: "https://www.youtube.com",
          referer: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
        },
        body: JSON.stringify({
          context,
          videoId,
          playbackContext: {
            contentPlaybackContext: {
              html5Preference: "HTML5_PREF_WANTS",
            },
          },
        }),
      });

      if (!res.ok) continue;
      const player = await res.json();
      const tracks = playerResponseCaptionTracks(player);
      const track = pickCaptionTrack(tracks, lang);
      const events = await captionEventsFromTrack(track);
      if (events.length) return events;
    } catch {
      // Try the next client context.
    }
  }

  return [];
}

async function downloadYouTubeAudio(videoId) {
  const youtubeUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const stream = ytdl(youtubeUrl, {
    filter: "audioonly",
    quality: "lowestaudio",
    highWaterMark: 1 << 25,
    requestOptions: {
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        "accept-language": "en-US,en;q=0.9,ko;q=0.8",
      },
    },
  });

  const chunks = [];
  let total = 0;

  for await (const chunk of stream) {
    total += chunk.length;
    if (total > MAX_AI_AUDIO_BYTES) {
      stream.destroy();
      throw new Error("Audio is too large for AI transcription");
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function transcribeYouTubeAudio(videoId) {
  if (!OPENAI_API_KEY) {
    throw new Error("AI transcription is not configured. Set OPENAI_API_KEY on Render.");
  }

  const audio = await downloadYouTubeAudio(videoId);
  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/webm" }), `${videoId}.webm`);
  form.append("model", OPENAI_TRANSCRIBE_MODEL);
  form.append("language", "en");
  form.append("response_format", "verbose_json");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: form,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error?.message || "AI transcription failed");
  }

  if (Array.isArray(data.segments) && data.segments.length) {
    return data.segments
      .map((segment) => ({
        start: Number(segment.start || 0),
        end: Number(segment.end || segment.start || 0),
        text: decodeEntities(segment.text || ""),
      }))
      .filter((event) => event.text.length > 0);
  }

  const text = decodeEntities(data.text || "");
  return text ? [{ start: 0, end: Number.POSITIVE_INFINITY, text }] : [];
}

function transcriptIoEventsFromItem(item) {
  const rawEvents =
    item?.segments ||
    item?.transcript ||
    item?.tracks?.[0]?.transcript ||
    item?.tracks?.[0]?.segments ||
    [];

  if (Array.isArray(rawEvents)) {
    return rawEvents
      .map((event) => {
        const start = Number(event.start ?? event.offset ?? event.startTime ?? 0);
        const duration = Number(event.duration ?? event.dur ?? 0);
        const explicitEnd = Number(event.end ?? event.endTime);
        return {
          start,
          end: Number.isFinite(explicitEnd) && explicitEnd > start ? explicitEnd : start + duration,
          text: decodeEntities(event.text ?? event.caption ?? event.content ?? ""),
        };
      })
      .filter((event) => Number.isFinite(event.start) && event.text.length > 0);
  }

  const text = decodeEntities(item?.text || item?.transcript || "");
  return text ? [{ start: 0, end: Number.POSITIVE_INFINITY, text }] : [];
}

async function fetchCaptionEventsFromTranscriptIo(videoId) {
  if (!YOUTUBE_TRANSCRIPT_IO_TOKEN) {
    throw new Error("youtube-transcript.io API is not configured. Set YOUTUBE_TRANSCRIPT_IO_TOKEN on Render.");
  }

  const res = await fetch("https://www.youtube-transcript.io/api/transcripts", {
    method: "POST",
    headers: {
      authorization: `Basic ${YOUTUBE_TRANSCRIPT_IO_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ids: [videoId] }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.message || data?.error || `youtube-transcript.io API failed (${res.status})`);
  }

  const item = Array.isArray(data) ? data[0] : data?.transcripts?.[0] || data?.data?.[0] || data?.results?.[0] || data;
  const events = transcriptIoEventsFromItem(item);
  if (!events.length) {
    throw new Error("youtube-transcript.io returned no transcript text");
  }
  return events;
}

async function fetchCaptionEventsFromWatchPage(videoId, lang) {
  const res = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
      "accept-language": "en-US,en;q=0.9,ko;q=0.8",
    },
  });
  const html = await res.text();
  const ytcfg = extractYtcfg(html);
  const player = extractJsonAfter(html, "ytInitialPlayerResponse");

  if (player) {
    const status = player?.playabilityStatus;
    if (status?.status === "ERROR") {
      throw new Error(status.reason || "YouTube video is not playable");
    }

    const tracks = playerResponseCaptionTracks(player);
    const track = pickCaptionTrack(tracks, lang);
    const events = await captionEventsFromTrack(track);
    if (events.length) return events;
  }

  const innertubeEvents = await fetchCaptionEventsFromInnertube(videoId, lang, ytcfg);
  if (innertubeEvents.length) return innertubeEvents;

  throw new Error("YouTube caption metadata is not available for this video");
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
    : [
        `https://video.google.com/timedtext?lang=${encodedLang}&kind=asr&v=${video}`,
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

  try {
    return await fetchCaptionEventsFromWatchPage(videoId, captionLang);
  } catch (captionError) {
    try {
      const transcriptIoEvents = await fetchCaptionEventsFromTranscriptIo(videoId);
      if (transcriptIoEvents.length) return transcriptIoEvents;
    } catch (transcriptIoError) {
      if (YOUTUBE_TRANSCRIPT_IO_TOKEN) {
        console.warn(`youtube-transcript.io fallback failed: ${transcriptIoError.message}`);
      }
    }

    try {
      const aiEvents = await transcribeYouTubeAudio(videoId);
      if (aiEvents.length) return aiEvents;
    } catch (aiError) {
      throw new Error(`${captionError.message}; ${aiError.message}`);
    }
    throw captionError;
  }
}

function segmentTextFromEvents(events, startSec, endSec) {
  const picked = events
    .filter((e) => e.end > startSec && e.start < endSec)
    .map((e) => e.text);

  const joined = decodeEntities(picked.join(" "));
  const maxLen = 180;
  if (!joined) return "";
  return joined.length > maxLen ? `${joined.slice(0, maxLen).trim()}...` : joined;
}

function transcriptTextFromEvents(events) {
  return decodeEntities(events.map((event) => event.text).join(" "));
}

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

  seg.level = clamp(seg.level + 1, 0, maxLevel);
  seg.dueAt = addDays(now, LEVEL_INTERVAL_DAYS[seg.level]).toISOString();
  seg.lastGrade = "good";
  return seg;
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: nowIso(), build: "review-minimal-v3" });
});

app.get("/api/caption", async (req, res) => {
  try {
    const videoId = parseVideoId(req.query.videoId);
    const lang = normalizeCaptionLanguage(req.query.lang);
    const start = Number(req.query.start);
    const end = Number(req.query.end);

    if (!videoId || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return res.status(400).json({ error: "videoId/start/end invalid" });
    }

    const events = await fetchCaptionEvents(videoId, lang);
    const text = events.length ? segmentTextFromEvents(events, start, end) : "";
    return res.json({ text, lang });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

app.get("/api/transcript", async (req, res) => {
  try {
    const videoId = parseVideoId(req.query.videoId);
    const lang = normalizeCaptionLanguage(req.query.lang);

    if (!videoId) {
      return res.status(400).json({ error: "videoId invalid" });
    }

    const events = await fetchCaptionEvents(videoId, lang);
    const text = events.length ? transcriptTextFromEvents(events) : "";
    return res.json({ text, lang, eventCount: events.length });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

app.get("/api/segments", async (req, res) => {
  try {
    const { filter, sort } = req.query;
    let query = supabase.from("segments").select("*");

    if (filter === "due") {
      query = query.lte("due_at", new Date().toISOString());
    }

    if (sort === "due") {
      query = query.order("due_at", { ascending: true });
    } else if (sort === "oldest") {
      query = query.order("created_at", { ascending: true });
    } else {
      query = query.order("created_at", { ascending: false });
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const segments = (data || []).map((row) => ({
      id: row.id,
      videoId: row.video_id,
      start: Number(row.start_sec),
      end: Number(row.end_sec),
      text: row.text_en,
      note: row.note,
      level: row.level,
      dueAt: row.due_at,
    }));

    return res.json({ segments });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

app.post("/api/segments", async (req, res) => {
  try {
    const { videoId, start, end, text, note } = req.body || {};

    if (!videoId || typeof start !== "number" || typeof end !== "number") {
      return res.status(400).json({ error: "videoId/start/end required" });
    }

    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("segments")
      .insert([{
        video_id: String(videoId).trim(),
        start_sec: start,
        end_sec: end,
        text_en: typeof text === "string" ? text : "",
        note: typeof note === "string" ? note : "",
        level: 0,
        due_at: now,
        updated_at: now,
      }])
      .select("*")
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true, id: data.id });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

app.put("/api/segments/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const { text, note, videoId, start, end, level, dueAt } = req.body || {};
    const patch = {};

    if (typeof text === "string") patch.text_en = text;
    if (typeof note === "string") patch.note = note;
    if (typeof videoId === "string" && videoId.trim()) patch.video_id = videoId.trim();
    if (typeof start === "number" && Number.isFinite(start)) patch.start_sec = start;
    if (typeof end === "number" && Number.isFinite(end)) patch.end_sec = end;
    if (typeof level === "number" && Number.isFinite(level)) patch.level = level;
    if (typeof dueAt === "string" && dueAt) patch.due_at = dueAt;
    patch.updated_at = new Date().toISOString();

    const { error } = await supabase.from("segments").update(patch).eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

app.delete("/api/segments/:id", async (req, res) => {
  try {
    const { error } = await supabase.from("segments").delete().eq("id", req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

app.post("/api/review/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const grade = String(req.body.grade || "good");
    const { data: seg, error: fetchError } = await supabase
      .from("segments")
      .select("id, level, due_at")
      .eq("id", id)
      .single();

    if (fetchError || !seg) {
      return res.status(404).json({ error: "not found" });
    }

    const temp = { level: seg.level ?? 0, dueAt: seg.due_at };
    srsUpdate(temp, grade);

    const { error: updateError } = await supabase
      .from("segments")
      .update({
        level: temp.level,
        due_at: temp.dueAt,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    if (updateError) return res.status(500).json({ error: updateError.message });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Sentence Bank running: http://localhost:${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
});
