const MANUAL_API_BASE = "https://sentence-bank-server.onrender.com";

function byId(id) {
  return document.getElementById(id);
}

function setManualStatus(message) {
  const status = byId("status");
  if (status) status.textContent = message;
}

function parseManualTimeToSeconds(value) {
  const text = String(value || "").trim();
  if (!text) return NaN;

  if (/^\d{3,4}$/.test(text)) {
    const mm = Number(text.slice(0, -2));
    const ss = Number(text.slice(-2));
    if (!Number.isFinite(mm) || !Number.isFinite(ss) || ss >= 60) return NaN;
    return mm * 60 + ss;
  }

  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);

  const parts = text.split(":").map((part) => Number(part.trim()));
  if (parts.some((part) => !Number.isFinite(part))) return NaN;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return NaN;
}

function parseManualVideoId(input) {
  const text = String(input || "").trim();
  if (!text) return "";
  if (/^[a-zA-Z0-9_-]{11}$/.test(text)) return text;

  const fromQuery = text.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (fromQuery) return fromQuery[1];

  const fromShortUrl = text.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (fromShortUrl) return fromShortUrl[1];

  const fromEmbed = text.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
  if (fromEmbed) return fromEmbed[1];

  return "";
}

function cleanManualSubtitleLine(line) {
  return String(line || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/^>>\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeManualSubtitleText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function parseSubtitleTimestamp(value) {
  const text = String(value || "").trim().replace(",", ".");
  if (!text) return NaN;

  const parts = text.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return NaN;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 1) return parts[0];
  return NaN;
}

function parseManualSubtitleEvents(raw) {
  const lines = String(raw || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim());

  const events = [];
  const time = "\\d{1,2}:\\d{2}(?::\\d{2})?(?:[,.]\\d+)?";
  const rangeRe = new RegExp(`^(?:\\[\\d+\\]\\s*)?(${time})\\s*(?:-->|-|~|to)\\s*(${time})(?:\\s+(.+))?$`, "i");
  const inlineRe = new RegExp(`^(?:\\[\\d+\\]\\s*)?(${time})\\s+(.+)$`, "i");
  const singleTimeRe = new RegExp(`^(?:\\[\\d+\\]\\s*)?(${time})$`, "i");
  const isTimeLine = (line) => rangeRe.test(line) || inlineRe.test(line) || singleTimeRe.test(line);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || /^WEBVTT$/i.test(line) || /^NOTE\b/i.test(line) || /^\d+$/.test(line)) continue;

    const range = line.match(rangeRe);
    if (range) {
      const start = parseSubtitleTimestamp(range[1]);
      const end = parseSubtitleTimestamp(range[2]);
      const textParts = [];
      if (range[3]) textParts.push(cleanManualSubtitleLine(range[3]));

      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j];
        if (!next) break;
        if (/^\d+$/.test(next)) {
          j += 1;
          continue;
        }
        if (isTimeLine(next)) break;
        const cleaned = cleanManualSubtitleLine(next);
        if (cleaned) textParts.push(cleaned);
        j += 1;
      }

      if (Number.isFinite(start) && Number.isFinite(end) && end > start && textParts.length) {
        events.push({ start, end, text: normalizeManualSubtitleText(textParts.join(" ")) });
      }
      i = j - 1;
      continue;
    }

    const inline = line.match(inlineRe);
    const standalone = line.match(singleTimeRe);
    if (inline || standalone) {
      const start = parseSubtitleTimestamp((inline || standalone)[1]);
      const textParts = [];
      if (inline && inline[2]) textParts.push(cleanManualSubtitleLine(inline[2]));

      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j];
        if (!next) break;
        if (/^\d+$/.test(next)) {
          j += 1;
          continue;
        }
        if (isTimeLine(next)) break;
        const cleaned = cleanManualSubtitleLine(next);
        if (cleaned) textParts.push(cleaned);
        j += 1;
      }

      if (Number.isFinite(start) && textParts.length) {
        events.push({ start, end: NaN, text: normalizeManualSubtitleText(textParts.join(" ")) });
      }
      i = j - 1;
    }
  }

  events.sort((a, b) => a.start - b.start);
  return events.map((event, index) => {
    if (Number.isFinite(event.end) && event.end > event.start) return event;
    const nextStart = events[index + 1] && events[index + 1].start;
    return {
      ...event,
      end: Number.isFinite(nextStart) && nextStart > event.start ? nextStart : event.start + 5,
    };
  });
}

function manualTextFromEvents(events, start, end) {
  return normalizeManualSubtitleText(
    events
      .filter((event) => event.end > start && event.start < end)
      .map((event) => event.text)
      .join(" ")
  );
}

function fillTextFromManualSubtitles(options = {}) {
  const silent = Boolean(options.silent);
  const raw = byId("manualSubs").value.trim();
  const start = parseManualTimeToSeconds(byId("start").value);
  const end = parseManualTimeToSeconds(byId("end").value);

  if (!raw) {
    if (!silent) alert("No pasted subtitles/transcript.");
    return false;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    if (!silent) alert("Check Start/End time first.");
    return false;
  }

  const events = parseManualSubtitleEvents(raw);
  if (!events.length) {
    if (!silent) alert("No timestamps found in pasted subtitles.");
    return false;
  }

  const text = manualTextFromEvents(events, start, end);
  if (!text) {
    if (!silent) alert("No pasted subtitle overlaps this Start/End range.");
    return false;
  }

  byId("text").value = text;
  setManualStatus(`filled from pasted subtitles (${events.length} lines)`);
  return true;
}

async function fetchCaptionOrManualIntoText() {
  const videoId = parseManualVideoId(byId("youtube").value);
  const start = parseManualTimeToSeconds(byId("start").value);
  const end = parseManualTimeToSeconds(byId("end").value);

  if (!videoId || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    alert("Please check URL/videoId and start/end time.");
    return;
  }

  setManualStatus("fetching captions...");
  const url = new URL(`${MANUAL_API_BASE}/api/caption`);
  url.searchParams.set("videoId", videoId);
  url.searchParams.set("start", String(start));
  url.searchParams.set("end", String(end));

  const res = await fetch(url.toString());
  const data = await res.json().catch(() => ({}));

  if (!res.ok || data.error) {
    if (byId("manualSubs").value.trim() && fillTextFromManualSubtitles({ silent: true })) {
      setManualStatus("ready");
      return;
    }
    alert("Subtitle fetch failed: " + (data.error || res.statusText || "unknown error"));
    setManualStatus("ready");
    return;
  }

  byId("text").value = data.text || "";
  setManualStatus("ready");
}

async function fetchTranscriptOrManualIntoText() {
  const videoId = parseManualVideoId(byId("youtube").value);
  if (!videoId) {
    alert("Please check URL/videoId.");
    return;
  }

  setManualStatus("fetching full script...");
  const url = new URL(`${MANUAL_API_BASE}/api/transcript`);
  url.searchParams.set("videoId", videoId);

  const res = await fetch(url.toString());
  const data = await res.json().catch(() => ({}));

  if (!res.ok || data.error) {
    if (byId("manualSubs").value.trim() && fillTextFromManualSubtitles({ silent: true })) {
      setManualStatus("ready");
      return;
    }
    alert("Script fetch failed: " + (data.error || res.statusText || "unknown error"));
    setManualStatus("ready");
    return;
  }

  byId("text").value = data.text || "";
  setManualStatus("ready");
}

function installManualSubtitleHandlers() {
  const manualButton = byId("btnManualFill");
  if (manualButton) manualButton.onclick = () => fillTextFromManualSubtitles();

  const fetchButton = byId("btnFetch");
  if (fetchButton) fetchButton.onclick = fetchCaptionOrManualIntoText;

  const transcriptButton = byId("btnTranscript");
  if (transcriptButton) transcriptButton.onclick = fetchTranscriptOrManualIntoText;
}

installManualSubtitleHandlers();
