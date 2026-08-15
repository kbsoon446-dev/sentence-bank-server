const API_BASE = "https://sentence-bank-server.onrender.com";
let player = null;
let loopTimer = null;

let segments = [];
let currentIndex = -1;

// review state
let reviewQueue = [];
let reviewActive = false;
let revealShown = false;
let initialLoadStarted = false;

function $(id) { return document.getElementById(id); }

function setStatus(msg) { $("status").textContent = msg; }

async function loadInitialSegments() {
  if (initialLoadStarted) return;
  initialLoadStarted = true;

  try {
    await fetchSegments();
  } catch (e) {
    console.error(e);
    setStatus("API error");
  }
}

function fmt(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function parseTimeToSeconds(s) {
  const t = String(s || "").trim();
  if (!t) return NaN;

  if (/^\d{3,4}$/.test(t)) {
    const mm = Number(t.slice(0, -2));
    const ss = Number(t.slice(-2));
    if (!Number.isFinite(mm) || !Number.isFinite(ss) || ss >= 60) return NaN;
    return mm * 60 + ss;
  }

  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);

  // hh:mm:ss or mm:ss
  const parts = t.split(":").map(x => x.trim());
  if (parts.length === 2) {
    const mm = Number(parts[0]);
    const ss = Number(parts[1]);
    if (!Number.isFinite(mm) || !Number.isFinite(ss)) return NaN;
    return mm * 60 + ss;
  }
  if (parts.length === 3) {
    const hh = Number(parts[0]);
    const mm = Number(parts[1]);
    const ss = Number(parts[2]);
    if (!Number.isFinite(hh) || !Number.isFinite(mm) || !Number.isFinite(ss)) return NaN;
    return hh * 3600 + mm * 60 + ss;
  }
  return NaN;
}

function parseVideoId(input) {
  const s = String(input || "").trim();
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

function clearLoopTimer() {
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
}

function startLoopGuard(seg) {
  clearLoopTimer();
  loopTimer = setInterval(() => {
    if (!player || typeof player.getCurrentTime !== "function") return;
    const t = player.getCurrentTime();
    if (t >= seg.end) {
      if ($("loop").checked) {
        player.seekTo(seg.start, true);
      } else {
        player.pauseVideo();
        clearLoopTimer();
      }
    }
  }, 120);
}

function ensurePlayerReady(videoId, startSec = 0) {
  return new Promise((resolve) => {
    const tryResolve = () => {
      if (player && typeof player.loadVideoById === "function") return resolve();
      setTimeout(tryResolve, 100);
    };

    if (player) return tryResolve();

    // player created in onYouTubeIframeAPIReady
    tryResolve();
  });
}

async function playSegmentByIndex(i) {
  if (i < 0 || i >= segments.length) return;
  currentIndex = i;
  const seg = segments[i];

  //$("now").textContent = `[${seg.videoId}] ${fmt(seg.start)}–${fmt(seg.end)}  ·  ${seg.text}`;

  await ensurePlayerReady(seg.videoId, seg.start);

  const rate = parseFloat($("speed").value);
  try { player.setPlaybackRate(rate); } catch {}

  const currentId = player.getVideoData?.().video_id;
  if (currentId !== seg.videoId) {
    player.loadVideoById({ videoId: seg.videoId, startSeconds: seg.start });
  } else {
    player.seekTo(seg.start, true);
  }
  player.playVideo();

  startLoopGuard(seg);
}

function pause() {
  if (!player) return;
  player.pauseVideo();
  clearLoopTimer();
}

async function fetchSegments() {
  setStatus("loading…");
  const sort = $("sort").value;
  const filter = $("filter").value;
  const q = $("q").value.trim();

  const url = new URL("https://sentence-bank-server.onrender.com/api/segments", window.location.origin);
  url.searchParams.set("sort", sort);
  url.searchParams.set("filter", filter);
  if (q) url.searchParams.set("q", q);

  const res = await fetch(url.toString());
  const data = await res.json();
  segments = data.segments || [];

  // ✅ Random 정렬일 때는 프론트에서 셔플(서버가 random을 지원하지 않아도 됨)
if (sort === "random") {
  // Fisher–Yates shuffle
  for (let i = segments.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [segments[i], segments[j]] = [segments[j], segments[i]];
  }
}

  renderStats();
  renderList();

  setStatus("ready");
  refreshReviewInfo();
}

// ===============================
// 📊 상단 Total / Due 표시 계산
// ===============================
function renderStats() {
  const total = segments.length;
  const now = Date.now();

  // 🔥 dueAt이 현재보다 이전인 것만 due
  const dueNow = segments.filter(s => {
    if (!s.dueAt) return false;
    const t = new Date(s.dueAt).getTime();
    return !isNaN(t) && t <= now;
  });

  $("stats").textContent = `Total: ${total} · Due now: ${dueNow.length}`;
}

function renderList() {
  const list = $("list");
  list.innerHTML = "";

  segments.forEach((seg, i) => {
    const el = document.createElement("div");
    el.className = "item";

    const title = seg.text || "(no captions)";
    const meta = `Video: ${seg.videoId} · ${fmt(seg.start)}–${fmt(seg.end)} · Level: ${seg.level ?? 0} · Due: ${new Date(seg.dueAt).toLocaleString()}`;

    el.innerHTML = `
      <div class="itemTop">
        <div>
          <div class="itemTitle">${escapeHtml(title)}</div>
          <div class="itemMeta">${escapeHtml(meta)}</div>
          ${seg.note ? `<div class="itemMeta">Note: ${escapeHtml(seg.note)}</div>` : ""}
        </div>
        <div class="itemBtns">
          <button class="btn primary" data-act="play">Play</button>
          <button class="btn" data-act="review">Review</button>
          <button class="btn" data-act="del">Delete</button>
          <button class="btn" data-act="edit">Edit</button> <!-- ✅ 수정 버튼 추가 -->
          <button class="btn" data-act="speak">말하기에 추가</button>
        </div>
      </div>
    `;

    el.querySelector('[data-act="play"]').onclick = () => playSegmentByIndex(i);
    el.querySelector('[data-act="review"]').onclick = () => startSingleReview(seg.id);
    el.querySelector('[data-act="speak"]').onclick = () => {
      const sourceText = encodeURIComponent(seg.text || seg.note || "");
      window.open(`/speaking.html?sourceText=${sourceText}`, "_blank");
    };
    el.querySelector('[data-act="del"]').onclick = async () => {
      if (!confirm("Delete this segment?")) return;
      await fetch(`https://sentence-bank-server.onrender.com/api/segments/${encodeURIComponent(seg.id)}`, { method: "DELETE" });
      await fetchSegments();
    }
    // =======================
// Edit 버튼 클릭 처리
// 자막 / 메모 / 시작시간 / 끝시간 / 영상ID 수정
// =======================
el.querySelector('[data-act="edit"]').onclick = async () => {

  // 1️⃣ 자막 수정
  const newText = prompt("Edit subtitle:", seg.text || "");
  if (newText === null) return;

  // 2️⃣ 메모 수정
  const newNote = prompt("Edit note:", seg.note || "");
  if (newNote === null) return;

  // 3️⃣ 시작 시간 수정
  const newStartInput = prompt("Edit start time (mm:ss or seconds):", fmt(seg.start));
  if (newStartInput === null) return;

  // 4️⃣ 끝 시간 수정
  const newEndInput = prompt("Edit end time (mm:ss or seconds):", fmt(seg.end));
  if (newEndInput === null) return;

  // 5️⃣ 영상 URL 또는 videoId 수정
  const newYoutubeInput = prompt("Edit YouTube URL or video ID:", seg.videoId || "");
  if (newYoutubeInput === null) return;

  // =======================
  // 입력값 파싱
  // =======================
  const newStart = parseTimeToSeconds(newStartInput);
  const newEnd = parseTimeToSeconds(newEndInput);
  const newVideoId = parseVideoId(newYoutubeInput);

  // 시간/영상ID 검사
  if (!newVideoId || !Number.isFinite(newStart) || !Number.isFinite(newEnd) || newEnd <= newStart) {
    alert("시간 또는 영상 주소가 올바르지 않습니다.");
    return;
  }

  // =======================
  // 서버에 수정 요청
  // =======================
  const res = await fetch(`${API_BASE}/api/segments/${encodeURIComponent(seg.id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: newText,
      note: newNote,
      videoId: newVideoId,
      start: newStart,
      end: newEnd
    })
  });

  if (!res.ok) {
    const msg = await res.text();
    alert("Update failed: " + msg);
    return;
  }

  // 수정 후 목록 다시 불러오기
  await fetchSegments();
};

    list.appendChild(el);
  });
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function fetchCaptionIntoText() {
  const youtube = $("youtube").value.trim();
  const videoId = parseVideoId(youtube);

  const start = parseTimeToSeconds($("start").value);
  const end = parseTimeToSeconds($("end").value);

  if (!videoId || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    alert("Please check URL/videoId and start/end time.");
    return;
  }

  setStatus("fetching captions…");
  const url = new URL(`${API_BASE}/api/caption`);
  url.searchParams.set("videoId", videoId);
  url.searchParams.set("start", String(start));
  url.searchParams.set("end", String(end));

  const res = await fetch(url.toString());
const data = await res.json().catch(() => ({}));

if (!res.ok || data.error) {
  const error = data.error || res.statusText || "unknown error";
  const isMetadataBlocked = error.includes("caption metadata") || error.includes("not playable");
  alert(
    isMetadataBlocked
      ? "이 영상은 서버에서 YouTube 자막 정보를 가져올 수 없어요.\n\n가능한 이유:\n- 영상이 비공개/삭제/지역제한/로그인 필요 상태\n- YouTube가 서버 요청에는 자막 정보를 숨김\n- 해당 언어의 자막/자동자막이 없음\n\n브라우저에서 영상이 재생돼도 서버에서는 자막 접근이 막힐 수 있어요."
      : "자막 가져오기 실패: " + error
  );
  setStatus("ready");
  return;
}

// ✅ 정상일 때만 채우기
$("text").value = data.text || "";

if (!$("text").value.trim()) {
  alert("영어 자막/자동자막을 찾지 못했어요. 영상에 자막이 없거나, YouTube가 서버 요청을 막았을 수 있어요.");
}

setStatus("ready");
}

async function fetchTranscriptIntoText() {
  const youtube = $("youtube").value.trim();
  const videoId = parseVideoId(youtube);

  if (!videoId) {
    alert("Please check URL/videoId.");
    return;
  }

  setStatus("fetching full script…");
  const url = new URL(`${API_BASE}/api/transcript`);
  url.searchParams.set("videoId", videoId);

  const res = await fetch(url.toString());
  const data = await res.json().catch(() => ({}));

  if (!res.ok || data.error) {
    const error = data.error || res.statusText || "unknown error";
    const isMetadataBlocked = error.includes("caption metadata") || error.includes("not playable");
    alert(
      isMetadataBlocked
        ? "이 영상은 서버에서 YouTube 자막 정보를 가져올 수 없어요.\n\n가능한 이유:\n- 영상이 비공개/삭제/지역제한/로그인 필요 상태\n- YouTube가 서버 요청에는 자막 정보를 숨김\n- 해당 언어의 자막/자동자막이 없음\n\n브라우저에서 영상이 재생돼도 서버에서는 자막 접근이 막힐 수 있어요."
        : "스크립트 가져오기 실패: " + error
    );
    setStatus("ready");
    return;
  }

  $("text").value = data.text || "";

  if (!$("text").value.trim()) {
    alert("영어 자막/자동자막을 찾지 못했어요. 영상에 자막이 없거나, YouTube가 서버 요청을 막았을 수 있어요.");
  }

  setStatus("ready");
}

async function saveSegment() {
  const youtube = $("youtube").value.trim();
  const videoId = parseVideoId(youtube);

  const start = parseTimeToSeconds($("start").value);
  const end = parseTimeToSeconds($("end").value);
  const text = $("text").value.trim();
  const note = $("note").value.trim();

  if (!videoId || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    alert("Please check URL/videoId and start/end time.");
    return;
  }

  setStatus("saving…");
  const res = await fetch("https://sentence-bank-server.onrender.com/api/segments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ youtube, videoId, start, end, text, note })
  });
  const data = await res.json();
  if (data.error) {
    alert(data.error);
    setStatus("ready");
    return;
  }

  // clear inputs (keep video url for convenience)
  $("start").value = "";
  $("end").value = "";
  $("text").value = "";
  $("note").value = "";

  await fetchSegments();
  setStatus("ready");
}

// ===============================
// 📋 리뷰 화면 상단 Due 표시
// ===============================
function refreshReviewInfo() {
  const now = Date.now();

  const dueNow = segments.filter(s => {
    if (!s.dueAt) return false;
    const t = new Date(s.dueAt).getTime();
    return !isNaN(t) && t <= now;
  });

  $("reviewInfo").textContent = `Due now: ${dueNow.length}`;
}

function showReviewBox(show) {
  $("reviewBox").classList.toggle("hidden", !show);
}

function setReviewTextHidden() {
  revealShown = false;
  $("reviewText").textContent = "(hidden)";
}

function revealReviewText(text) {
  revealShown = true;
  $("reviewText").textContent = text || "(no captions)";
}

async function startDueReview() {
  reviewActive = true;
  showReviewBox(true);

  // get a fresh due list in due order
  const url = new URL("https://sentence-bank-server.onrender.com/api/segments");
  url.searchParams.set("sort", "due");
  url.searchParams.set("filter", "due");
  const res = await fetch(url.toString());
  const data = await res.json();
  reviewQueue = (data.segments || []);

  if (!reviewQueue.length) {
    $("reviewMeta").textContent = "No due items 🎉";
    setReviewTextHidden();
    return;
  }

  await loadReviewItem(0);
}

async function startSingleReview(id) {
  reviewActive = true;
  showReviewBox(true);

  // use current in-memory segments to find the item
  const seg = segments.find(s => s.id === id);
  reviewQueue = seg ? [seg] : [];
  if (!reviewQueue.length) return;

  await loadReviewItem(0);
}

async function loadReviewItem(i) {
  if (i < 0 || i >= reviewQueue.length) {
    $("reviewMeta").textContent = "Done 🎉";
    setReviewTextHidden();
    return;
  }

  const seg = reviewQueue[i];
  $("reviewMeta").textContent = `Item ${i + 1} / ${reviewQueue.length}  ·  Level ${seg.level ?? 0}`;
  setReviewTextHidden();

  // also play it
  // ensure current list index points to it (if present)
  const idxInList = segments.findIndex(s => s.id === seg.id);
  if (idxInList >= 0) currentIndex = idxInList;

  await playSegmentByIndex(idxInList >= 0 ? idxInList : 0);

  // store current review pointer
  $("reviewBox").dataset.ri = String(i);
  $("reviewBox").dataset.rid = seg.id;
}

async function gradeCurrent(grade) {
  const i = Number($("reviewBox").dataset.ri || "0");
  const id = $("reviewBox").dataset.rid;
  if (!id) return;

  // send grade
  // ✅ 리뷰 요청 보내고, 실패하면 이유를 보여주기
const res = await fetch(`${API_BASE}/api/review/${encodeURIComponent(id)}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ grade })
});

if (!res.ok) {
  const msg = await res.text();
  alert("Review update failed: " + msg);
  return; // 실패면 fetchSegments 하지 말고 멈춤
}

  // refresh list and move next
  await fetchSegments();

  if (reviewQueue.length === 1) {
    $("reviewMeta").textContent = "Saved ✔";
    return;
  }

  await loadReviewItem(i + 1);
}

function stopReview() {
  reviewActive = false;
  reviewQueue = [];
  showReviewBox(false);
}

// keyboard shortcuts
document.addEventListener("keydown", (e) => {
// ===============================
// ✅ 입력칸에서는 단축키(스페이스/화살표 등) 완전 비활성화
//    - document.activeElement가 BODY로 잡히는 경우가 있어서
//      e.target + 특정 입력칸 id까지 같이 체크한다.
// ===============================
const active = document.activeElement;
const activeTag = active?.tagName?.toLowerCase();

// 우리 앱의 입력칸들(id 기준)
const inputIds = new Set(["youtube", "start", "end", "q", "note", "text"]);

// 현재 포커스가 input/textarea/select 이거나,
// 포커스된 요소의 id가 위 입력칸 중 하나면 => 타이핑 중으로 간주
const isTyping =
  activeTag === "input" ||
  activeTag === "textarea" ||
  activeTag === "select" ||
  active?.isContentEditable ||
  (active?.id && inputIds.has(active.id)) ||
  (e.target?.id && inputIds.has(e.target.id));

if (isTyping) {
  // ✅ 입력 중에는 스페이스/화살표 단축키를 아예 실행하지 않음
  //    (스페이스 타이핑이 정상 동작)
  return;
}

// ✅ 입력 중이 아닐 때만 스크롤 방지 + 단축키 사용
if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) {
  e.preventDefault();
}

  if (e.code === "ArrowRight") {
    if (!segments.length) return;
    const next = currentIndex < 0 ? 0 : (currentIndex + 1) % segments.length;
    playSegmentByIndex(next);
  }
  if (e.code === "ArrowLeft") {
    if (!segments.length) return;
    const prev = currentIndex < 0 ? 0 : (currentIndex - 1 + segments.length) % segments.length;
    playSegmentByIndex(prev);
  }
  if (e.code === "ArrowDown") {
    if (currentIndex >= 0) playSegmentByIndex(currentIndex);
  }
// ✅ Space로 재생/일시정지 토글을 하지 않도록 비활성화
// if (e.code === "Space") {
//   if (!player) return;
//   const state = player.getPlayerState();
//   if (state === YT.PlayerState.PLAYING) pause();
//   else if (currentIndex >= 0) playSegmentByIndex(currentIndex);
// }

  if (!reviewActive) return;

// 일반 숫자키 / 숫자패드 / 매크로 키보드 대응
const pressedKeys = [
  String(e.key || ""),
  String(e.code || ""),
  String(e.keyCode || ""),
  String(e.which || "")
];

const gradeMap = {
  "1": "again",
  "Digit1": "again",
  "Numpad1": "again",
  "49": "again",
  "97": "again",

  "2": "hard",
  "Digit2": "hard",
  "Numpad2": "hard",
  "50": "hard",
  "98": "hard",

  "3": "good",
  "Digit3": "good",
  "Numpad3": "good",
  "51": "good",
  "99": "good",

  "4": "easy",
  "Digit4": "easy",
  "Numpad4": "easy",
  "52": "easy",
  "100": "easy"
};

let grade = null;

for (const key of pressedKeys) {
  if (gradeMap[key]) {
    grade = gradeMap[key];
    break;
  }
}

if (grade) {
  e.preventDefault();
  gradeCurrent(grade);
}
});

// UI handlers
$("btnFetch").onclick = fetchCaptionIntoText;
$("btnTranscript").onclick = fetchTranscriptIntoText;
$("btnSave").onclick = saveSegment;
$("btnRefresh").onclick = fetchSegments;

$("btnPlay").onclick = () => {
  if (currentIndex >= 0) playSegmentByIndex(currentIndex);
};
$("btnPause").onclick = pause;

$("sort").onchange = fetchSegments;
$("filter").onchange = fetchSegments;

$("btnStartReview").onclick = startDueReview;
$("btnStopReview").onclick = stopReview;

$("btnReveal").onclick = () => {
  const i = Number($("reviewBox").dataset.ri || "0");
  const seg = reviewQueue[i];
  if (!seg) return;
  revealReviewText(seg.text);
};

document.querySelectorAll(".grade").forEach(btn => {
  btn.addEventListener("click", () => gradeCurrent(btn.dataset.grade));
});

$("speed").onchange = () => {
  if (!player) return;
  try { player.setPlaybackRate(parseFloat($("speed").value)); } catch {}
};

// YouTube IFrame API callback
window.onYouTubeIframeAPIReady = function () {
  player = new YT.Player("player", {
    height: "360",
    width: "640",
    videoId: "dQw4w9WgXcQ", // placeholder
    playerVars: {
      origin: window.location.origin
    },
    events: {
      onReady: async () => {
        await loadInitialSegments();
      }
    }
  });
};

document.addEventListener("DOMContentLoaded", () => {
  setTimeout(loadInitialSegments, 1200);
});

// ===== Pagination (10 per page) =====
(() => {
  const PAGE_SIZE = 10;
  let page = 1;

  function ensurePager(listEl) {
    let pager = document.getElementById("pager");
    if (!pager) {
      pager = document.createElement("div");
      pager.id = "pager";
      pager.style.display = "flex";
      pager.style.gap = "10px";
      pager.style.alignItems = "center";
      pager.style.marginTop = "12px";

      const btnPrev = document.createElement("button");
      btnPrev.textContent = "◀";
      btnPrev.className = "btn";
      btnPrev.onclick = () => { page = Math.max(1, page - 1); apply(); };

      const info = document.createElement("span");
      info.id = "pagerInfo";

      const btnNext = document.createElement("button");
      btnNext.textContent = "▶";
      btnNext.className = "btn";
      btnNext.onclick = () => { page = page + 1; apply(); };

      pager.appendChild(btnPrev);
      pager.appendChild(info);
      pager.appendChild(btnNext);

      // list 아래에 붙이기
      listEl.after(pager);
    }
    return pager;
  }

  function apply() {
    const listEl = document.getElementById("list");
    if (!listEl) return;

    const items = Array.from(listEl.children);
    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    if (page > totalPages) page = totalPages;

    const start = (page - 1) * PAGE_SIZE;
    const end = start + PAGE_SIZE;

    items.forEach((el, i) => {
      el.style.display = (i >= start && i < end) ? "" : "none";
    });

    ensurePager(listEl);
    const info = document.getElementById("pagerInfo");
    if (info) info.textContent = `Page ${page} / ${totalPages}  (←/→)`;
  }

  // 리스트가 바뀔 때마다(Refresh, Save 등) 자동으로 다시 적용
  function watch() {
    const listEl = document.getElementById("list");
    if (!listEl) return;

    ensurePager(listEl);

    const mo = new MutationObserver(() => apply());
    mo.observe(listEl, { childList: true });

    
    apply();
  }

  // DOM 준비되면 시작
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", watch);
  } else {
    watch();
  }
})();


// ===============================
// 📱 모바일용 이전 / 다음 버튼 추가
// ===============================

function addMobileNavButtons() {

  // Player 영역 찾기
  const playerSection = document.querySelector(".playerWrap");
  if (!playerSection) return;

  // 이미 버튼이 있으면 중복 생성 방지
  if (document.getElementById("mobileNav")) return;

  // 버튼 감싸는 div 생성
  const nav = document.createElement("div");
  nav.id = "mobileNav";
  nav.style.display = "flex";
  nav.style.justifyContent = "center";
  nav.style.gap = "20px";
  nav.style.marginTop = "15px";

  // 이전 버튼
  const prevBtn = document.createElement("button");
  prevBtn.textContent = "◀ Prev";
  prevBtn.className = "btn";
  prevBtn.onclick = () => {
    // 기존 키보드 왼쪽 화살표 기능 호출
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowLeft" }));
  };

  // 다음 버튼
  const nextBtn = document.createElement("button");
  nextBtn.textContent = "Next ▶";
  nextBtn.className = "btn primary";
  nextBtn.onclick = () => {
    // 기존 키보드 오른쪽 화살표 기능 호출
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowRight" }));
  };

  nav.appendChild(prevBtn);
  nav.appendChild(nextBtn);

  // Player 아래에 붙이기
  playerSection.after(nav);
}

// 페이지 로드되면 버튼 추가
document.addEventListener("DOMContentLoaded", addMobileNavButtons);

// ✅ Title 칸 클릭하면 포커스 확실히 주기(유튜브 iframe이 포커스 뺏는 것 완화)
$("text").addEventListener("mousedown", () => $("text").focus());
