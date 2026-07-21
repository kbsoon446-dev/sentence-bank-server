const $ = (id) => document.getElementById(id);
let draft = null;
let items = [];
let dueItems = [];
let current = null;
let hintStep = 0;
let startAt = 0;
let timerId = null;
let prepId = null;
let recognition = null;
let feedbackResult = null;
let retrySpoken = false;

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function esc(s = "") { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function tags(t = []) { return t.map(x => `<span class="pill">${esc(x)}</span>`).join(""); }
function setGradesEnabled(enabled) { ["Again", "Hard", "Good", "Easy"].forEach(x => $(`btn${x}`).disabled = !enabled); }
function stopTimer() { clearInterval(timerId); timerId = null; }
function resetCompletionGate() { retrySpoken = false; feedbackResult = null; $("btnRecordRetry").disabled = true; setGradesEnabled(false); }

async function makeDraft() {
  $("draft").textContent = "AI가 말하기 실패 상황을 카드로 정리하는 중...";
  draft = await api("/api/speaking/draft", { method: "POST", body: JSON.stringify({ quickNote: $("quickNote").value, situation: $("situation").value, wantedKo: $("wantedKo").value, actualAttempt: $("actualAttempt").value }) });
  $("situation").value = draft.situation || $("situation").value;
  $("wantedKo").value = draft.intentKo || $("wantedKo").value;
  $("draft").innerHTML = `<div><b>상황</b><br>${esc(draft.situation)}</div><div><b>핵심 의도</b><br>${esc(draft.intentKo || draft.wantedKo || "")}</div><div><b>내 기본 표현</b></div><div class="target">${esc(draft.targetExpression)}</div><div><b>더 간결한 표현</b><br>${esc(draft.conciseExpression || "")}</div><div><b>사용 가능한 다른 표현</b><br>${(draft.alternatives || []).map(esc).join("<br>")}</div><div><b>후속 질문</b><br>${esc(draft.followUpQuestion || "")}</div>${tags(draft.tags)}`;
}

async function saveSpeaking() {
  if (!draft) await makeDraft();
  const data = await api("/api/speaking/items", { method: "POST", body: JSON.stringify({ ...draft, wantedKo: $("wantedKo").value, actualAttempt: $("actualAttempt").value }) });
  current = data.item;
  $("draft").textContent = "저장되었습니다. 바로 복습 큐에 들어갑니다.";
  await loadItems();
}

async function loadItems(filter = "") {
  const q = encodeURIComponent($("speakingQ").value || "");
  const sort = $("speakingSort").value;
  const data = await api(`/api/speaking/items?sort=${sort}${filter ? "&filter=due" : ""}${q ? `&q=${q}` : ""}`);
  items = data.items || [];
  if (filter) dueItems = items;
  renderItems(items);
  await refreshHome();
}

function renderItems(list) {
  $("speakingStats").textContent = `표현 ${list.length}개`;
  $("speakingList").innerHTML = list.map((it, i) => `<div class="item speakingItem" data-i="${i}"><div><b>${esc(it.situation)}</b></div><div class="muted">${esc(it.targetExpression)}</div>${tags(it.tags)}<div class="muted">level ${it.level || 0} · due ${new Date(it.dueAt).toLocaleString()} · ${it.reviewCount || 0}회 복습</div></div>`).join("") || "<div class='muted'>아직 저장된 말하기 카드가 없습니다.</div>";
  document.querySelectorAll(".speakingItem").forEach(el => el.onclick = () => selectItem(list[Number(el.dataset.i)]));
}

async function refreshHome() {
  const due = await api("/api/speaking/items?sort=due&filter=due").catch(() => ({ items: [] }));
  dueItems = due.items || [];
  $("homeDue").textContent = `Due ${dueItems.length}`;
  $("duePreview").innerHTML = dueItems.slice(0, 8).map(x => `• ${esc(x.situation)}`).join("<br>") || "오늘 복습할 항목이 없습니다.";
  $("recentPreview").innerHTML = items.slice(0, 3).map(x => `• ${esc(x.wantedKo || x.situation)}`).join("<br>") || "최근 항목이 없습니다.";
}

function selectItem(it) {
  current = it; hintStep = 0; resetCompletionGate(); $("transcript").value = ""; $("variation").textContent = "";
  $("feedback").textContent = "5초 준비 후 도움 없이 말해보세요. 정답은 숨겨져 있습니다.";
  $("reviewPane").innerHTML = `<b>상황</b><br>${esc(it.situation)}<br><br><b>미션</b><br>정중하고 자연스럽게, 이 상황에서 하고 싶었던 말을 영어로 말하세요.<div id="answer" class="target hiddenAnswer">${esc(it.targetExpression)}</div>`;
  startPrepCountdown();
}

function startPrepCountdown() {
  let left = 5; $("prepCountdown").textContent = left; clearInterval(prepId);
  prepId = setInterval(() => { left -= 1; $("prepCountdown").textContent = Math.max(0, left); if (left <= 0) clearInterval(prepId); }, 1000);
  startAt = performance.now(); stopTimer();
  timerId = setInterval(() => { $("timer").textContent = ((performance.now() - startAt) / 1000).toFixed(1) + "s"; }, 100);
}

function startReview() { const source = dueItems.length ? dueItems : items; if (!source.length) return; selectItem(source[0]); }
function reveal() { const a = document.getElementById("answer"); if (a) a.classList.remove("hiddenAnswer"); feedbackResult = { recommendedGrade: "again" }; }
function hint() { if (!current) return; hintStep += 1; const firstWords = current.targetExpression.split(/\s+/).slice(0, 4).join(" "); const hints = [firstWords, current.conciseExpression || (current.alternatives || [])[0], current.targetExpression]; $("feedback").textContent = `힌트 ${Math.min(hintStep, 3)}: ${hints[Math.min(hintStep - 1, hints.length - 1)]}`; }

function setupSpeech() { const SR = window.SpeechRecognition || window.webkitSpeechRecognition; if (!SR) return; recognition = new SR(); recognition.lang = "en-US"; recognition.interimResults = false; recognition.onresult = e => { $("transcript").value = Array.from(e.results).map(r => r[0].transcript).join(" "); }; }
function record() { if (!recognition) { $("feedback").textContent = "이 브라우저는 음성인식을 지원하지 않습니다. 답변을 직접 입력하세요."; return; } startPrepCountdown(); recognition.start(); }
function recordRetry() { retrySpoken = true; setGradesEnabled(true); if (recognition) recognition.start(); $("feedback").insertAdjacentHTML("beforeend", "<br><br><b>다시 말하기 완료</b> 이제 등급을 저장할 수 있습니다."); }

async function feedback() {
  if (!current) return; reveal(); stopTimer();
  const seconds = (performance.now() - startAt) / 1000;
  const data = await api("/api/speaking/feedback", { method: "POST", body: JSON.stringify({ ...current, transcript: $("transcript").value, secondsToStart: seconds, hintUsed: hintStep > 0, revealedBeforeAnswer: feedbackResult?.recommendedGrade === "again" }) });
  feedbackResult = data;
  $("feedback").innerHTML = `<b>추천 평가: ${esc(data.recommendedGrade)}</b><br>${esc(data.reason)}<br><br><b>의미 평가</b>: ${esc(data.meaning)}<br><b>다음 발화에 가장 도움 되는 차이 한 가지</b>: ${esc(data.naturalnessTip)}<br><b>수정해서 다시 말할 문장</b><div class="target">${esc(data.correctedExpression)}</div>`;
  $("btnRecordRetry").disabled = false;
  const v = await api("/api/speaking/variation", { method: "POST", body: JSON.stringify(current) }).catch(() => null);
  if (v?.variationPrompt) $("variation").innerHTML = `<b>변형 말하기</b><br>${esc(v.variationPrompt)}${v.sampleAnswer ? `<div class="muted">예시: ${esc(v.sampleAnswer)}</div>` : ""}`;
}

async function grade(g) {
  if (!current || !retrySpoken) { $("feedback").insertAdjacentHTML("beforeend", "<br><br>먼저 수정된 문장을 한 번 더 직접 말해야 합니다."); return; }
  await api(`/api/speaking/review/${current.id}`, { method: "POST", body: JSON.stringify({ grade: g }) });
  $("feedback").textContent = `${g.toUpperCase()} 저장 완료. 다음 카드로 넘어갑니다.`;
  await loadItems("due"); startReview();
}

function prefillFromUrl() { const p = new URLSearchParams(location.search); const sourceText = p.get("sourceText"); if (sourceText) { $("quickNote").value = `듣기/읽기에서 발견한 표현을 실제 말하기 상황으로 바꾸기: ${sourceText}`; $("captureCard").scrollIntoView(); } }

$("btnDraft").onclick = makeDraft; $("btnSaveSpeaking").onclick = saveSpeaking; $("btnLoadDue").onclick = () => loadItems("due"); $("btnRefreshSpeaking").onclick = () => loadItems(); $("speakingSort").onchange = () => loadItems(); $("btnStartReview").onclick = startReview; $("btnHomeReview").onclick = startReview; $("btnHeroReview").onclick = startReview; $("btnFocusCapture").onclick = () => $("captureCard").scrollIntoView({ behavior: "smooth" }); $("btnMission").onclick = () => alert("목표 표현 기반 Mission Conversation은 다음 버전 기능입니다. 오늘 Due 표현을 먼저 복습하세요."); $("btnRevealSpeaking").onclick = reveal; $("btnHint").onclick = hint; $("btnRecord").onclick = record; $("btnRecordRetry").onclick = recordRetry; $("btnFeedback").onclick = feedback; ["Again", "Hard", "Good", "Easy"].forEach(x => $(`btn${x}`).onclick = () => grade(x.toLowerCase()));
setupSpeech(); prefillFromUrl(); loadItems().catch(e => $("speakingList").textContent = e.message);
