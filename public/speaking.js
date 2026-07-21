const $ = (id) => document.getElementById(id);
let draft = null;
let items = [];
let current = null;
let hintUsed = false;
let startAt = 0;
let timerId = null;
let recognition = null;

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function esc(s='') { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function tags(t=[]) { return t.map(x => `<span class="pill">${esc(x)}</span>`).join(''); }

async function makeDraft() {
  $('draft').textContent = 'AI가 상황과 추천 표현을 정리하는 중...';
  draft = await api('/api/speaking/draft', { method:'POST', body: JSON.stringify({ quickNote: $('quickNote').value, situation: $('situation').value, wantedKo: $('wantedKo').value, actualAttempt: $('actualAttempt').value }) });
  $('situation').value = draft.situation || $('situation').value;
  $('draft').innerHTML = `<div><b>추천 표현</b></div><div class="target">${esc(draft.targetExpression)}</div><div><b>더 간결한 표현</b><br>${esc(draft.conciseExpression||'')}</div><div><b>대안</b><br>${(draft.alternatives||[]).map(esc).join('<br>')}</div><div><b>후속 질문</b><br>${esc(draft.followUpQuestion||'')}</div>${tags(draft.tags)}`;
}

async function saveSpeaking() {
  if (!draft) await makeDraft();
  const data = await api('/api/speaking/items', { method:'POST', body: JSON.stringify({ ...draft, wantedKo: $('wantedKo').value, actualAttempt: $('actualAttempt').value }) });
  current = data.item;
  $('draft').textContent = '저장되었습니다. 바로 복습 큐에 들어갑니다.';
  await loadItems();
}

async function loadItems(filter='') {
  const q = encodeURIComponent($('speakingQ').value || '');
  const sort = $('speakingSort').value;
  const data = await api(`/api/speaking/items?sort=${sort}${filter ? '&filter=due' : ''}${q ? `&q=${q}` : ''}`);
  items = data.items || [];
  $('speakingStats').textContent = `표현 ${items.length}개`;
  $('speakingList').innerHTML = items.map((it,i) => `<div class="item speakingItem" data-i="${i}"><div><b>${esc(it.situation)}</b></div><div class="muted">${esc(it.targetExpression)}</div>${tags(it.tags)}<div class="muted">level ${it.level || 0} · due ${new Date(it.dueAt).toLocaleString()}</div></div>`).join('') || '<div class="muted">아직 저장된 말하기 카드가 없습니다.</div>';
  document.querySelectorAll('.speakingItem').forEach(el => el.onclick = () => selectItem(items[Number(el.dataset.i)]));
}

function selectItem(it) {
  current = it; hintUsed = false; $('transcript').value = ''; $('feedback').textContent = '상황만 보고 먼저 말하세요. 피드백 후 다시 말해야 완료됩니다.';
  $('reviewPane').innerHTML = `<b>상황</b><br>${esc(it.situation)}<br><br><b>정중하고 자연스럽게 말하세요.</b><div id="answer" class="target hiddenAnswer">${esc(it.targetExpression)}</div>`;
}
function startReview(){ if(!items.length) return; selectItem(items[0]); startAt = performance.now(); clearInterval(timerId); timerId=setInterval(()=>{$('timer').textContent=((performance.now()-startAt)/1000).toFixed(1)+'s'},100); }
function reveal(){ const a=document.getElementById('answer'); if(a) a.classList.remove('hiddenAnswer'); }
function hint(){ if(!current) return; hintUsed=true; $('feedback').textContent = `힌트: ${current.conciseExpression || (current.alternatives||[])[0] || current.targetExpression}`; }

function setupSpeech(){ const SR = window.SpeechRecognition || window.webkitSpeechRecognition; if(!SR) return; recognition = new SR(); recognition.lang='en-US'; recognition.interimResults=false; recognition.onresult=e=>{$('transcript').value=Array.from(e.results).map(r=>r[0].transcript).join(' ')}; }
function record(){ if(!recognition) { $('feedback').textContent='이 브라우저는 음성인식을 지원하지 않습니다. 답변을 직접 입력하세요.'; return; } startAt=performance.now(); recognition.start(); }
async function feedback(){ if(!current) return; reveal(); const seconds=(performance.now()-startAt)/1000; const data=await api('/api/speaking/feedback',{method:'POST',body:JSON.stringify({...current, transcript:$('transcript').value, secondsToStart:seconds, hintUsed})}); $('feedback').innerHTML = `<b>추천 평가: ${esc(data.recommendedGrade)}</b><br>${esc(data.reason)}<br><br><b>의미 평가</b>: ${esc(data.meaning)}<br><b>차이 한 가지</b>: ${esc(data.naturalnessTip)}<br><b>다시 말할 문장</b><div class="target">${esc(data.correctedExpression)}</div>`; }
async function grade(g){ if(!current) return; await api(`/api/speaking/review/${current.id}`,{method:'POST',body:JSON.stringify({grade:g})}); $('feedback').textContent=`${g.toUpperCase()} 저장 완료. 다음 카드로 넘어가세요.`; await loadItems('due'); startReview(); }

$('btnDraft').onclick=makeDraft; $('btnSaveSpeaking').onclick=saveSpeaking; $('btnLoadDue').onclick=()=>loadItems('due'); $('btnRefreshSpeaking').onclick=()=>loadItems(); $('speakingSort').onchange=()=>loadItems(); $('btnStartReview').onclick=startReview; $('btnRevealSpeaking').onclick=reveal; $('btnHint').onclick=hint; $('btnRecord').onclick=record; $('btnFeedback').onclick=feedback; ['Again','Hard','Good','Easy'].forEach(x=>$('btn'+x).onclick=()=>grade(x.toLowerCase()));
setupSpeech(); loadItems().catch(e=>$('speakingList').textContent=e.message);
