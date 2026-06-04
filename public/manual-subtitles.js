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

function parseManualTimeRange(value) {
  const text = String(value || "").trim();
  if (!text) return null;

  const timePattern = "\\d{1,2}:\\d{2}(?::\\d{2})?|\\d{3,4}|\\d+(?:\\.\\d+)?";
  const pair = text.match(new RegExp(`^\\s*(${timePattern})\\s*(?:-|~|,|/|\\s+)\\s*(${timePattern})\\s*$`));
  if (pair) return { start: pair[1], end: pair[2] };

  if (/^\d{6,8}$/.test(text)) {
    const middle = Math.floor(text.length / 2);
    return { start: text.slice(0, middle), end: text.slice(middle) };
  }

  return null;
}

function syncManualTimeRange(options = {}) {
  const silent = Boolean(options.silent);
  const rangeInput = byId("timeRange");
  if (!rangeInput) return true;

  const parsed = parseManualTimeRange(rangeInput.value);
  if (!parsed) {
    if (!silent) alert("Enter both times together, like 0423 0428 or 4:23 4:28.");
    return false;
  }

  const startSec = parseManualTimeToSeconds(parsed.start);
  const endSec = parseManualTimeToSeconds(parsed.end);
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
    if (!silent) alert("Check the time range. End must be after start.");
    return false;
  }

  byId("start").value = parsed.start;
  byId("end").value = parsed.end;
  return true;
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

function getManualYouTubeUrl() {
  const input = byId("youtube").value.trim();
  const videoId = parseManualVideoId(input);
  if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
  return input;
}

async function openTranscriptTool() {
  const input = byId("youtube").value.trim();
  const videoId = parseManualVideoId(input);
  const youtubeUrl = getManualYouTubeUrl();

  if (youtubeUrl && navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(youtubeUrl).catch(() => null);
    setManualStatus("copied video URL");
  }

  const transcriptUrl = videoId
    ? `https://www.youtube-transcript.io/videos/${videoId}`
    : "https://www.youtube-transcript.io/";
  window.open(transcriptUrl, "_blank", "noopener,noreferrer");
}

function buildTranscriptMacro() {
  const source = `async()=>{const sleep=t=>new Promise(r=>setTimeout(r,t));const visible=e=>e&&!!(e.offsetWidth||e.offsetHeight||e.getClientRects().length);const text=e=>(e?.innerText||e?.textContent||"").replace(/\\s+/g," ").trim();const all=s=>[...document.querySelectorAll(s)].filter(visible);const clickText=async(re)=>{const el=all("button,a,[role=button],[role=menuitem],label").find(e=>re.test(text(e)));if(!el)return false;el.click();await sleep(700);return true};if(!/youtube-transcript\\.io$/.test(location.hostname)){alert("Open this macro on youtube-transcript.io");return}const copyButton=all("button").find(e=>/copy transcript/i.test(text(e)));if(copyButton){const box=copyButton.closest("div")||copyButton.parentElement;const buttons=box?[...box.querySelectorAll("button")].filter(visible):[];const more=buttons.find(b=>b!==copyButton&&!text(b))||buttons[buttons.length-1];if(more&&more!==copyButton){more.click();await sleep(700)}}else{const more=all("button,[role=button]").find(e=>/more|menu|options/i.test(e.getAttribute("aria-label")||"")||text(e)==="...");if(more){more.click();await sleep(700)}}await clickText(/^edit$/i);await sleep(1000);let sw=all('[role=switch],input[type=checkbox]').find(e=>/include timestamps/i.test(text(e.closest("label")||e.parentElement||e)));if(!sw){const label=all("label,div,span").find(e=>/^include timestamps$/i.test(text(e)));sw=label&&((label.closest("label")||label.parentElement)?.querySelector('[role=switch],input[type=checkbox]'))}if(sw){const checked=sw.checked||sw.getAttribute("aria-checked")==="true"||sw.getAttribute("data-state")==="checked";if(!checked){sw.click();await sleep(800)}}const area=all("textarea").sort((a,b)=>(b.value||"").length-(a.value||"").length)[0];if(area&&area.value){await navigator.clipboard.writeText(area.value);alert("Timestamped transcript copied.");return}if(await clickText(/^copy$/i)){alert("Copy clicked. Paste it into Sentence Bank.");return}alert("Could not find transcript text. Open Edit and try again.")}`;
  return `javascript:(${source})()`;
}

async function copyTranscriptMacro() {
  const macro = buildTranscriptMacro();
  if (!navigator.clipboard || !window.isSecureContext) {
    alert("Clipboard is not available in this browser. Create a bookmark and use the copied macro code manually.");
    return;
  }

  await navigator.clipboard.writeText(macro);
  alert("Macro copied. Create a browser bookmark with this as the URL, then click it on youtube-transcript.io after opening a transcript page.");
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
      .filter((event) => event.start >= start && event.start < end)
      .map((event) => event.text)
      .join(" ")
  );
}

function fillTextFromManualSubtitles(options = {}) {
  const silent = Boolean(options.silent);
  if (!syncManualTimeRange({ silent })) return false;

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
  if (!syncManualTimeRange()) return;

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
  const timeRangeInput = byId("timeRange");
  if (timeRangeInput) {
    timeRangeInput.addEventListener("input", () => syncManualTimeRange({ silent: true }));
    timeRangeInput.addEventListener("blur", () => syncManualTimeRange({ silent: true }));
  }

  const transcriptToolButton = byId("btnOpenTranscriptTool");
  if (transcriptToolButton) transcriptToolButton.onclick = openTranscriptTool;

  const macroButton = byId("btnCopyTranscriptMacro");
  if (macroButton) macroButton.onclick = copyTranscriptMacro;

  const manualButton = byId("btnManualFill");
  if (manualButton) manualButton.onclick = () => fillTextFromManualSubtitles();

  const fetchButton = byId("btnFetch");
  if (fetchButton) fetchButton.onclick = fetchCaptionOrManualIntoText;

  const transcriptButton = byId("btnTranscript");
  if (transcriptButton) transcriptButton.onclick = fetchTranscriptOrManualIntoText;

  const saveButton = byId("btnSave");
  if (saveButton) {
    const originalSave = saveButton.onclick;
    saveButton.onclick = async function (...args) {
      if (!syncManualTimeRange()) return;
      const result = originalSave ? await originalSave.apply(this, args) : undefined;
      if (!byId("start").value && !byId("end").value && timeRangeInput) {
        timeRangeInput.value = "";
      }
      return result;
    };
  }
}

installManualSubtitleHandlers();
