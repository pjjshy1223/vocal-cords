'use strict';

/* ============ storage: IndexedDB ============ */
const DB_NAME = 'vocalcords';
const STORE = 'buttons';
let _db = null;

function openDb() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}
function tx(mode) { return openDb().then(db => db.transaction(STORE, mode).objectStore(STORE)); }
function dbGetAll() {
  return tx('readonly').then(store => new Promise((res, rej) => {
    const r = store.getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error);
  }));
}
function dbPut(rec) {
  return tx('readwrite').then(store => new Promise((res, rej) => {
    const r = store.put(rec); r.onsuccess = () => res(); r.onerror = () => rej(r.error);
  }));
}
function dbDelete(id) {
  return tx('readwrite').then(store => new Promise((res, rej) => {
    const r = store.delete(id); r.onsuccess = () => res(); r.onerror = () => rej(r.error);
  }));
}

/* ============ simple prefs in localStorage ============ */
const PREF = {
  get globalVol() { return parseInt(localStorage.getItem('vc.globalVol') || '150', 10); },
  set globalVol(v) { localStorage.setItem('vc.globalVol', String(v)); },
  get theme() { return localStorage.getItem('vc.theme') || 'dark'; },
  set theme(v) { localStorage.setItem('vc.theme', v); },
  get ttsRecent() { try { return JSON.parse(localStorage.getItem('vc.ttsRecent') || '[]'); } catch { return []; } },
  set ttsRecent(arr) { localStorage.setItem('vc.ttsRecent', JSON.stringify(arr.slice(0, 8))); },
  get ttsVoiceURI() { return localStorage.getItem('vc.ttsVoiceURI') || ''; },
  set ttsVoiceURI(v) { localStorage.setItem('vc.ttsVoiceURI', v || ''); },
  get ttsPitch() { return parseFloat(localStorage.getItem('vc.ttsPitch') || '1'); },
  set ttsPitch(v) { localStorage.setItem('vc.ttsPitch', String(v)); },
};

/* ============ Web Audio: playback with gain ============ */
let _ac = null;
const _bufCache = new Map(); // id -> AudioBuffer
function audioCtx() {
  if (!_ac) _ac = new (window.AudioContext || window.webkitAudioContext)();
  if (_ac.state === 'suspended') _ac.resume();
  return _ac;
}
let _currentSource = null;
async function playRecord(rec, tileEl) {
  const ac = audioCtx();
  let buf = _bufCache.get(rec.id);
  if (!buf) {
    const arr = await rec.blob.arrayBuffer();
    buf = await ac.decodeAudioData(arr.slice(0));
    _bufCache.set(rec.id, buf);
  }
  if (_currentSource) { try { _currentSource.stop(); } catch {} _currentSource = null; }
  const src = ac.createBufferSource();
  src.buffer = buf;
  const g = ac.createGain();
  const totalGain = (PREF.globalVol / 100) * ((rec.gain || 100) / 100);
  g.gain.value = totalGain;
  const comp = ac.createDynamicsCompressor(); // tame clipping on heavy boost
  src.connect(g).connect(comp).connect(ac.destination);
  src.start();
  _currentSource = src;
  if (tileEl) {
    tileEl.classList.add('playing');
    src.onended = () => { tileEl.classList.remove('playing'); if (_currentSource === src) _currentSource = null; };
  }
}
// preview a freshly-recorded blob (used in edit sheet)
async function previewBlob(blob, gainPct) {
  const ac = audioCtx();
  const buf = await ac.decodeAudioData((await blob.arrayBuffer()).slice(0));
  if (_currentSource) { try { _currentSource.stop(); } catch {} }
  const src = ac.createBufferSource(); src.buffer = buf;
  const g = ac.createGain(); g.gain.value = (PREF.globalVol / 100) * (gainPct / 100);
  const comp = ac.createDynamicsCompressor();
  src.connect(g).connect(comp).connect(ac.destination);
  src.start(); _currentSource = src;
}

/* ============ recording ============ */
let _mediaRecorder = null, _recChunks = [], _recStream = null;
async function startRecording() {
  _recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  _recChunks = [];
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
             : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
             : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
  _mediaRecorder = new MediaRecorder(_recStream, mime ? { mimeType: mime } : undefined);
  _mediaRecorder.ondataavailable = e => { if (e.data && e.data.size) _recChunks.push(e.data); };
  _mediaRecorder.start();
}
function stopRecording() {
  return new Promise((resolve) => {
    if (!_mediaRecorder) return resolve(null);
    _mediaRecorder.onstop = () => {
      const blob = new Blob(_recChunks, { type: _recChunks[0] ? _recChunks[0].type : 'audio/webm' });
      if (_recStream) { _recStream.getTracks().forEach(t => t.stop()); _recStream = null; }
      _mediaRecorder = null;
      resolve(blob.size ? blob : null);
    };
    _mediaRecorder.stop();
  });
}

/* ============ TTS ============ */
function allVoices() { try { return speechSynthesis.getVoices() || []; } catch { return []; } }
function koVoices() { return allVoices().filter(v => /^ko/i.test(v.lang)); }
const MALE_RE = /(male|man|남성|남자)/i;
function defaultVoiceURI() {
  const all = allVoices();
  if (PREF.ttsVoiceURI && all.some(v => v.voiceURI === PREF.ttsVoiceURI)) return PREF.ttsVoiceURI;
  const ko = koVoices();
  const male = ko.find(v => MALE_RE.test(v.name));
  return ((male || ko[0] || all[0]) || {}).voiceURI || '';
}
function speak(text) {
  if (!text.trim()) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const v = allVoices().find(x => x.voiceURI === PREF.ttsVoiceURI);
  if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = 'ko-KR'; }
  u.pitch = PREF.ttsPitch;
  u.rate = 1;
  speechSynthesis.speak(u);
}

/* ============ state ============ */
let buttons = []; // sorted by order
function reindex() { buttons.forEach((b, i) => b.order = i); }
async function persistOrder() { reindex(); await Promise.all(buttons.map(dbPut)); }

/* ============ DOM refs ============ */
const $ = sel => document.querySelector(sel);
const gridEl = $('#grid'), emptyEl = $('#empty');
const editBtn = $('#editBtn'), themeBtn = $('#themeBtn');
const globalVol = $('#globalVol'), globalVolOut = $('#globalVolOut');

let editing = false;

/* ============ rendering ============ */
function tileMarkup(name, tag) {
  return `<span class="tile-tag">${tag || ''}</span>
          <span class="tile-name"></span>
          <span class="tile-icon">▶</span>`;
}
function render() {
  gridEl.innerHTML = '';

  // TTS tile (always first)
  const tts = document.createElement('button');
  tts.className = 'tile tts';
  tts.innerHTML = `<span class="tile-tag">직접 입력</span><span class="tile-name">🗣️ 말하기</span><span class="tile-icon">⌨</span>`;
  tts.addEventListener('click', openTtsSheet);
  gridEl.appendChild(tts);

  for (const rec of buttons) {
    const t = document.createElement('button');
    t.className = 'tile' + (rec.pinned ? ' pinned' : '');
    t.dataset.id = rec.id;
    t.innerHTML = tileMarkup(rec.name, rec.pinned ? '고정' : '음성');
    t.querySelector('.tile-name').textContent = rec.name;
    t.addEventListener('click', () => {
      if (editing) { openEditSheet(rec); return; }
      navigator.vibrate && navigator.vibrate(15);
      playRecord(rec, t).catch(() => toast('재생할 수 없어요'));
    });
    gridEl.appendChild(t);
  }

  // add tile (edit mode only)
  if (editing) {
    const add = document.createElement('button');
    add.className = 'tile add';
    add.textContent = '+';
    add.addEventListener('click', () => openEditSheet(null));
    gridEl.appendChild(add);
  }

  emptyEl.classList.toggle('hidden', buttons.length > 0 || editing);
}

/* ============ edit sheet ============ */
const editSheet = $('#editSheet'), editTitle = $('#editTitle');
const nameInput = $('#nameInput'), recBtn = $('#recBtn'), previewBtn = $('#previewBtn'), recStatus = $('#recStatus');
const gainInput = $('#gainInput'), gainOut = $('#gainOut'), editExtra = $('#editExtra');
const pinBtn = $('#pinBtn'), moveUpBtn = $('#moveUpBtn'), moveDownBtn = $('#moveDownBtn'), deleteBtn = $('#deleteBtn');

let editTarget = null;     // existing rec or null (new)
let pendingBlob = null;    // newly recorded blob, or null (keep existing)
let isRecording = false;

function openEditSheet(rec) {
  editTarget = rec;
  pendingBlob = null;
  isRecording = false;
  nameInput.value = rec ? rec.name : '';
  gainInput.value = rec ? (rec.gain || 100) : 100;
  gainOut.value = gainInput.value + '%';
  recBtn.textContent = '● 녹음 시작'; recBtn.classList.remove('recording');
  recStatus.textContent = rec ? '기존 녹음 있음 · 다시 녹음하면 교체됩니다' : '녹음해 주세요';
  previewBtn.disabled = !rec; // can preview existing immediately
  editTitle.textContent = rec ? '음성 버튼 편집' : '새 음성 버튼';
  editExtra.classList.toggle('hidden', !rec);
  if (rec) { pinBtn.setAttribute('aria-pressed', String(!!rec.pinned)); pinBtn.textContent = rec.pinned ? '★ 고정됨' : '★ 고정'; }
  editSheet.classList.remove('hidden');
  nameInput.focus();
}
function closeEditSheet() {
  if (isRecording) { stopRecording(); isRecording = false; }
  editSheet.classList.add('hidden');
  editTarget = null; pendingBlob = null;
}

recBtn.addEventListener('click', async () => {
  if (!isRecording) {
    try {
      await startRecording();
      isRecording = true;
      recBtn.textContent = '■ 녹음 중지'; recBtn.classList.add('recording');
      recStatus.textContent = '녹음 중…';
    } catch (e) {
      recStatus.textContent = '마이크 권한이 필요합니다 (설정에서 허용해 주세요)';
    }
  } else {
    const blob = await stopRecording();
    isRecording = false;
    recBtn.textContent = '● 다시 녹음'; recBtn.classList.remove('recording');
    if (blob) { pendingBlob = blob; previewBtn.disabled = false; recStatus.textContent = '녹음 완료 ✓'; }
    else { recStatus.textContent = '녹음 실패 · 다시 시도해 주세요'; }
  }
});

previewBtn.addEventListener('click', async () => {
  const gainPct = parseInt(gainInput.value, 10);
  try {
    if (pendingBlob) await previewBlob(pendingBlob, gainPct);
    else if (editTarget) await playRecord({ ...editTarget, gain: gainPct }, null);
  } catch { toast('미리듣기 실패'); }
});

gainInput.addEventListener('input', () => { gainOut.value = gainInput.value + '%'; });

$('#editCancelBtn').addEventListener('click', closeEditSheet);
editSheet.addEventListener('click', e => { if (e.target === editSheet) closeEditSheet(); });

$('#editSaveBtn').addEventListener('click', async () => {
  const name = nameInput.value.trim();
  if (!name) { recStatus.textContent = '버튼 이름을 입력해 주세요'; nameInput.focus(); return; }
  if (isRecording) { pendingBlob = await stopRecording(); isRecording = false; }
  if (!editTarget && !pendingBlob) { recStatus.textContent = '먼저 녹음해 주세요'; return; }

  if (editTarget) {
    editTarget.name = name;
    editTarget.gain = parseInt(gainInput.value, 10);
    if (pendingBlob) { editTarget.blob = pendingBlob; _bufCache.delete(editTarget.id); }
    await dbPut(editTarget);
  } else {
    const rec = { id: crypto.randomUUID(), name, gain: parseInt(gainInput.value, 10), blob: pendingBlob, pinned: false, order: buttons.length };
    buttons.push(rec);
    await dbPut(rec);
  }
  closeEditSheet();
  render();
  toast('저장됨');
});

pinBtn.addEventListener('click', async () => {
  if (!editTarget) return;
  editTarget.pinned = !editTarget.pinned;
  pinBtn.setAttribute('aria-pressed', String(editTarget.pinned));
  pinBtn.textContent = editTarget.pinned ? '★ 고정됨' : '★ 고정';
  // move pinned item to front of array
  buttons = buttons.filter(b => b.id !== editTarget.id);
  if (editTarget.pinned) buttons.unshift(editTarget); else buttons.push(editTarget);
  await persistOrder();
  render();
});
function moveBy(delta) {
  if (!editTarget) return;
  const i = buttons.findIndex(b => b.id === editTarget.id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= buttons.length) return;
  [buttons[i], buttons[j]] = [buttons[j], buttons[i]];
  persistOrder();
  render();
}
moveUpBtn.addEventListener('click', () => moveBy(-1));
moveDownBtn.addEventListener('click', () => moveBy(1));
deleteBtn.addEventListener('click', async () => {
  if (!editTarget) return;
  if (!confirm(`"${editTarget.name}" 버튼을 삭제할까요?`)) return;
  await dbDelete(editTarget.id);
  _bufCache.delete(editTarget.id);
  buttons = buttons.filter(b => b.id !== editTarget.id);
  closeEditSheet();
  render();
  toast('삭제됨');
});

/* ============ TTS sheet ============ */
const ttsSheet = $('#ttsSheet'), ttsText = $('#ttsText'), ttsRecent = $('#ttsRecent'), ttsWarn = $('#ttsWarn');
const ttsVoiceSel = $('#ttsVoice'), ttsPitch = $('#ttsPitch'), ttsPitchOut = $('#ttsPitchOut');

function renderRecentChips() {
  ttsRecent.innerHTML = '';
  for (const s of PREF.ttsRecent) {
    const c = document.createElement('button');
    c.className = 'chip'; c.textContent = s;
    c.addEventListener('click', () => { ttsText.value = s; doSpeak(); });
    ttsRecent.appendChild(c);
  }
}
function populateVoiceSelect() {
  const all = allVoices();
  const ko = koVoices();
  const others = all.filter(v => !/^ko/i.test(v.lang));
  const list = ko.concat(others);
  ttsVoiceSel.innerHTML = '';
  if (!list.length) {
    const o = document.createElement('option'); o.textContent = '(기기에 음성이 없어요)'; ttsVoiceSel.appendChild(o);
  }
  for (const v of list) {
    const o = document.createElement('option');
    o.value = v.voiceURI;
    const isKo = /^ko/i.test(v.lang);
    const tag = MALE_RE.test(v.name) ? ' · 남성' : '';
    o.textContent = `${v.name} — ${v.lang}${tag}${isKo ? ' ✓한국어' : ''}`;
    ttsVoiceSel.appendChild(o);
  }
  const want = (PREF.ttsVoiceURI && list.some(v => v.voiceURI === PREF.ttsVoiceURI)) ? PREF.ttsVoiceURI : defaultVoiceURI();
  if (want) { ttsVoiceSel.value = want; PREF.ttsVoiceURI = want; }
  ttsWarn.classList.toggle('hidden', ko.length > 0);
  if (!ko.length) ttsWarn.textContent = '이 기기에 한국어 음성이 없어요. 목록에서 다른 음성을 고르거나, 안드로이드 "설정 > 일반(또는 접근성) > 텍스트 음성 변환(TTS)"에서 한국어 음성을 설치해 보세요. 삼성 기기는 "삼성 TTS"에 남성/여성 한국어 음성이 들어 있는 경우가 많습니다.';
}
function openTtsSheet() {
  ttsSheet.classList.remove('hidden');
  ttsPitch.value = PREF.ttsPitch; ttsPitchOut.textContent = Number(PREF.ttsPitch).toFixed(1);
  populateVoiceSelect();
  if (!allVoices().length) setTimeout(populateVoiceSelect, 400);
  renderRecentChips();
  ttsText.focus();
}
function closeTtsSheet() { speechSynthesis.cancel(); ttsSheet.classList.add('hidden'); }

ttsVoiceSel.addEventListener('change', () => { PREF.ttsVoiceURI = ttsVoiceSel.value; });
ttsPitch.addEventListener('input', () => { ttsPitchOut.textContent = Number(ttsPitch.value).toFixed(1); PREF.ttsPitch = parseFloat(ttsPitch.value); });
if ('speechSynthesis' in window) {
  speechSynthesis.addEventListener('voiceschanged', () => { if (!ttsSheet.classList.contains('hidden')) populateVoiceSelect(); });
}
function doSpeak() {
  const text = ttsText.value.trim();
  if (!text) return;
  navigator.vibrate && navigator.vibrate(15);
  speak(text);
  const recent = PREF.ttsRecent.filter(s => s !== text);
  recent.unshift(text);
  PREF.ttsRecent = recent;
  renderRecentChips();
}
$('#ttsSpeakBtn').addEventListener('click', doSpeak);
$('#ttsCloseBtn').addEventListener('click', closeTtsSheet);
ttsSheet.addEventListener('click', e => { if (e.target === ttsSheet) closeTtsSheet(); });

/* ============ top/bottom bar ============ */
editBtn.addEventListener('click', () => {
  editing = !editing;
  editBtn.setAttribute('aria-pressed', String(editing));
  editBtn.textContent = editing ? '완료' : '편집';
  document.body.classList.toggle('editing', editing);
  render();
});
function applyTheme(t) {
  document.documentElement.dataset.theme = t === 'light' ? 'light' : 'dark';
  document.querySelector('meta[name="theme-color"]').setAttribute('content', t === 'light' ? '#ffffff' : '#0E0F13');
}
themeBtn.addEventListener('click', () => { const t = PREF.theme === 'light' ? 'dark' : 'light'; PREF.theme = t; applyTheme(t); });

globalVol.value = PREF.globalVol; globalVolOut.textContent = PREF.globalVol + '%';
globalVol.addEventListener('input', () => { globalVolOut.textContent = globalVol.value + '%'; PREF.globalVol = parseInt(globalVol.value, 10); });

$('#emptyAddBtn').addEventListener('click', () => openEditSheet(null));

/* ============ install (PWA) ============ */
let _deferredPrompt = null;
const installBtn = $('#installBtn');
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); _deferredPrompt = e; installBtn.classList.remove('hidden'); });
installBtn.addEventListener('click', async () => {
  if (!_deferredPrompt) return;
  _deferredPrompt.prompt();
  try { await _deferredPrompt.userChoice; } catch {}
  _deferredPrompt = null; installBtn.classList.add('hidden');
});
window.addEventListener('appinstalled', () => { _deferredPrompt = null; installBtn.classList.add('hidden'); });

/* ============ toast ============ */
let _toastT = null;
function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.classList.remove('hidden');
  clearTimeout(_toastT); _toastT = setTimeout(() => el.classList.add('hidden'), 1800);
}

/* ============ init ============ */
(async function init() {
  applyTheme(PREF.theme);
  try {
    buttons = await dbGetAll();
    buttons.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    reindex();
  } catch { buttons = []; }
  render();
  // warm up voices list
  if ('speechSynthesis' in window) { try { speechSynthesis.getVoices(); } catch {} }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
