// Discover feed (Gemini) — stato e costanti
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/';
const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash';
const GEMINI_MODEL_LS = 'dayflow_gemini_model';    // modello scelto (solo locale)
const GEMINI_MODELS_LS = 'dayflow_gemini_models';  // elenco caricato dalla chiave { ts, models: [{ id, label }] }
const GEMINI_MODEL_RE = /^[a-z0-9][a-z0-9.\-]*$/i;
const GEMINI_PRESETS = [
  { id: 'gemini-2.5-flash', label: 'Flash', note: 'bilanciato (default)' },
  { id: 'gemini-2.5-flash-lite', label: 'Flash-Lite', note: 'più veloce, quota più alta' },
  { id: 'gemini-2.5-pro', label: 'Pro', note: 'più qualità, più lento, quota bassa' }
];
const FEED_KEY_LS = 'dayflow_gemini_key';
const FEED_TOPICS_LS = 'dayflow_feed_topics';
const FEED_CARDS_N = 8;
const FEED_PREFETCH_AHEAD = 3;              // card rimanenti davanti all'utente sotto cui parte il prefetch
const FEED_SEEN_LS = 'dayflow_feed_seen';   // titoli già mostrati (dedupe)
const FEED_SEEN_TTL = 72 * 60 * 60 * 1000;  // memoria 72h
const FEED_SEEN_MAX = 80;                   // max titoli passati a Gemini
const FEED_SAVED_LS = 'dayflow_feed_saved'; // notizie salvate "per dopo"
const FEED_PREFS_LS = 'dayflow_feed_prefs'; // interessi impliciti (articoli aperti / chat)
const FEED_PREFS_TTL = 14 * 24 * 60 * 60 * 1000;
const FEED_PREFS_MAX = 30;
const FEED_PTR_THRESHOLD = 72;              // px di trascinamento per aggiornare
const FEED_PALETTE = ['#60a5fa', '#34d399', '#fbbf24', '#c084fc', '#f472b6', '#fb923c', '#2dd4bf', '#a3e635'];
const FEED_DEFAULT_TOPICS = [
  { id: 'tech', label: 'Tech', emoji: '🔵', color: '#60a5fa' },
  { id: 'sport', label: 'Sport', emoji: '⚽', color: '#34d399' },
  { id: 'crypto', label: 'Crypto', emoji: '📈', color: '#fbbf24' },
  { id: 'scienza', label: 'Scienza', emoji: '🧬', color: '#c084fc' }
];
const FEED = { topics: [], activeTopic: 'all', data: null, loading: false, error: null, more: false, moreTopic: null, moreError: null, sheet: null, card: null, chat: [], chatBusy: false, articleStream: null, articlePartial: null, pullInit: false, endObs: null, saved: null };

// ── DISCOVER FEED (Gemini) ────────────────────────────────
// (costanti e stato FEED dichiarati in testa allo script, sezione STATE)
function escFeed(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function feedKey() { try { return (localStorage.getItem(FEED_KEY_LS) || '').trim(); } catch (e) { return ''; } }
function feedModel() {
  let m = '';
  try { m = (localStorage.getItem(GEMINI_MODEL_LS) || '').trim(); } catch (e) { }
  return GEMINI_MODEL_RE.test(m) ? m : GEMINI_DEFAULT_MODEL;
}
// URL costruito al momento della richiesta (il modello può cambiare dalle impostazioni)
function geminiUrl(stream) {
  return GEMINI_API + 'models/' + encodeURIComponent(feedModel()) + (stream ? ':streamGenerateContent?alt=sse' : ':generateContent');
}
// thinkingConfig compatibile col modello: 2.5 flash/flash-lite → thinking spento;
// gemini-3* → thinkingLevel low; pro/sconosciuti → campo omesso (il thinking non si può spegnere).
function geminiThinkingConfig(model = feedModel()) {
  const m = String(model).toLowerCase();
  if (/^gemini-2\.5-flash(-lite)?(-|$)/.test(m)) return { thinkingBudget: 0 };
  if (m.startsWith('gemini-3')) return { thinkingLevel: 'low' };
  return undefined;
}
function feedCacheKey(ds) { return 'dayflow_feed_' + (ds || todayStr()); }
function normalizeTopic(t, i) {
  const label = String(t.label || '').trim().slice(0, 24);
  return { id: String(t.id || label.toLowerCase().replace(/[^a-z0-9]+/g, '-') || uid()), label, emoji: String(t.emoji || '✦').trim().slice(0, 4) || '✦', color: t.color || FEED_PALETTE[(i || 0) % FEED_PALETTE.length] };
}
function loadFeedTopics() {
  let t = null;
  try { t = JSON.parse(localStorage.getItem(FEED_TOPICS_LS) || 'null'); } catch (e) { }
  FEED.topics = (Array.isArray(t) && t.length ? t : FEED_DEFAULT_TOPICS).map(normalizeTopic);
}
function saveFeedTopics() {
  try { localStorage.setItem(FEED_TOPICS_LS, JSON.stringify(FEED.topics)); } catch (e) { }
  sbSaveFeedTopics();
}
function feedTopic(id) { return FEED.topics.find(t => t.id === id) || { id, label: id, emoji: '✦', color: '#8b8cf8' }; }
function loadFeedCache() {
  const key = feedCacheKey();
  try {
    // pulizia cache dei giorni precedenti
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('dayflow_feed_') && k !== key) localStorage.removeItem(k);
    }
    const raw = localStorage.getItem(key);
    const d = raw ? JSON.parse(raw) : null;
    FEED.data = d && Array.isArray(d.cards) && d.cards.length ? d : null;
  } catch (e) { FEED.data = null; }
}
function saveFeedCache() { try { if (FEED.data) localStorage.setItem(feedCacheKey(), JSON.stringify(FEED.data)); else localStorage.removeItem(feedCacheKey()); } catch (e) { } }
// ── Memoria notizie già viste (24h) ──
function loadFeedSeen() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem(FEED_SEEN_LS) || '[]'); } catch (e) { }
  const cutoff = Date.now() - FEED_SEEN_TTL;
  return (Array.isArray(list) ? list : []).filter(x => x && x.t && x.ts > cutoff);
}
function saveFeedSeen(list) { try { localStorage.setItem(FEED_SEEN_LS, JSON.stringify(list)); } catch (e) { } }
function addFeedSeen(cards) {
  const now = Date.now();
  const list = loadFeedSeen();
  const known = new Set(list.map(x => x.t.toLowerCase()));
  cards.forEach(c => { const t = c.title.trim(); if (t && !known.has(t.toLowerCase())) { list.push({ t, ts: now, topicId: c.topicId }); known.add(t.toLowerCase()); } });
  saveFeedSeen(list.slice(-300));
}
function clearFeedSeen() {
  try { localStorage.removeItem(FEED_SEEN_LS); } catch (e) { }
  showToast('Cronologia svuotata', 'info');
  refreshFeedSettings();
}

// ── Salvati per dopo ──
function loadFeedSaved() {
  if (FEED.saved) return FEED.saved;
  let l = [];
  try { l = JSON.parse(localStorage.getItem(FEED_SAVED_LS) || '[]'); } catch (e) { }
  FEED.saved = (Array.isArray(l) ? l : []).filter(c => c && c.id && c.title);
  return FEED.saved;
}
function persistFeedSaved() { try { localStorage.setItem(FEED_SAVED_LS, JSON.stringify(loadFeedSaved().slice(-100))); } catch (e) { } }
function isFeedSaved(id) { return loadFeedSaved().some(c => c.id === id); }
function toggleFeedSaved(id) {
  const list = loadFeedSaved();
  const idx = list.findIndex(c => c.id === id);
  if (idx >= 0) {
    list.splice(idx, 1);
    showToast('Rimossa dai salvati', 'info', 1800);
  } else {
    const card = feedCardById(id); if (!card) return;
    list.push(Object.assign({}, card, { savedAt: Date.now() }));
    showToast('Salvata per dopo', 'info', 1800);
  }
  persistFeedSaved();
  if (FEED.activeTopic === 'saved') { renderFeedChips(); renderFeed(); return; }
  document.querySelectorAll(`.feed-slide[data-id="${CSS.escape(id)}"] .feed-save`).forEach(b => b.classList.toggle('on', idx < 0));
  renderFeedChips();
}
function syncFeedSaved(card) {
  const list = loadFeedSaved();
  const i = list.findIndex(c => c.id === card.id);
  if (i >= 0) { list[i] = Object.assign({}, list[i], card); persistFeedSaved(); }
}

// ── Interessi impliciti (articoli aperti, chat) → personalizzazione feed ──
function loadFeedPrefs() {
  let l = [];
  try { l = JSON.parse(localStorage.getItem(FEED_PREFS_LS) || '[]'); } catch (e) { }
  const cutoff = Date.now() - FEED_PREFS_TTL;
  return (Array.isArray(l) ? l : []).filter(x => x && x.t && x.ts > cutoff);
}
function recordFeedPref(card, kind) {
  if (!card) return;
  const list = loadFeedPrefs().filter(x => x.t !== card.title);
  list.push({ t: card.title, topicId: card.topicId, kind, ts: Date.now() });
  try { localStorage.setItem(FEED_PREFS_LS, JSON.stringify(list.slice(-FEED_PREFS_MAX))); } catch (e) { }
}
function clearFeedPrefs() {
  try { localStorage.removeItem(FEED_PREFS_LS); } catch (e) { }
  showToast('Interessi azzerati', 'info');
  refreshFeedSettings();
}

// ── Condividi ──
async function shareFeedCard(id) {
  const c = feedCardById(id); if (!c) return;
  const text = `${c.title}\n\n${c.summary}\n\n${c.source} · via DayFlow Discover`;
  try {
    if (navigator.share) { await navigator.share({ title: c.title, text }); return; }
    await navigator.clipboard.writeText(text);
    showToast('Copiata negli appunti', 'info', 1800);
  } catch (e) { if (e && e.name !== 'AbortError') showToast('Condivisione non riuscita', 'error'); }
}
function feedRelTime(card) {
  const gen = card.genAt || (FEED.data ? FEED.data.generatedAt : Date.now());
  const mins = Math.max(1, Math.round((card.ageMinutes || 60) + (Date.now() - gen) / 60000));
  if (mins < 60) return mins + ' min fa';
  const h = Math.round(mins / 60);
  if (h < 24) return h + ' h fa';
  const g = Math.round(h / 24);
  return g === 1 ? 'ieri' : g + ' giorni fa';
}

// ── Gemini REST ──
async function geminiRequest(body) {
  const key = feedKey();
  if (!key) throw Object.assign(new Error('nokey'), { code: 'nokey' });
  let res;
  try {
    res = await fetch(geminiUrl(false),{ method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) });
  } catch (e) { throw Object.assign(new Error('network'), { code: 'network' }); }
  if (!res.ok) {
    const err = Object.assign(new Error('http ' + res.status), { code: 'http', status: res.status });
    try { const j = await res.json(); err.detail = j?.error?.message || ''; } catch (e) { }
    throw err;
  }
  const json = await res.json();
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const text = parts.map(p => p.text || '').join('').trim();
  if (!text) throw Object.assign(new Error('empty'), { code: 'empty', reason: json?.candidates?.[0]?.finishReason || json?.promptFeedback?.blockReason || '' });
  return text;
}
// Parser SSE incrementale: accetta chunk di testo arbitrari (anche spezzati a metà riga/evento)
// e chiama onData(payload) per ogni evento completo con righe "data:".
function createSSEParser(onData) {
  let buf = '', data = [];
  const dispatch = () => { if (data.length) { const d = data.join('\n'); data = []; onData(d); } };
  const line = l => {
    if (l.endsWith('\r')) l = l.slice(0, -1);
    if (l === '') { dispatch(); return; }
    if (l.startsWith(':')) return;
    if (l.startsWith('data:')) data.push(l.slice(5).replace(/^ /, ''));
  };
  return {
    push(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); line(l); }
    },
    end() { if (buf) { line(buf); buf = ''; } dispatch(); }
  };
}
// Streaming Gemini (SSE). onChunk(delta, fullText) a ogni frammento; ritorna il testo completo.
// opts.signal = AbortSignal; un abort lancia { code: 'abort' }.
async function geminiStream(body, onChunk, opts = {}) {
  const key = feedKey();
  if (!key) throw Object.assign(new Error('nokey'), { code: 'nokey' });
  const signal = opts.signal;
  const aborted = () => Object.assign(new Error('abort'), { code: 'abort' });
  let res;
  try {
    res = await fetch(geminiUrl(true),{ method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), signal });
  } catch (e) { throw signal && signal.aborted ? aborted() : Object.assign(new Error('network'), { code: 'network' }); }
  if (!res.ok) {
    const err = Object.assign(new Error('http ' + res.status), { code: 'http', status: res.status });
    try { const j = await res.json(); err.detail = j?.error?.message || ''; } catch (e) { }
    throw err;
  }
  if (!res.body || !res.body.getReader) throw Object.assign(new Error('network'), { code: 'network' });
  let full = '', finish = '', block = '', streamErr = null;
  const parser = createSSEParser(payload => {
    if (streamErr) return;
    let j; try { j = JSON.parse(payload); } catch (e) { return; }
    if (j.error) { streamErr = Object.assign(new Error('http ' + (j.error.code || '')), { code: 'http', status: j.error.code || 500, detail: j.error.message || '' }); return; }
    const cand = j.candidates && j.candidates[0];
    if (j.promptFeedback && j.promptFeedback.blockReason) block = j.promptFeedback.blockReason;
    if (cand && cand.finishReason) finish = cand.finishReason;
    const delta = ((cand && cand.content && cand.content.parts) || []).filter(p => !p.thought).map(p => p.text || '').join('');
    if (delta) { full += delta; onChunk(delta, full); }
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  try {
    for (; ;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(dec.decode(value, { stream: true }));
      if (streamErr) { try { reader.cancel(); } catch (e) { } throw streamErr; }
    }
    parser.push(dec.decode());
    parser.end();
  } catch (e) {
    if (signal && signal.aborted) throw aborted();
    if (e && e.code) throw e;
    throw Object.assign(new Error('network'), { code: 'network' });
  }
  if (streamErr) throw streamErr;
  if (signal && signal.aborted) throw aborted();
  if (full.trim() && !block && finish === 'MAX_TOKENS')
    throw Object.assign(new Error('truncated'), { code: 'truncated', partial: full }); // testo troncato: mai trattarlo come completo
  if (!full.trim() || block || (finish && finish !== 'STOP'))
    throw Object.assign(new Error('empty'), { code: 'empty', reason: block || finish, partial: full });
  if (!finish) throw Object.assign(new Error('network'), { code: 'network', partial: full }); // stream chiuso senza fine
  return full;
}
async function geminiJSON(prompt, schema, temperature = 0.9) {
  const text = await geminiRequest({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature } });
  const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(clean); } catch (e) { throw Object.assign(new Error('parse'), { code: 'parse' }); }
}
async function geminiText(contents, system) {
  return geminiRequest({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { temperature: 0.7 } });
}
function feedErrorMessage(e) {
  if (!e) return 'Errore sconosciuto.';
  if (e.code === 'nokey') return 'Nessuna chiave API configurata.';
  if (e.code === 'network') return navigator.onLine ? 'La rete non risponde. Riprova tra poco.' : 'Sei offline. Il feed torna quando sei connesso.';
  if (e.code === 'truncated') return 'Articolo interrotto.';
  if (e.code === 'parse' || e.code === 'empty') return 'Risposta dell\'AI non valida. Riprova.';
  if (e.code === 'http') {
    // Gemini risponde 400 INVALID_ARGUMENT anche per chiave errata: si distingue dal detail
    if (e.status === 401 || e.status === 403 || (e.status === 400 && /api[ _-]?key/i.test(e.detail || ''))) return 'Chiave API non valida o non autorizzata.';
    if (e.status === 400) return e.detail ? 'Richiesta rifiutata: ' + e.detail : 'Richiesta rifiutata dal modello ' + feedModel() + '. Prova un altro modello nelle impostazioni.';
    if (e.status === 404) return 'Modello ' + feedModel() + ' non disponibile per questa chiave. Cambia modello nelle impostazioni.';
    if (e.status === 429) return 'Quota Gemini esaurita. Riprova più tardi.';
    if (e.status >= 500) return 'Gemini è temporaneamente non disponibile.';
    return 'Errore ' + e.status + (e.detail ? ': ' + e.detail : '');
  }
  return 'Errore: ' + (e.message || e);
}

// ── Render ──
function renderDiscover() {
  const dEl = document.getElementById('disc-date');
  if (dEl) dEl.innerHTML = fmtHeaderDate(todayStr());
  if (!FEED.topics.length) loadFeedTopics();
  if (!FEED.data && !FEED.loading) loadFeedCache();
  if (!FEED.pullInit) initFeedPull();
  updateTopProgressBar(calcPct(todayStr()) || 0);
  renderFeedChips();
  renderFeed();
  if (feedKey() && !FEED.data && !FEED.loading && !FEED.error) generateFeed();
}

// ── Pull-to-refresh (touch) + rotella in cima (desktop) ──
function initFeedPull() {
  const f = document.getElementById('disc-feed'); const ptr = document.getElementById('disc-ptr');
  if (!f || !ptr) return;
  FEED.pullInit = true;
  const txt = document.getElementById('disc-ptr-txt');
  const st = { active: false, pulling: false, startY: 0, dist: 0, wheel: 0, wheelT: null };
  const canPull = () => !!FEED.data && !FEED.loading && !FEED.sheet && FEED.activeTopic !== 'saved' && f.scrollTop <= 0;
  const setPtr = (dist, label) => {
    const ready = dist >= FEED_PTR_THRESHOLD;
    ptr.style.transform = `translateY(${Math.min(dist, 96) - 56}px)`;
    ptr.style.opacity = dist > 8 ? '1' : '0';
    ptr.classList.toggle('ready', ready);
    if (txt) txt.textContent = label || (ready ? 'Rilascia per aggiornare' : 'Trascina per aggiornare');
  };
  const reset = () => {
    st.active = false; st.pulling = false; st.dist = 0;
    f.classList.remove('pulling'); f.style.transform = '';
    ptr.classList.remove('ready', 'busy');
    ptr.style.transform = ''; ptr.style.opacity = '';
  };
  const fire = () => {
    ptr.classList.add('busy'); ptr.classList.remove('ready');
    setPtr(FEED_PTR_THRESHOLD, 'Aggiornamento…');
    f.classList.remove('pulling'); f.style.transform = '';
    setTimeout(() => { reset(); regenerateFeed(); }, 150);
  };
  f.addEventListener('touchstart', e => {
    if (!canPull() || e.touches.length !== 1) return;
    st.active = true; st.startY = e.touches[0].clientY; st.dist = 0;
  }, { passive: true });
  f.addEventListener('touchmove', e => {
    if (!st.active) return;
    const dy = e.touches[0].clientY - st.startY;
    if (dy <= 0 || f.scrollTop > 0) { if (st.pulling) reset(); return; }
    st.pulling = true;
    st.dist = Math.min(120, dy * 0.55);
    f.classList.add('pulling');
    f.style.transform = `translateY(${Math.min(st.dist, 96) * 0.6}px)`;
    setPtr(st.dist);
    e.preventDefault();
  }, { passive: false });
  const end = () => { if (!st.active) return; if (st.pulling && st.dist >= FEED_PTR_THRESHOLD) fire(); else reset(); };
  f.addEventListener('touchend', end, { passive: true });
  f.addEventListener('touchcancel', reset, { passive: true });
  // desktop: rotella verso l'alto quando sei già in cima
  f.addEventListener('wheel', e => {
    if (e.deltaY >= 0 || !canPull()) { if (st.wheel) { st.wheel = 0; reset(); } return; }
    st.wheel = Math.min(140, st.wheel + Math.abs(e.deltaY) * 0.35);
    setPtr(st.wheel);
    clearTimeout(st.wheelT);
    if (st.wheel >= FEED_PTR_THRESHOLD) { st.wheel = 0; fire(); return; }
    st.wheelT = setTimeout(() => { st.wheel = 0; reset(); }, 500);
  }, { passive: true });
}
function renderFeedChips() {
  const c = document.getElementById('disc-chips'); if (!c) return;
  const chip = (id, emoji, label) => `<button class="chip${FEED.activeTopic === id ? ' on' : ''}" onclick="setFeedTopic('${escFeed(id)}')">${emoji ? `<span>${escFeed(emoji)}</span>` : ''}${escFeed(label)}</button>`;
  const nSaved = loadFeedSaved().length;
  c.innerHTML = chip('all', '', 'Tutti') + FEED.topics.map(t => chip(t.id, t.emoji, t.label)).join('') + chip('saved', '🔖', nSaved ? `Salvati (${nSaved})` : 'Salvati') + `<button class="chip add" onclick="openFeedSheet('topics')" aria-label="Gestisci argomenti">＋ argomenti</button>`;
}
function setFeedTopic(id) {
  FEED.activeTopic = id;
  renderFeedChips(); renderFeed();
  const f = document.getElementById('disc-feed'); if (f) f.scrollTo({ top: 0, behavior: 'instant' });
}
function setFeedStatus(status, msg) { setSS('sd-recap', 'st-recap-sync', status, msg); }
function renderFeed() {
  const f = document.getElementById('disc-feed'); if (!f) return;
  if (FEED.endObs) { FEED.endObs.disconnect(); FEED.endObs = null; }
  const stale = document.getElementById('disc-stale');
  const regen = document.getElementById('disc-regen');
  if (regen) regen.disabled = FEED.loading;
  const key = feedKey();
  if (stale) stale.innerHTML = (FEED.data && FEED.data.stale && !FEED.loading) ? `<div class="feed-stale"><span>Argomenti cambiati</span><button onclick="regenerateFeed()">↻ Rigenera</button></div>` : '';

  if (!key) {
    setFeedStatus('offline', 'chiave api mancante');
    f.innerHTML = `
      <div class="feed-slide"><div class="feed-card feed-state">
        <div class="feed-state-icon"><svg viewBox="0 0 24 24"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg></div>
        <h3>Collega Gemini</h3>
        <p>Discover genera ogni giorno un feed di notizie e fatti sui tuoi argomenti. Serve una chiave API di Google Gemini: resta solo su questo dispositivo.</p>
        <div class="feed-form">
          <div class="feed-key-wrap">
            <input class="form-input" id="disc-key-input" type="password" placeholder="AIza…" autocomplete="off" spellcheck="false" onkeydown="if(event.key==='Enter') saveFeedKey()">
            <button class="feed-eye" type="button" onclick="toggleFeedKeyVis('disc-key-input')" aria-label="Mostra chiave"><svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
          </div>
          <button class="feed-btn pri" onclick="saveFeedKey()">Salva e genera il feed</button>
          <a class="feed-link" href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer">Ottieni una chiave su Google AI Studio →</a>
        </div>
      </div></div>`;
    return;
  }
  if (FEED.loading) {
    setFeedStatus('syncing', 'generazione feed…');
    f.innerHTML = `
      <div class="feed-slide"><div class="feed-card">
        <div class="sk-line w40"></div>
        <div class="sk-line tall w90"></div>
        <div class="sk-line tall w70"></div>
        <div style="flex:1;display:flex;flex-direction:column;gap:10px;margin-top:8px"><div class="sk-line w90"></div><div class="sk-line w90"></div><div class="sk-line w70"></div></div>
        <div class="feed-meta"><div class="feed-spinner"></div><span>Gemini sta preparando il tuo feed…</span></div>
      </div></div>`;
    return;
  }
  if (FEED.error && !FEED.data) {
    setFeedStatus('err', 'errore feed');
    f.innerHTML = `
      <div class="feed-slide"><div class="feed-card feed-state">
        <div class="feed-state-icon" style="color:var(--red);background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.3)"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
        <h3>Feed non disponibile</h3>
        <p>${escFeed(FEED.error)}</p>
        <div class="feed-actions">
          <button class="feed-btn pri" onclick="generateFeed(true)">↻ Riprova</button>
          <button class="feed-btn sec" onclick="openFeedSheet('settings')">Cambia chiave</button>
        </div>
      </div></div>`;
    return;
  }
  if (FEED.activeTopic === 'saved') {
    const saved = loadFeedSaved().slice().reverse();
    setFeedStatus('ok', saved.length + ' salvat' + (saved.length === 1 ? 'a' : 'e'));
    if (!saved.length) {
      f.innerHTML = `<div class="feed-slide"><div class="feed-card feed-state"><div class="feed-state-icon"><svg viewBox="0 0 24 24"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg></div><h3>Nessuna notizia salvata</h3><p>Tocca il segnalibro su una card per ritrovarla qui, anche nei giorni successivi.</p><div class="feed-actions"><button class="feed-btn sec" onclick="setFeedTopic('all')">Torna al feed</button></div></div></div>`;
      return;
    }
    f.innerHTML = saved.map((c, i) => feedCardHTML(c, i)).join('');
    renumberFeed();
    return;
  }
  if (!FEED.data) { f.innerHTML = ''; return; }

  setFeedStatus('ok', 'feed di oggi · ' + new Date(FEED.data.generatedAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }));
  const cards = feedVisibleCards();
  // Nessuna card per il filtro: mostro direttamente la slide di caricamento (è #disc-end,
  // quindi l'observer/prefetch parte da solo). Con moreError resta lo stato errore + Riprova.
  f.innerHTML = cards.map((c, i) => feedCardHTML(c, i)).join('') + feedEndHTML();
  renumberFeed();
  attachFeedEndObserver();
}
// Card del feed coerenti con il filtro attivo (chip 'saved' escluso: non usa FEED.data).
function feedVisibleCards(topicId = FEED.activeTopic) {
  if (!FEED.data || topicId === 'saved') return [];
  return FEED.data.cards.filter(c => topicId === 'all' || c.topicId === topicId);
}
function feedCardHTML(c, i) {
  const t = feedTopic(c.topicId);
  return `
      <article class="feed-slide card" data-id="${escFeed(c.id)}"><div class="feed-card" style="--tc:${escFeed(t.color)};animation-delay:${Math.min(i, 3) * 40}ms">
        <div class="feed-badge"><span>${escFeed(t.emoji)}</span>${escFeed(t.label)}</div>
        <h2 class="feed-title">${escFeed(c.title)}</h2>
        <p class="feed-summary">${escFeed(c.summary)}</p>
        <div class="feed-meta"><span>${escFeed(c.source)}</span><span class="feed-meta-dot"></span><span>${escFeed(feedRelTime(c))}</span><span class="feed-meta-dot"></span><span class="feed-idx"></span></div>
        <div class="feed-actions">
          <button class="feed-btn pri" onclick="expandArticle('${escFeed(c.id)}')">📖 Leggi</button>
          <button class="feed-btn sec" onclick="openFeedChat('${escFeed(c.id)}')">💬 Chiedi</button>
          <button class="feed-btn ico feed-save${isFeedSaved(c.id) ? ' on' : ''}" onclick="toggleFeedSaved('${escFeed(c.id)}')" aria-label="Salva per dopo" title="Salva per dopo"><svg viewBox="0 0 24 24"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg></button>
          <button class="feed-btn ico" onclick="shareFeedCard('${escFeed(c.id)}')" aria-label="Condividi" title="Condividi"><svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg></button>
        </div>
      </div></article>`;
}
function feedEndHTML() {
  return `<div class="feed-slide" id="disc-end"><div class="feed-card feed-state">${feedEndInner()}</div></div>`;
}
function feedEndInner() {
  if (FEED.moreError) return `
        <div class="feed-state-icon" style="color:var(--red);background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.3)"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
        <h3>Non riesco a caricare altro</h3>
        <p>${escFeed(FEED.moreError)}</p>
        <div class="feed-actions"><button class="feed-btn pri" onclick="loadMoreFeed(true)">↻ Riprova</button></div>`;
  const empty = !feedVisibleCards().length && FEED.activeTopic !== 'all';
  const t = feedTopic(FEED.activeTopic);
  return `
        <div class="feed-state-icon"><div class="feed-spinner"></div></div>
        <h3>${empty ? 'Cerco notizie su ' + escFeed(t.label) + '…' : 'Altre notizie in arrivo…'}</h3>
        <p>${empty ? 'Niente qui nel feed di oggi: Gemini sta generando qualcosa su questo argomento.' : 'Gemini sta cercando qualcosa che non hai ancora visto.'}</p>
        <div class="feed-disclaimer">Contenuti generati dall'AI · possono contenere imprecisioni</div>`;
}
function renumberFeed() {
  const f = document.getElementById('disc-feed'); if (!f) return;
  const slides = f.querySelectorAll('.feed-slide.card');
  slides.forEach((s, i) => { const el = s.querySelector('.feed-idx'); if (el) el.textContent = (i + 1) + '/' + slides.length; });
}
function attachFeedEndObserver() {
  const f = document.getElementById('disc-feed'); const end = document.getElementById('disc-end');
  if (FEED.endObs) { FEED.endObs.disconnect(); FEED.endObs = null; }
  if (!f || !end || !('IntersectionObserver' in window)) return;
  FEED.endObs = new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting) && !FEED.moreError) loadMoreFeed();
  }, { root: f, threshold: 0.5 });
  FEED.endObs.observe(end);
  // Prefetch: osservo le ultime FEED_PREFETCH_AHEAD card (non solo l'ultima), così il batch
  // successivo parte quando davanti all'utente restano poche card. Osservo tutte quelle nel
  // range perché uno scroll rapido può saltare una card senza farla intersecare.
  const cards = [...f.querySelectorAll('.feed-slide.card')];
  cards.slice(Math.max(0, cards.length - FEED_PREFETCH_AHEAD)).forEach(c => FEED.endObs.observe(c));
  // Poche card visibili (filtro appena aperto/cambiato): parto subito, senza aspettare l'observer.
  if (cards.length <= FEED_PREFETCH_AHEAD && !FEED.moreError) loadMoreFeed();
}
function toggleFeedKeyVis(id) { const i = document.getElementById(id); if (i) i.type = i.type === 'password' ? 'text' : 'password'; }
function saveFeedKey(inputId = 'disc-key-input') {
  const i = document.getElementById(inputId); const v = (i ? i.value : '').trim();
  if (!v || v.length < 20) { showToast('Chiave API non valida', 'error'); return; }
  try { localStorage.setItem(FEED_KEY_LS, v); } catch (e) { showToast('Impossibile salvare la chiave', 'error'); return; }
  FEED.error = null;
  showToast('Chiave salvata', 'info');
  if (FEED.sheet) closeFeedSheet();
  refreshFeedSettings();
  // dalle Impostazioni si può essere su un'altra schermata: il feed si genera quando si apre Discover
  if (curScreen === 'recap') renderDiscover();
}
function removeFeedKey() {
  try { localStorage.removeItem(FEED_KEY_LS); } catch (e) { }
  FEED.error = null;
  if (FEED.sheet) closeFeedSheet();
  refreshFeedSettings();
  if (curScreen === 'recap') renderDiscover();
}

// ── Generazione ──
async function generateFeed(force = false) {
  if (!feedKey()) { renderFeed(); return; }
  if (FEED.loading) return;
  if (!FEED.topics.length) loadFeedTopics();
  const topics = FEED.topics;
  FEED.loading = true; FEED.error = null;
  if (force) FEED.data = null;
  FEED.moreError = null;
  renderFeed();
  try {
    const cards = await fetchFeedCards(topics, FEED_CARDS_N);
    FEED.data = { generatedAt: Date.now(), topicIds: topics.map(t => t.id), cards, stale: false };
    saveFeedCache();
    if (FEED.activeTopic !== 'all' && !topics.some(t => t.id === FEED.activeTopic)) FEED.activeTopic = 'all';
  } catch (e) {
    console.error('generateFeed', e);
    FEED.error = feedErrorMessage(e);
    if (FEED.data) showToast(FEED.error, 'error');
  }
  FEED.loading = false;
  renderFeedChips();
  renderFeed();
  const f = document.getElementById('disc-feed'); if (f) f.scrollTo({ top: 0, behavior: 'instant' });
}
// Chiede a Gemini n card sui topic indicati, escludendo i titoli già visti nelle ultime 24h.
async function fetchFeedCards(topics, n) {
  const today = new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const topicList = topics.map(t => `- id "${t.id}" → ${t.label}`).join('\n');
  const seen = loadFeedSeen().slice(-FEED_SEEN_MAX);
  const seenBlock = seen.length
    ? `\n\nNOTIZIE GIÀ MOSTRATE ALL'UTENTE (non riproporle, nemmeno riformulate o con un angolo diverso sullo stesso fatto; cerca fatti, protagonisti e sottotemi DIVERSI):\n${seen.map(s => '- ' + s.t).join('\n')}`
    : '';
  const prefs = loadFeedPrefs().filter(p => topics.some(t => t.id === p.topicId)).slice(-15);
  const prefBlock = prefs.length
    ? `\n\nINTERESSI DELL'UTENTE (notizie che ha aperto o su cui ha fatto domande di recente; privilegia sottotemi affini, senza ripetere questi fatti):\n${prefs.map(p => `- ${p.t} [${feedTopic(p.topicId).label}]`).join('\n')}`
    : '';
  const distrib = topics.length > 1 ? 'distribuiti in modo equilibrato tra questi argomenti' : 'tutti su questo argomento';
  const prompt = `Oggi è ${today}. Genera un feed di ${n} notizie e fatti interessanti, recenti e verosimili, scritti in italiano, ${distrib}:\n${topicList}\n\nRegole per ogni voce:\n- "topicId": esattamente uno degli id elencati.\n- "title": titolo d'impatto, massimo 12 parole, niente clickbait né punti esclamativi.\n- "summary": 2-3 frasi chiare e concrete che spiegano cosa è successo e perché conta.\n- "source": nome di una testata o fonte plausibile per quell'argomento (es. una testata italiana o internazionale, un'agenzia, una rivista scientifica).\n- "ageMinutes": minuti trascorsi dalla pubblicazione, tra 20 e 1440.\nVaria toni e sottotemi, evita ripetizioni e non inventare dichiarazioni virgolettate di persone reali.${prefBlock}${seenBlock}`;
  const schema = { type: 'ARRAY', items: { type: 'OBJECT', properties: { topicId: { type: 'STRING' }, title: { type: 'STRING' }, summary: { type: 'STRING' }, source: { type: 'STRING' }, ageMinutes: { type: 'INTEGER' } }, required: ['topicId', 'title', 'summary', 'source', 'ageMinutes'] } };
  const out = await geminiJSON(prompt, schema, 1.0);
  const seenSet = new Set(seen.map(s => s.t.toLowerCase()));
  const inFeed = new Set((FEED.data ? FEED.data.cards : []).map(c => c.title.toLowerCase()));
  const now = Date.now();
  const cards = (Array.isArray(out) ? out : []).filter(c => c && c.title).map(c => ({
    id: uid(),
    genAt: now,
    topicId: topics.some(t => t.id === c.topicId) ? c.topicId : topics[0].id,
    title: String(c.title).trim(),
    summary: String(c.summary || '').trim(),
    source: String(c.source || 'Fonte').trim(),
    ageMinutes: Math.min(1440, Math.max(5, parseInt(c.ageMinutes) || 60))
  })).filter(c => !seenSet.has(c.title.toLowerCase()) && !inFeed.has(c.title.toLowerCase()));
  if (!cards.length) throw Object.assign(new Error('empty'), { code: 'empty' });
  addFeedSeen(cards);
  return cards;
}
// Scroll infinito: accoda nuove card in fondo senza toccare lo scroll corrente.
async function loadMoreFeed(retry = false) {
  if (FEED.more || FEED.loading || !FEED.data || !feedKey()) return;
  if (FEED.moreError && !retry) return;
  if (FEED.activeTopic === 'saved') return;
  const topicId = FEED.activeTopic;
  const topics = topicId === 'all' ? FEED.topics : [feedTopic(topicId)];
  const data = FEED.data;
  FEED.more = true; FEED.moreTopic = topicId; FEED.moreError = null;
  let end = document.getElementById('disc-end');
  if (end) end.querySelector('.feed-card').innerHTML = feedEndInner();
  else if (curScreen === 'recap') renderFeed();
  let cards = null, err = null;
  try { cards = await fetchFeedCards(topics, FEED_CARDS_N); } catch (e) { err = e; }
  FEED.more = false; FEED.moreTopic = null;
  // Nel frattempo il feed è stato rigenerato (pull-to-refresh): le card appartengono al vecchio feed.
  if (FEED.data !== data || FEED.loading) return;
  if (err) {
    console.error('loadMoreFeed', err);
    FEED.moreError = feedErrorMessage(err);
    end = document.getElementById('disc-end');
    if (end) end.querySelector('.feed-card').innerHTML = feedEndInner();
    else if (curScreen === 'recap' && FEED.activeTopic !== 'saved') renderFeed();
    return;
  }
  FEED.data.cards.push(...cards);
  saveFeedCache();
  appendFeedCards(cards);
}
// Accoda al DOM le card appena generate, ma solo quelle coerenti con il filtro ATTUALE
// (l'utente può aver cambiato chip durante la generazione). Poi riaggancia l'observer,
// che fa ripartire un nuovo load se per il filtro attuale restano poche card.
function appendFeedCards(cards) {
  if (curScreen !== 'recap' || FEED.activeTopic === 'saved') return;
  const f = document.getElementById('disc-feed');
  const end = document.getElementById('disc-end');
  if (!f || !end) { renderFeed(); return; }
  const shown = cards.filter(c => FEED.activeTopic === 'all' || c.topicId === FEED.activeTopic);
  if (!shown.length) {
    // Nessuna card per questo filtro: la slide di fine resta, l'observer rilancia il load.
    end.querySelector('.feed-card').innerHTML = feedEndInner();
    attachFeedEndObserver();
    return;
  }
  const tpl = document.createElement('template');
  tpl.innerHTML = shown.map((c, i) => feedCardHTML(c, i)).join('') + feedEndHTML();
  const nodes = [...tpl.content.children];
  // La slide "fine" è quella agganciata dallo snap: la trasformo in-place nella prima
  // nuova card (Chrome mantiene in vista l'elemento snappato anche dopo modifiche al DOM),
  // poi accodo le altre card e una nuova slide "fine".
  const first = nodes.shift();
  const wasOnEnd = Math.abs(f.scrollTop - end.offsetTop) < 4;
  end.removeAttribute('id');
  end.className = first.className;
  end.dataset.id = first.dataset.id;
  end.innerHTML = first.innerHTML;
  end.after(...nodes);
  if (wasOnEnd && Math.abs(f.scrollTop - end.offsetTop) > 2) f.scrollTo({ top: end.offsetTop, behavior: 'instant' });
  renumberFeed();
  attachFeedEndObserver();
}
function regenerateFeed() {
  if (FEED.loading) return;
  if (!feedKey()) { openFeedSheet('settings'); return; }
  generateFeed(true);
}

// ── Bottom sheet ──
function openFeedSheet(mode, card) {
  // Le impostazioni Discover vivono nel pannello Impostazioni globale (sezione Discover)
  if (mode === 'settings') { if (FEED.sheet) closeFeedSheet(); openSettings('discover'); return; }
  FEED.sheet = mode;
  if (card) FEED.card = card;
  const ov = document.getElementById('feed-sheet');
  const tabs = document.getElementById('fsheet-tabs');
  const foot = document.getElementById('fsheet-foot');
  const title = document.getElementById('fsheet-title');
  const isCard = mode === 'article' || mode === 'chat';
  if (FEED.articleStream && (!isCard || !FEED.card || FEED.card.id !== FEED.articleStream.id)) abortArticleStream();
  tabs.style.display = isCard ? 'flex' : 'none';
  document.getElementById('fsheet-tab-article').classList.toggle('on', mode === 'article');
  document.getElementById('fsheet-tab-chat').classList.toggle('on', mode === 'chat');
  foot.classList.toggle('on', mode === 'chat');
  title.textContent = isCard ? (feedTopic(FEED.card.topicId).emoji + ' ' + feedTopic(FEED.card.topicId).label) : mode === 'topics' ? 'Argomenti' : 'Impostazioni Discover';
  ov.classList.add('open');
  renderFeedSheet();
}
function switchFeedSheet(mode) { openFeedSheet(mode); }
function closeFeedSheet() { abortArticleStream(); FEED.sheet = null; document.getElementById('feed-sheet').classList.remove('open'); }
function feedSheetOverlayClick(e) { if (e.target === document.getElementById('feed-sheet')) closeFeedSheet(); }
function renderFeedSheet() {
  const b = document.getElementById('fsheet-body'); if (!b) return;
  if (FEED.sheet === 'article') renderFeedArticle(b);
  else if (FEED.sheet === 'chat') renderFeedChatLog(b);
  else if (FEED.sheet === 'topics') renderFeedTopicsSheet(b);
}
function feedCardById(id) { return (FEED.data && FEED.data.cards.find(c => c.id === id)) || loadFeedSaved().find(c => c.id === id) || null; }

// Articolo esteso
async function expandArticle(id) {
  const card = feedCardById(id); if (!card) return;
  if (FEED.card && FEED.card.id !== id) FEED.chat = [];
  recordFeedPref(card, 'article');
  openFeedSheet('article', card);
  if (card.fullArticle || FEED.articleStream) return;
  streamArticle(card);
}
// Formato testo dell'articolo (parsabile a pezzi):
//   riga 1 = titolo · riga vuota · "## Sottotitolo" · paragrafi separati da riga vuota.
// parseArticleText(text, final) → { title, blocks: [{ tag: 'h3'|'p', text }] }.
// Se !final l'ultima riga incompleta è inclusa nell'ultimo blocco (titolo solo a riga chiusa).
function parseArticleText(text, final) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const complete = final ? lines.length : lines.length - 1;
  const clean = s => s.replace(/\*\*|__/g, '').trim();
  let title = '', titleDone = false, para = null;
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!titleDone) {
      if (!line) continue;
      if (i >= complete) break;
      title = clean(line.replace(/^#+\s*/, '').replace(/^titolo\s*:\s*/i, ''));
      titleDone = true; continue;
    }
    if (!line) { para = null; continue; }
    if (/^#{1,6}(\s|$)/.test(line)) { para = null; blocks.push({ tag: 'h3', text: clean(line.replace(/^#+\s*/, '')) }); continue; }
    const t = clean(line);
    if (para) para.text += ' ' + t;
    else { para = { tag: 'p', text: t }; blocks.push(para); }
  }
  return { title, blocks };
}
function articleFromBlocks(title, blocks) {
  const sections = [];
  let cur = null;
  blocks.forEach(b => {
    if (b.tag === 'h3') { if (b.text) { cur = { heading: b.text, paragraphs: [] }; sections.push(cur); } }
    else if (b.text) { if (!cur) { cur = { heading: '', paragraphs: [] }; sections.push(cur); } cur.paragraphs.push(b.text); }
  });
  return { title, sections: sections.filter(s => s.paragraphs.length || s.heading) };
}
function abortArticleStream() {
  const st = FEED.articleStream; if (!st) return;
  FEED.articleStream = null;
  if (st.raf) cancelAnimationFrame(st.raf);
  try { st.ctrl.abort(); } catch (e) { }
}
async function streamArticle(card) {
  delete card.articleError;
  FEED.articlePartial = null;
  const st = { id: card.id, ctrl: new AbortController(), text: '', raf: 0, els: [] };
  FEED.articleStream = st;
  if (FEED.sheet === 'article' && FEED.card && FEED.card.id === card.id) renderFeedSheet();
  const prompt = `Scrivi in italiano un articolo di approfondimento (400-600 parole) a partire da questa notizia.\nTitolo: ${card.title}\nRiassunto: ${card.summary}\nFonte: ${card.source}\nArgomento: ${feedTopic(card.topicId).label}\n\nTono giornalistico, chiaro, senza retorica. Contestualizza, spiega le implicazioni e chiudi con cosa aspettarsi. Non inventare citazioni virgolettate attribuite a persone reali.\n\nFORMATO DI OUTPUT (testo semplice, niente JSON, niente elenchi puntati, niente grassetti):\n- Prima riga: solo il titolo dell'articolo.\n- Poi una riga vuota.\n- 3-4 sezioni: ogni sezione inizia con una riga "## Sottotitolo breve", seguita da 1-3 paragrafi.\n- Separa ogni paragrafo e ogni sottotitolo con una riga vuota.`;
  // 400-600 parole ≈ 800-1100 token: 3072 basta a thinking spento; con thinking attivo (pro, gemini-3,
  // sconosciuti) i token di ragionamento contano in maxOutputTokens → margine più alto.
  const thinking = geminiThinkingConfig();
  const generationConfig = { temperature: 0.7, maxOutputTokens: thinking && thinking.thinkingBudget === 0 ? 3072 : 8192 };
  if (thinking) generationConfig.thinkingConfig = thinking;
  const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig };
  try {
    const full = await geminiStream(body, (d, all) => {
      if (FEED.articleStream !== st) return;
      st.text = all;
      if (!st.raf) st.raf = requestAnimationFrame(() => paintArticleStream(st, false));
    }, { signal: st.ctrl.signal });
    if (FEED.articleStream !== st) return;
    const parsed = parseArticleText(full, true);
    const art = articleFromBlocks(parsed.title || card.title, parsed.blocks);
    if (!art.sections.some(s => s.paragraphs.length)) throw Object.assign(new Error('empty'), { code: 'empty' });
    st.text = full;
    if (st.raf) { cancelAnimationFrame(st.raf); st.raf = 0; }
    paintArticleStream(st, true);
    FEED.articleStream = null;
    card.fullArticle = art; // resta visibile anche se il feed è stato rigenerato nel frattempo
    // Il feed può essere stato sostituito durante lo stream: ricerca per id prima di salvare
    const inFeed = FEED.data && FEED.data.cards.find(c => c.id === card.id);
    if (inFeed) { inFeed.fullArticle = art; saveFeedCache(); }
    syncFeedSaved(card); // aggiorna i salvati solo se la card è salvata
    // Nessun re-render completo: il DOM è già allineato, si aggiunge solo il disclaimer
    const root = articleStreamRoot(st.id);
    if (root) {
      const s = root.querySelector('.art-status'); if (s) s.remove();
      const disc = document.createElement('div'); disc.className = 'feed-disclaimer';
      disc.textContent = "Articolo generato dall'AI · può contenere imprecisioni";
      root.appendChild(disc);
      root.removeAttribute('id');
    }
  } catch (e) {
    if (e.code === 'abort' || FEED.articleStream !== st) return;
    console.error('expandArticle', e);
    if (st.raf) { cancelAnimationFrame(st.raf); st.raf = 0; }
    FEED.articleStream = null;
    card.articleError = feedErrorMessage(e);
    FEED.articlePartial = st.text.trim() ? { id: card.id, text: st.text } : null;
    if (FEED.sheet === 'article' && FEED.card && FEED.card.id === card.id) {
      const b = document.getElementById('fsheet-body');
      const top = b ? b.scrollTop : 0;
      renderFeedSheet();
      if (b) b.scrollTop = top;
    }
  }
}
function articleStreamRoot(id) {
  if (FEED.sheet !== 'article' || !FEED.card || FEED.card.id !== id) return null;
  const root = document.getElementById('fart');
  return root && root.dataset.id === id ? root : null;
}
// Aggiornamento incrementale del DOM (textContent, mai innerHTML): tocca solo blocchi nuovi o cambiati.
function paintArticleStream(st, final) {
  st.raf = 0;
  const root = articleStreamRoot(st.id); if (!root) return;
  const body = root.querySelector('.art-body'); if (!body) return;
  const { title, blocks } = parseArticleText(st.text, final);
  if (title) { const h = root.querySelector('h2'); if (h && h.textContent !== title) h.textContent = title; }
  const els = st.els;
  blocks.forEach((bl, i) => {
    let el = els[i];
    if (!el || el.tagName.toLowerCase() !== bl.tag) {
      const n = document.createElement(bl.tag);
      if (el) el.replaceWith(n); else body.appendChild(n);
      els[i] = el = n;
    }
    if (el.textContent !== bl.text) el.textContent = bl.text;
  });
  while (els.length > blocks.length) els.pop().remove();
  els.forEach((el, i) => el.classList.toggle('art-tail', !final && i === els.length - 1));
  root.classList.toggle('has-text', blocks.length > 0);
}
function renderFeedArticle(b) {
  const c = FEED.card; if (!c) { b.innerHTML = ''; return; }
  const t = feedTopic(c.topicId);
  const meta = `<div class="feed-meta"><span>${escFeed(c.source)}</span><span class="feed-meta-dot"></span><span>${escFeed(feedRelTime(c))}</span><span class="feed-meta-dot"></span><span>${escFeed(t.label)}</span></div>`;
  const head = `<h2>${escFeed(c.fullArticle ? c.fullArticle.title : c.title)}</h2>${meta}`;
  if (c.fullArticle) {
    b.innerHTML = `<div class="article">${head}${c.fullArticle.sections.map(s => `${s.heading ? `<h3>${escFeed(s.heading)}</h3>` : ''}${s.paragraphs.map(p => `<p>${escFeed(p)}</p>`).join('')}`).join('')}<div class="feed-disclaimer">Articolo generato dall'AI · può contenere imprecisioni</div></div>`;
    return;
  }
  const st = FEED.articleStream;
  if (st && st.id === c.id) {
    // Struttura statica; il testo arriva via paintArticleStream (render sincrono dello stato già ricevuto)
    b.innerHTML = `<div class="article" id="fart" data-id="${escFeed(c.id)}"><h2>${escFeed(c.title)}</h2>${meta}<div class="art-body"></div><div class="art-sk"><div class="sk-line w90"></div><div class="sk-line w90"></div><div class="sk-line w70"></div><div class="sk-line w40" style="margin-top:10px"></div><div class="sk-line w90"></div><div class="sk-line w70"></div></div><div class="feed-meta art-status"><div class="feed-spinner"></div><span>Gemini sta scrivendo…</span></div></div>`;
    st.els = [];
    paintArticleStream(st, false);
    return;
  }
  const partial = FEED.articlePartial && FEED.articlePartial.id === c.id ? parseArticleText(FEED.articlePartial.text, true) : null;
  const partialHtml = partial && partial.blocks.length ? partial.blocks.map(bl => `<${bl.tag}>${escFeed(bl.text)}</${bl.tag}>`).join('') : `<p>${escFeed(c.summary)}</p>`;
  const h2 = partial && partial.title ? partial.title : c.title;
  b.innerHTML = `<div class="article"><h2>${escFeed(h2)}</h2>${meta}${partialHtml}${c.articleError ? `<p style="color:var(--red)">${escFeed(c.articleError)}</p>` : ''}<div class="feed-actions"><button class="feed-btn pri" onclick="expandArticle('${escFeed(c.id)}')">↻ ${c.articleError ? 'Riprova' : "Genera l'articolo"}</button></div></div>`;
}

// Chat contestuale
function openFeedChat(id) {
  const card = feedCardById(id); if (!card) return;
  if (!FEED.card || FEED.card.id !== id) FEED.chat = [];
  recordFeedPref(card, 'chat');
  openFeedSheet('chat', card);
  setTimeout(() => { const i = document.getElementById('fsheet-input'); if (i) i.focus(); }, 350);
}
function renderFeedChatLog(b) {
  const c = FEED.card; if (!c) { b.innerHTML = ''; return; }
  const sugg = ['Spiegamelo in parole semplici', 'Perché è importante?', 'Quali sono le conseguenze?'];
  b.innerHTML = `<div class="chat-log">
    <div class="chat-ctx">Contesto: ${escFeed(c.title)}</div>
    ${FEED.chat.map(m => `<div class="chat-msg ${m.role}">${escFeed(m.text)}</div>`).join('')}
    ${FEED.chatBusy ? '<div class="chat-msg model typing"><i></i><i></i><i></i></div>' : ''}
    ${!FEED.chat.length && !FEED.chatBusy ? `<div class="chat-sugg">${sugg.map(s => `<button class="chip" onclick="sendFeedChat('${escFeed(s)}')">${escFeed(s)}</button>`).join('')}</div>` : ''}
  </div>`;
  b.scrollTop = b.scrollHeight;
  const send = document.getElementById('fsheet-send'); if (send) send.disabled = FEED.chatBusy;
}
async function sendFeedChat(preset) {
  const c = FEED.card; if (!c || FEED.chatBusy) return;
  const input = document.getElementById('fsheet-input');
  const text = (preset || (input ? input.value : '')).trim();
  if (!text) return;
  if (input) input.value = '';
  FEED.chat.push({ role: 'user', text });
  FEED.chatBusy = true;
  if (FEED.sheet === 'chat') renderFeedSheet();
  try {
    const article = c.fullArticle ? '\n\nArticolo esteso:\n' + c.fullArticle.sections.map(s => s.heading + '\n' + s.paragraphs.join('\n')).join('\n\n') : '';
    const system = `Sei l'assistente di DayFlow. Rispondi in italiano, in modo chiaro e conciso (massimo 120 parole), restando ancorato alla notizia seguente. Se non sai qualcosa, dillo. Non inventare citazioni di persone reali.\n\nNotizia: ${c.title}\nRiassunto: ${c.summary}\nFonte: ${c.source}\nArgomento: ${feedTopic(c.topicId).label}${article}`;
    const contents = FEED.chat.map(m => ({ role: m.role, parts: [{ text: m.text }] }));
    const reply = await geminiText(contents, system);
    FEED.chat.push({ role: 'model', text: reply });
  } catch (e) {
    console.error('sendFeedChat', e);
    FEED.chat.push({ role: 'model', text: '⚠ ' + feedErrorMessage(e) });
  }
  FEED.chatBusy = false;
  if (FEED.sheet === 'chat') renderFeedSheet();
}

// Argomenti
function renderFeedTopicsSheet(b) {
  b.innerHTML = `
    <div class="feed-hint" style="margin-bottom:14px">Il feed viene generato sugli argomenti attivi. Dopo una modifica, rigenera per aggiornarlo.</div>
    ${FEED.topics.map(t => `<div class="topic-row" style="--tc:${escFeed(t.color)}"><div class="t-emoji">${escFeed(t.emoji)}</div><div class="t-name">${escFeed(t.label)}</div><button class="topic-del" onclick="removeFeedTopic('${escFeed(t.id)}')" ${FEED.topics.length <= 1 ? 'disabled' : ''} aria-label="Rimuovi">×</button></div>`).join('')}
    <div class="topic-form">
      <input class="form-input emoji" id="topic-emoji" maxlength="4" placeholder="✦" aria-label="Emoji">
      <input class="form-input" id="topic-label" maxlength="24" placeholder="Nuovo argomento (es. Cinema)" onkeydown="if(event.key==='Enter') addFeedTopic()">
      <button class="btn-pri" onclick="addFeedTopic()">Aggiungi</button>
    </div>`;
}
function addFeedTopic() {
  const lbl = (document.getElementById('topic-label')?.value || '').trim();
  const emoji = (document.getElementById('topic-emoji')?.value || '').trim();
  if (!lbl) return;
  if (FEED.topics.length >= 10) { showToast('Massimo 10 argomenti', 'warn'); return; }
  let id = lbl.toLowerCase().replace(/[^a-z0-9àèéìòù]+/g, '-').replace(/^-|-$/g, '') || uid();
  if (FEED.topics.some(t => t.id === id)) id += '-' + Math.random().toString(36).slice(2, 5);
  const used = new Set(FEED.topics.map(t => t.color));
  const color = FEED_PALETTE.find(c => !used.has(c)) || FEED_PALETTE[FEED.topics.length % FEED_PALETTE.length];
  FEED.topics.push(normalizeTopic({ id, label: lbl, emoji: emoji || '✦', color }));
  afterFeedTopicsChange();
}
function removeFeedTopic(id) {
  if (FEED.topics.length <= 1) return;
  FEED.topics = FEED.topics.filter(t => t.id !== id);
  if (FEED.activeTopic === id) FEED.activeTopic = 'all';
  afterFeedTopicsChange();
}
function afterFeedTopicsChange() {
  saveFeedTopics();
  if (FEED.data) { FEED.data.stale = true; saveFeedCache(); }
  renderFeedChips(); renderFeed();
  if (FEED.sheet === 'topics') renderFeedSheet();
}

// Impostazioni Discover: markup unico, renderizzabile in qualsiasi contenitore.
// Oggi l'unico contenitore è #settings-discover-body (pannello Impostazioni globale);
// le azioni (chiave, modello, cache, cronologia, interessi) ri-renderizzano con refreshFeedSettings().
function renderFeedSettings(b) { if (b) b.innerHTML = feedSettingsHTML(); }
function refreshFeedSettings() { if (SETTINGS.open) renderFeedSettings(document.getElementById('settings-discover-body')); }
function feedSettingsHTML() {
  const key = feedKey();
  const masked = key ? key.slice(0, 6) + '••••••••' + key.slice(-4) : '';
  const seen = loadFeedSeen();
  const prefs = loadFeedPrefs();
  return `
    <div class="settings-row">
      <div class="settings-lbl">Chiave API Gemini</div>
      <div class="settings-val">${key ? escFeed(masked) : 'Nessuna chiave salvata'}</div>
      <div class="feed-key-wrap">
        <input class="form-input" id="settings-key-input" type="password" placeholder="${key ? 'Incolla una nuova chiave per sostituirla' : 'AIza…'}" autocomplete="off" spellcheck="false" onkeydown="if(event.key==='Enter') saveFeedKey('settings-key-input')">
        <button class="feed-eye" type="button" onclick="toggleFeedKeyVis('settings-key-input')" aria-label="Mostra chiave"><svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
      </div>
      <div class="form-btns" style="margin-top:10px">
        <button class="btn-pri" onclick="saveFeedKey('settings-key-input')">Salva chiave</button>
        ${key ? '<button class="btn-del" onclick="removeFeedKey()">Rimuovi</button>' : ''}
      </div>
      <div class="feed-hint" style="margin-top:10px">La chiave resta solo in questo browser (localStorage) e non viene mai inviata a DayFlow o Supabase. <a class="feed-link" href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer">Google AI Studio →</a></div>
    </div>
    <div class="settings-row">
      <div class="settings-lbl">Modello</div>
      ${renderFeedModelPicker(key)}
    </div>
    <div class="settings-row">
      <div class="settings-lbl">Cache</div>
      <div class="settings-val">${FEED.data ? `Feed di oggi generato alle ${new Date(FEED.data.generatedAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })} · ${FEED.data.cards.length} card` : 'Nessun feed in cache'}</div>
      <div class="form-btns" style="margin-top:0">
        <button class="btn-sec" onclick="clearFeedCache()" ${FEED.data ? '' : 'disabled'}>Svuota cache di oggi</button>
        <button class="btn-sec" onclick="closeSettings(false); openFeedSheet('topics')">Argomenti</button>
      </div>
    </div>
    <div class="settings-row">
      <div class="settings-lbl">Cronologia (72h)</div>
      <div class="settings-val">${seen.length ? `${seen.length} notizie ricordate · Gemini evita di riproporle` : 'Nessuna notizia recente'}</div>
      <div class="form-btns" style="margin-top:0">
        <button class="btn-sec" onclick="clearFeedSeen()" ${seen.length ? '' : 'disabled'}>Dimentica tutto</button>
      </div>
      <div class="feed-hint" style="margin-top:10px">Trascina il feed verso il basso dalla prima card per aggiornarlo; arrivato in fondo, altre notizie si caricano da sole.</div>
    </div>
    <div class="settings-row">
      <div class="settings-lbl">Interessi (14 giorni)</div>
      <div class="settings-val">${prefs.length ? `${prefs.length} notizie aperte o discusse · guidano i prossimi feed` : 'Ancora nessun segnale: apri un articolo o fai una domanda'}</div>
      <div class="form-btns" style="margin-top:0">
        <button class="btn-sec" onclick="clearFeedPrefs()" ${prefs.length ? '' : 'disabled'}>Azzera interessi</button>
      </div>
    </div>`;
}
function clearFeedCache() {
  FEED.data = null; FEED.error = null; saveFeedCache();
  if (FEED.sheet) closeFeedSheet();
  refreshFeedSettings();
  if (curScreen === 'recap') renderDiscover();
}

// Selettore modello Gemini (impostazioni feed). Il cambio non invalida feed né articoli in cache.
function loadGeminiModels() {
  try {
    const o = JSON.parse(localStorage.getItem(GEMINI_MODELS_LS) || 'null');
    if (!o || !Array.isArray(o.models)) return { ts: 0, models: [] };
    return { ts: +o.ts || 0, models: o.models.filter(m => m && GEMINI_MODEL_RE.test(m.id || '')).map(m => ({ id: m.id, label: String(m.label || m.id) })) };
  } catch (e) { return { ts: 0, models: [] }; }
}
function renderFeedModelPicker(key) {
  const cur = feedModel();
  const loaded = loadGeminiModels();
  const presetIds = new Set(GEMINI_PRESETS.map(p => p.id));
  const extra = loaded.models.filter(m => !presetIds.has(m.id));
  const known = new Set([...presetIds, ...extra.map(m => m.id)]);
  const opt = (id, label, note) => `<button type="button" class="topic-row model-opt${id === cur ? ' on' : ''}" onclick="setFeedModel('${escFeed(id)}')" aria-pressed="${id === cur}">
        <div class="t-name"><div>${escFeed(label)}</div><div class="model-id">${escFeed(id)}${note ? ' · ' + escFeed(note) : ''}</div></div>
        <span class="model-check" aria-hidden="true">${id === cur ? '✓' : ''}</span>
      </button>`;
  let h = GEMINI_PRESETS.map(p => opt(p.id, p.label, p.note)).join('');
  if (!known.has(cur)) h += opt(cur, 'Personalizzato', '');
  if (extra.length) {
    const when = loaded.ts ? new Date(loaded.ts).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }) : '';
    h += `<div class="settings-lbl" style="margin-top:14px">Dalla tua chiave${when ? ' · ' + escFeed(when) : ''}</div>`;
    h += extra.map(m => opt(m.id, m.label, '')).join('');
  }
  h += `<div class="form-btns" style="margin-top:6px">
        <button class="btn-sec" onclick="fetchGeminiModels()" ${key && !FEED.modelsLoading ? '' : 'disabled'}>${FEED.modelsLoading ? 'Caricamento…' : 'Carica modelli dalla chiave'}</button>
      </div>
      <div class="topic-form">
        <input class="form-input" id="settings-model-input" type="text" placeholder="Altro modello (es. gemini-2.5-flash)" autocomplete="off" autocapitalize="off" spellcheck="false" onkeydown="if(event.key==='Enter') setFeedModelFromInput()">
        <button class="btn-pri" onclick="setFeedModelFromInput()">Usa</button>
      </div>
      <div class="feed-hint" style="margin-top:10px">Vale per feed, articoli e chat. Il feed attuale resta: trascinalo verso il basso per rigenerarlo col nuovo modello.</div>`;
  return h;
}
function setFeedModel(id) {
  id = String(id || '').trim().replace(/^models\//, '');
  if (!GEMINI_MODEL_RE.test(id)) { showToast('Nome modello non valido', 'error'); return false; }
  try { localStorage.setItem(GEMINI_MODEL_LS, id); } catch (e) { showToast('Impossibile salvare il modello', 'error'); return false; }
  showToast('Modello: ' + id, 'info', 2200);
  refreshFeedSettings();
  return true;
}
function setFeedModelFromInput() {
  const i = document.getElementById('settings-model-input');
  const v = (i ? i.value : '').trim();
  if (!v) return;
  setFeedModel(v);
}
const GEMINI_MODEL_EXCLUDE = /embed|tts|image|imagen|live|audio|veo|aqa|native|robotics|computer-use/i;
async function fetchGeminiModels() {
  const key = feedKey();
  if (!key) { showToast(feedErrorMessage({ code: 'nokey' }), 'error'); return; }
  if (FEED.modelsLoading) return;
  FEED.modelsLoading = true;
  refreshFeedSettings();
  try {
    const all = [];
    let token = '';
    for (let page = 0; page < 5; page++) { // la chiave va solo nell'header, mai nell'URL
      let res;
      try {
        res = await fetch(GEMINI_API + 'models?pageSize=200' + (token ? '&pageToken=' + encodeURIComponent(token) : ''), { headers: { 'x-goog-api-key': key } });
      } catch (e) { throw Object.assign(new Error('network'), { code: 'network' }); }
      if (!res.ok) {
        const err = Object.assign(new Error('http ' + res.status), { code: 'http', status: res.status });
        try { const j = await res.json(); err.detail = j?.error?.message || ''; } catch (e) { }
        throw err;
      }
      let json;
      try { json = await res.json(); } catch (e) { throw Object.assign(new Error('parse'), { code: 'parse' }); }
      all.push(...(json.models || []));
      token = json.nextPageToken || '';
      if (!token) break;
    }
    const seen = new Set();
    const models = all
      .filter(m => m && typeof m.name === 'string' && m.name.startsWith('models/gemini')
        && Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
      .map(m => ({ id: m.name.slice(7), label: String(m.displayName || m.name.slice(7)) }))
      .filter(m => GEMINI_MODEL_RE.test(m.id) && !GEMINI_MODEL_EXCLUDE.test(m.id) && !seen.has(m.id) && seen.add(m.id))
      .sort((a, b) => b.id.localeCompare(a.id));
    if (!models.length) { showToast('Nessun modello compatibile per questa chiave', 'warn'); return; }
    try { localStorage.setItem(GEMINI_MODELS_LS, JSON.stringify({ ts: Date.now(), models })); } catch (e) { }
    showToast(models.length + ' modelli caricati', 'info', 2200);
  } catch (e) {
    console.error('fetchGeminiModels', e);
    showToast(feedErrorMessage(e), 'error');
  } finally {
    FEED.modelsLoading = false;
    refreshFeedSettings();
  }
}
