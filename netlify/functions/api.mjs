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

const OPENAI_API_KEY = env("OPENAI_API_KEY");
const SPEAKING_GRADES = new Set(["again", "hard", "good", "easy"]);

function speakingFromRow(row) {
  return {
    id: row.id,
    situation: row.situation,
    wantedKo: row.wanted_ko,
    actualAttempt: row.actual_attempt,
    targetExpression: row.target_expression,
    conciseExpression: row.concise_expression,
    alternatives: row.alternatives || [],
    followUpQuestion: row.follow_up_question,
    tags: row.tags || [],
    level: row.level ?? 0,
    dueAt: row.due_at,
    reviewCount: row.review_count ?? 0,
    lastGrade: row.last_grade,
    createdAt: row.created_at,
  };
}

function normalizeStringArray(value, max = 3) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v || "").trim()).filter(Boolean).slice(0, max);
}

function parseAiJson(text) {
  const raw = String(text || "").trim();
  try { return JSON.parse(raw); } catch {}
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
  }
  return null;
}

function fallbackSpeakingDraft(input) {
  const wanted = String(input.wantedKo || input.quickNote || "").trim();
  return {
    situation: String(input.situation || "A real conversation where someone expects your response.").trim(),
    intentKo: wanted || "상황에 맞게 내 의도를 정중하고 자연스럽게 전달하기",
    targetExpression: wanted ? "I think it’s still too early to draw a conclusion because we don’t have enough information yet." : "I want to explain my point clearly and politely.",
    conciseExpression: "Let me put it this way.",
    alternatives: ["What I mean is...", "I think we may need to look at this again."],
    followUpQuestion: "Could you say a little more about what you mean?",
    tags: normalizeStringArray(input.tags, 5),
  };
}

async function createSpeakingDraft(input) {
  if (!OPENAI_API_KEY) return fallbackSpeakingDraft(input);
  const prompt = `Create ONE speaking-gap card for a Korean English learner. Return strict JSON only with keys: situation, intentKo, targetExpression, conciseExpression, alternatives (1-2 strings), followUpQuestion, tags (1-5 short Korean labels). Do not provide many options. Do not make a Korean-to-English flashcard. Convert the user's failed real-life speaking moment into a situation simulation: what is happening, what the learner wants to do pragmatically, one default sentence they would actually say, one concise alternative, and at most two other usable expressions. Focus on intended meaning, politeness, and production in conversation.

User note: ${input.quickNote || ""}
Situation: ${input.situation || ""}
Wanted Korean: ${input.wantedKo || ""}
Actual English attempt: ${input.actualAttempt || ""}`;
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: env("OPENAI_SPEAKING_MODEL") || "gpt-4o-mini", messages: [{ role: "user", content: prompt }], temperature: 0.4, response_format: { type: "json_object" } }),
  });
  if (!r.ok) return fallbackSpeakingDraft(input);
  const data = await r.json();
  const json = parseAiJson(data?.choices?.[0]?.message?.content);
  return json ? { ...fallbackSpeakingDraft(input), ...json, alternatives: normalizeStringArray(json.alternatives, 2), tags: normalizeStringArray(json.tags, 5) } : fallbackSpeakingDraft(input);
}

function fallbackSpeakingFeedback(input) {
  const seconds = Number(input.secondsToStart || 0);
  return {
    meaning: "meaning_check_needed",
    naturalnessTip: "정답과 똑같이 말하기보다 핵심 의미가 전달됐는지 확인하세요.",
    correctedExpression: input.targetExpression || "Try again with the target expression.",
    recommendedGrade: seconds >= 8 ? "hard" : "good",
    reason: seconds >= 8 ? "8초 이상 걸려 Hard를 추천합니다." : "도움 없이 의미를 전달했다면 Good을 추천합니다.",
  };
}

async function createSpeakingFeedback(input) {
  if (!OPENAI_API_KEY) return fallbackSpeakingFeedback(input);
  const prompt = `Evaluate a spoken English answer by meaning, not exact match. Return strict JSON only: meaning (success/partial/missed), naturalnessTip (Korean, one useful correction only), correctedExpression, recommendedGrade (again/hard/good/easy), reason (Korean). Speaking grade rules: again = could not start or saw the answer first; hard = used a hint or took 8+ seconds; good = conveyed the intended meaning without help; easy = natural and ready for a follow-up question. Mention whether the intended meaning was included, whether grammar blocked understanding, and whether it sounds natural in real conversation.
Situation: ${input.situation}
Target: ${input.targetExpression}
User transcript: ${input.transcript}
Seconds to start: ${input.secondsToStart}
Hint used: ${input.hintUsed}
Revealed before answer: ${input.revealedBeforeAnswer}`;
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: env("OPENAI_SPEAKING_MODEL") || "gpt-4o-mini", messages: [{ role: "user", content: prompt }], temperature: 0.2, response_format: { type: "json_object" } }),
  });
  if (!r.ok) return fallbackSpeakingFeedback(input);
  const data = await r.json();
  const json = parseAiJson(data?.choices?.[0]?.message?.content);
  const out = json ? { ...fallbackSpeakingFeedback(input), ...json } : fallbackSpeakingFeedback(input);
  if (!SPEAKING_GRADES.has(out.recommendedGrade)) out.recommendedGrade = "good";
  return out;
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

function fallbackSpeakingVariation(input) {
  return { variationPrompt: `상황을 조금 바꿔서 다시 말하세요: ${input.followUpQuestion || input.situation || "상대방이 이유를 더 물어봅니다."}`, sampleAnswer: input.conciseExpression || input.targetExpression || "Let me explain that another way." };
}

async function createSpeakingVariation(input) {
  if (!OPENAI_API_KEY) return fallbackSpeakingVariation(input);
  const prompt = `Create one variation speaking prompt so the learner cannot merely repeat the exact same sentence. Return strict JSON only: variationPrompt (Korean), sampleAnswer (English). Reuse the useful chunks from the target expression, but alter tense, reason, stakeholder, or follow-up question. Keep it practical and short.
Situation: ${input.situation}
Target: ${input.targetExpression}
Alternatives: ${(input.alternatives || []).join(" | ")}
Review count: ${input.reviewCount || 0}`;
  const r = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_API_KEY}` }, body: JSON.stringify({ model: env("OPENAI_SPEAKING_MODEL") || "gpt-4o-mini", messages: [{ role: "user", content: prompt }], temperature: 0.35, response_format: { type: "json_object" } }) });
  if (!r.ok) return fallbackSpeakingVariation(input);
  const data = await r.json();
  return parseAiJson(data?.choices?.[0]?.message?.content) || fallbackSpeakingVariation(input);
}

async function handleSpeakingItems(req, url, id) {
  const supabase = getSupabase();
  if (req.method === "GET" && !id) {
    let query = supabase.from("speaking_items").select("*");
    if (url.searchParams.get("filter") === "due") query = query.lte("due_at", new Date().toISOString());
    const q = (url.searchParams.get("q") || "").trim();
    if (q) query = query.or(`situation.ilike.%${q}%,wanted_ko.ilike.%${q}%,target_expression.ilike.%${q}%`);
    const sort = url.searchParams.get("sort") || "newest";
    query = sort === "due" ? query.order("due_at", { ascending: true }) : query.order("created_at", { ascending: sort === "oldest" });
    const { data, error } = await query;
    if (error) return json({ error: error.message }, 500);
    return json({ items: (data || []).map(speakingFromRow) });
  }
  if (req.method === "POST" && !id) {
    const b = await req.json().catch(() => ({}));
    if (!b.situation || !b.targetExpression) return json({ error: "situation/targetExpression required" }, 400);
    const now = nowIso();
    const { data, error } = await supabase.from("speaking_items").insert([{ situation: String(b.situation), wanted_ko: String(b.wantedKo || ""), actual_attempt: String(b.actualAttempt || ""), target_expression: String(b.targetExpression), concise_expression: String(b.conciseExpression || ""), alternatives: normalizeStringArray(b.alternatives, 2), follow_up_question: String(b.followUpQuestion || ""), tags: normalizeStringArray(b.tags, 5), level: 0, due_at: now, review_count: 0, updated_at: now }]).select("*").single();
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, item: speakingFromRow(data) });
  }
  return json({ error: "not found" }, 404);
}

async function handleSpeakingReview(req, id) {
  if (req.method !== "POST" || !id) return json({ error: "not found" }, 404);
  const supabase = getSupabase();
  const { grade = "good" } = await req.json().catch(() => ({}));
  const { data: row, error: fetchError } = await supabase.from("speaking_items").select("id, level, due_at, review_count").eq("id", id).single();
  if (fetchError || !row) return json({ error: "not found" }, 404);
  const temp = { level: row.level ?? 0, dueAt: row.due_at, reviewCount: row.review_count ?? 0 };
  srsUpdate(temp, String(grade));
  const { error } = await supabase.from("speaking_items").update({ level: temp.level, due_at: temp.dueAt, review_count: temp.reviewCount, last_grade: String(grade), updated_at: nowIso() }).eq("id", id);
  if (error) return json({ error: error.message }, 500);
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
    if (resource === "speaking" && id === "items") return handleSpeakingItems(req, url, parts[2]);
    if (resource === "speaking" && id === "draft") return json(await createSpeakingDraft(await req.json().catch(() => ({}))));
    if (resource === "speaking" && id === "feedback") return json(await createSpeakingFeedback(await req.json().catch(() => ({}))));
    if (resource === "speaking" && id === "variation") return json(await createSpeakingVariation(await req.json().catch(() => ({}))));
    if (resource === "speaking" && id === "review") return handleSpeakingReview(req, parts[2]);

    return json({ error: "not found" }, 404);
  } catch (error) {
    return json({ error: String(error?.message || error) }, 500);
  }
};

export const config = {
  path: "/api/*",
};
