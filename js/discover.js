import { todayStr, uid, showToast, setSS, fmtHeaderDate, plural } from './utils.js';
import { SUPA_URL, SUPA_KEY, sb, curUser, SETTINGS, curScreen, calcPct, updateTopProgressBar } from './state.js';
import { sbSaveFeedTopics } from './sync.js';
import { topicWeights, rankFeedItems, mergeNearDuplicates, feedCardSources, subtopicKey } from './feedrank.js';

// Dipendenza "verso l'alto" (settings.js importa già discover.js: importarla qui farebbe un ciclo):
// app.js la registra con setDiscoverHooks() all'avvio.
let openSettings;
function setDiscoverHooks(h) { ({ openSettings } = h); }

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
// Notizie dal cloud (Supabase: tabella feed_items, Edge Function generate-feed)
const FEED_FN_PATH = '/functions/v1/generate-feed';
const FEED_FIRST_N = 12;                    // card del primo caricamento dal cloud
const FEED_POOL_HOURS = 72;                 // notizie generate nelle ultime 72h
const FEED_EV_DAYS = 30;                    // eventi usati per i pesi degli argomenti
const FEED_VIEWED_LS = 'dayflow_feed_viewed'; // { id: ts } card del cloud già viste (anche prima dell'invio eventi)
const FEED_VIEWED_TTL = 7 * 24 * 60 * 60 * 1000;
const FEED_EVQ_LS = 'dayflow_feed_evq';     // eventi in coda per feed_events
const FEED_VIEW_MS = 1500;                  // sotto questa permanenza la card è "scorsa via" (skip)
const FEED_ITEM_COLS = 'id,created_at,topic_id,subtopic,tags,type,title,summary,why,source,url,sources,published_at,q_specificity,q_novelty,q_importance,article';
const FEED_ITEM_COLS_P4 = FEED_ITEM_COLS + ',follow_id'; // follow_id arriva con lo SQL 04 (se manca: senza)
const FEED_VOTES_LS = 'dayflow_feed_votes';   // { id: { v: 'up'|'down', ts } } voti delle card (30 giorni)
const FEED_VOTES_TTL = 30 * 24 * 60 * 60 * 1000;
const FEED_TTS_VOICE_LS = 'dayflow_tts_voice'; // voiceURI della voce scelta per Ascolta (solo locale)
const FEED_SET_LS = 'dayflow_feed_settings';  // { uid, s: feed_settings, ops: [modifiche non ancora nel cloud] }
const FEED_AREAS = [
  { id: 'misto', label: 'Misto', note: 'italiane quando ci sono, altrimenti internazionali' },
  { id: 'italia', label: 'Italia', note: 'fonti e fatti italiani' },
  { id: 'europa', label: 'Europa', note: '' },
  { id: 'mondo', label: 'Mondo', note: 'fonti internazionali, anche in inglese' }
];
const FEED_LEVELS = [{ id: 'divulgativo', label: 'Divulgativo' }, { id: 'tecnico', label: 'Tecnico' }];
const FEED_TOPIC_TXT_MAX = 300;               // focus / esclusioni di un argomento
const FEED_PROFILE_MAX = 1500;
const FEED_PALETTE = ['#60a5fa', '#34d399', '#fbbf24', '#c084fc', '#f472b6', '#fb923c', '#2dd4bf', '#a3e635'];
const FEED_DEFAULT_TOPICS = [
  { id: 'tech', label: 'Tech', emoji: '🔵', color: '#60a5fa' },
  { id: 'sport', label: 'Sport', emoji: '⚽', color: '#34d399' },
  { id: 'crypto', label: 'Crypto', emoji: '📈', color: '#fbbf24' },
  { id: 'scienza', label: 'Scienza', emoji: '🧬', color: '#c084fc' }
];
const FEED = { topics: [], activeTopic: 'all', data: null, loading: false, error: null, more: false, moreTopic: null, moreError: null, sheet: null, card: null, chat: [], chatBusy: false, articleStream: null, articlePartial: null, pullInit: false, endObs: null, saved: null,
  pool: null, poolLoading: null, weights: {}, viewedIds: null, cloudMore: null, evQ: null, evFlushing: false, viewObs: null, viewing: new Map(), evInit: false,
  noFollowCol: false, votePop: null, setStore: null, setFlush: null, setFlushAgain: false, setFetchedAt: 0,
  follows: null, followsLoading: null, followsErr: null, profileBusy: false, topicEdit: null, topicDraft: null, topicPhraseBusy: false, tts: null };

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
// Argomento: id stabile, label, emoji, colore + fase 4: focus / exclude (≤300 caratteri),
// area ('misto'|'italia'|'europa'|'mondo', null = quella generale), level ('divulgativo'|'tecnico').
function normalizeTopic(t, i) {
  const label = String(t.label || '').trim().slice(0, 24);
  const txt = v => String(v || '').replace(/\s+/g, ' ').trim().slice(0, FEED_TOPIC_TXT_MAX);
  return {
    id: String(t.id || label.toLowerCase().replace(/[^a-z0-9]+/g, '-') || uid()), label, emoji: String(t.emoji || '✦').trim().slice(0, 4) || '✦', color: t.color || FEED_PALETTE[(i || 0) % FEED_PALETTE.length],
    focus: txt(t.focus), exclude: txt(t.exclude),
    area: FEED_AREAS.some(a => a.id === t.area) ? t.area : null,
    level: t.level === 'tecnico' ? 'tecnico' : 'divulgativo'
  };
}
function loadFeedTopics() {
  let t = null;
  try { t = JSON.parse(localStorage.getItem(FEED_TOPICS_LS) || 'null'); } catch (e) { }
  FEED.topics = (Array.isArray(t) && t.length ? t : FEED_DEFAULT_TOPICS).map(normalizeTopic);
}
function saveFeedTopics() {
  try { localStorage.setItem(FEED_TOPICS_LS, JSON.stringify(FEED.topics)); } catch (e) { }
  return sbSaveFeedTopics();
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
    logFeedEvent(list[idx], 'unsave');
    list.splice(idx, 1);
    showToast('Rimossa dai salvati', 'info', 1800);
  } else {
    const card = feedCardById(id); if (!card) return;
    list.push(Object.assign({}, card, { savedAt: Date.now() }));
    logFeedEvent(card, 'save');
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
  const u = feedSafeUrl(c.url);
  const text = `${c.title}\n\n${c.summary}\n\n${c.source}${u ? ' · ' + u : ''} · via DayFlow Discover`;
  try {
    if (navigator.share) { await navigator.share(u ? { title: c.title, text, url: u } : { title: c.title, text }); logFeedEvent(c, 'share'); return; }
    await navigator.clipboard.writeText(text);
    logFeedEvent(c, 'share');
    showToast('Copiata negli appunti', 'info', 1800);
  } catch (e) { if (e && e.name !== 'AbortError') showToast('Condivisione non riuscita', 'error'); }
}
function feedRelTime(card) {
  // Notizie del cloud con sola data di pubblicazione (senza ora): oggi / ieri / N giorni fa
  if (card.pubDay) {
    const g = Math.round((Date.parse(todayStr() + 'T12:00:00') - Date.parse(card.pubDay + 'T12:00:00')) / 86400000);
    return g <= 0 ? 'oggi' : g === 1 ? 'ieri' : g + ' giorni fa';
  }
  const gen = card.genAt || (FEED.data ? FEED.data.generatedAt : Date.now());
  const mins = Math.max(1, Math.round((card.ageMinutes || 60) + (Date.now() - gen) / 60000));
  if (mins < 60) return mins + ' min fa';
  const h = Math.round(mins / 60);
  if (h < 24) return h + ' h fa';
  const g = Math.round(h / 24);
  return g === 1 ? 'ieri' : g + ' giorni fa';
}
function feedSafeUrl(u) { return /^https?:\/\//i.test(String(u || '')) ? String(u) : ''; }

// ── Cloud (Supabase) ──
// Con l'utente loggato le notizie arrivano da feed_items (generate ogni mattina dalla Edge Function
// generate-feed) e approfondimenti/chat passano dalla stessa funzione (mode 'proxy'): la chiave Gemini
// resta nei segreti Supabase. La chiave locale, se c'è, è solo una riserva quando il cloud non risponde.
function cloudOn() { return !!(sb && curUser); }
function feedAIReady() { return cloudOn() || !!feedKey(); }
const feedAbortErr = () => Object.assign(new Error('abort'), { code: 'abort' });
async function feedFnFetch(payload, signal) {
  let token = '';
  try { const { data } = await sb.auth.getSession(); token = data?.session?.access_token || ''; } catch (e) { }
  if (!token) throw Object.assign(new Error('auth'), { code: 'http', status: 401, detail: 'dayflow-auth' });
  try {
    return await fetch(SUPA_URL + FEED_FN_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, apikey: SUPA_KEY }, body: JSON.stringify(payload), signal });
  } catch (e) { throw signal && signal.aborted ? feedAbortErr() : Object.assign(new Error('network'), { code: 'network' }); }
}
async function feedHttpError(res) {
  const err = Object.assign(new Error('http ' + res.status), { code: 'http', status: res.status });
  try { const j = await res.json(); err.detail = j?.error?.message || (Array.isArray(j?.errors) ? j.errors.join('; ') : '') || (typeof j?.error === 'string' ? j.error : ''); } catch (e) { }
  return err;
}
function rowToCard(r) {
  const now = Date.now();
  const pub = r.published_at ? Date.parse(r.published_at) : NaN;
  const card = {
    id: r.id, db: true, topicId: r.topic_id, title: r.title, summary: r.summary || '', why: r.why || '',
    source: r.source || 'Fonte', url: feedSafeUrl(r.url), type: r.type || '', subtopic: r.subtopic || '', tags: r.tags || [],
    q: [r.q_specificity, r.q_novelty, r.q_importance], createdAt: Date.parse(r.created_at) || now, pubAt: isNaN(pub) ? null : pub,
    // mezzanotte UTC esatta = Gemini ha dato solo la data
    pubDay: !isNaN(pub) && /T00:00:00(\.0+)?(Z|\+00(:?00)?)$/.test(r.published_at) ? r.published_at.slice(0, 10) : '',
    genAt: now,
    followId: r.follow_id || null, // aggiornamento di una storia seguita
    // fonti della ricerca Google: [{ title (spesso il dominio), url (null se non risolto) }]
    sources: Array.isArray(r.sources) ? r.sources.filter(x => x && (x.title || x.url)).map(x => ({ title: String(x.title || ''), url: feedSafeUrl(x.url) })) : []
  };
  card.ageMinutes = Math.max(1, Math.round((now - (card.pubAt || card.createdAt)) / 60000));
  if (r.article && Array.isArray(r.article.sections)) card.fullArticle = r.article;
  return card;
}
// Card del cloud già viste: localStorage (subito) + eventi view/skip/down già inviati (al caricamento del pool)
function loadFeedViewedLS() {
  let o = {};
  try { o = JSON.parse(localStorage.getItem(FEED_VIEWED_LS) || '{}') || {}; } catch (e) { }
  const cut = Date.now() - FEED_VIEWED_TTL;
  Object.keys(o).forEach(k => { if (!(o[k] > cut)) delete o[k]; });
  return o;
}
function markFeedViewed(id) {
  if (!FEED.viewedIds) FEED.viewedIds = new Set(Object.keys(loadFeedViewedLS()));
  FEED.viewedIds.add(id);
  const o = loadFeedViewedLS(); o[id] = Date.now();
  try { localStorage.setItem(FEED_VIEWED_LS, JSON.stringify(o)); } catch (e) { }
}
async function loadFeedPool() {
  if (FEED.poolLoading) return FEED.poolLoading;
  const run = (async () => {
    const uid = curUser.id, now = Date.now();
    const items = cols => sb.from('feed_items').select(cols).eq('user_id', uid).gte('created_at', new Date(now - FEED_POOL_HOURS * 3600000).toISOString()).order('created_at', { ascending: false }).limit(400);
    let [it, ev] = await Promise.all([
      items(FEED.noFollowCol ? FEED_ITEM_COLS : FEED_ITEM_COLS_P4),
      sb.from('feed_events').select('item_id,topic_id,kind').eq('user_id', uid).gte('created_at', new Date(now - FEED_EV_DAYS * 86400000).toISOString()).order('created_at', { ascending: false }).limit(5000),
      syncFeedSettings().catch(() => false) // preferenze aggiornate prima di ordinare (se il cloud non risponde: copia locale)
    ]);
    // SQL 04 non ancora eseguito: niente colonna follow_id
    if (it.error && !FEED.noFollowCol && /follow_id/.test(it.error.message || '')) { FEED.noFollowCol = true; it = await items(FEED_ITEM_COLS); }
    if (it.error) throw Object.assign(new Error('pool'), { code: 'pool', detail: it.error.message });
    const viewed = new Set(Object.keys(loadFeedViewedLS()));
    const events = ev.error ? [] : (ev.data || []);
    events.forEach(e => { if (e.item_id && ['view', 'skip', 'down', 'less'].includes(e.kind)) viewed.add(e.item_id); });
    FEED.viewedIds = viewed;
    FEED.pool = (it.data || []).map(rowToCard);
    FEED.weights = topicWeights(feedEvQ().slice().reverse().concat(events), FEED.topics.map(t => t.id));
  })();
  FEED.poolLoading = run;
  try { await run; } finally { if (FEED.poolLoading === run) FEED.poolLoading = null; }
}
function feedPoolLeft(topicId) {
  const active = new Set(FEED.topics.map(t => t.id));
  const inFeed = new Set();
  // anche le notizie unite a una card già nel feed (stesso fatto, altra testata)
  (FEED.data ? FEED.data.cards : []).forEach(c => { inFeed.add(c.id); (c.mergedIds || []).forEach(x => inFeed.add(x)); });
  const titles = new Set((FEED.data ? FEED.data.cards : []).map(c => c.title.toLowerCase()));
  const viewed = FEED.viewedIds || new Set();
  return (FEED.pool || []).filter(c => active.has(c.topicId) && (!topicId || c.topicId === topicId)
    && !viewed.has(c.id) && !inFeed.has(c.id) && !titles.has(c.title.toLowerCase()));
}
function pickFromPool(topicId, n) {
  const shown = FEED.data ? feedVisibleCards(topicId || 'all') : [];
  const pr = feedPrefs();
  // stesso fatto da più testate → una card con "N fonti"; poi ordinamento con le preferenze esplicite
  return rankFeedItems(mergeNearDuplicates(feedPoolLeft(topicId)), FEED.weights, {
    offset: shown.length, prevTypes: shown.slice(-2).map(c => c.type || ''),
    moreSub: pr.moreSub, lessSub: pr.lessSub, blockedSources: pr.blockedSources
  }).slice(0, n);
}
// Chiede alla funzione un nuovo gruppo di notizie (mode 'more'); una richiesta alla volta.
async function requestCloudMore(topicId) {
  if (FEED.cloudMore) return FEED.cloudMore;
  const run = (async () => {
    const res = await feedFnFetch({ mode: 'more', topicId: topicId || undefined });
    if (!res.ok) throw await feedHttpError(res);
    let j = null; try { j = await res.json(); } catch (e) { }
    const cards = (j && Array.isArray(j.items) ? j.items : []).map(rowToCard);
    if (!FEED.pool) FEED.pool = [];
    const known = new Set(FEED.pool.map(c => c.id));
    cards.forEach(c => { if (!known.has(c.id)) FEED.pool.push(c); });
    return cards.length;
  })();
  FEED.cloudMore = run;
  try { return await run; } finally { if (FEED.cloudMore === run) FEED.cloudMore = null; }
}
async function cloudFeedCards(topicId, n, reload) {
  if (reload || !FEED.pool) await loadFeedPool();
  let picked = pickFromPool(topicId, n);
  if (picked.length < Math.min(n, 4)) {
    await requestCloudMore(topicId);
    picked = pickFromPool(topicId, n);
  }
  if (!picked.length) throw Object.assign(new Error('empty'), { code: 'empty' });
  // Prefetch: se nel pool restano poche notizie, il prossimo gruppo si prepara in background
  if (feedPoolLeft(topicId).length - picked.length < FEED_CARDS_N) requestCloudMore(topicId).catch(e => console.warn('prefetch cloud', e));
  return picked;
}
// Prossime card per il feed: cloud se disponibile, altrimenti (o se il cloud fallisce) generazione dal client.
async function nextFeedCards(topicId, n) {
  if (cloudOn()) {
    try { return await cloudFeedCards(topicId === 'all' ? null : topicId, n, false); }
    catch (e) {
      if (e.detail === 'dayflow-rate' || e.detail === 'dayflow-auth') throw e;
      console.warn('feed cloud', e);
    }
  }
  return fetchFeedCards(topicId === 'all' ? FEED.topics : [feedTopic(topicId)], FEED_CARDS_N);
}

// ── Registro interazioni (feed_events) ──
// Coda in localStorage, inviata a blocchi (debounce 4 s, app nascosta). Le card scorse via (skip)
// sono registrate ma non penalizzano l'argomento (vedi feedrank.js).
function feedEvQ() {
  if (!FEED.evQ) { try { const q = JSON.parse(localStorage.getItem(FEED_EVQ_LS) || '[]'); FEED.evQ = Array.isArray(q) ? q : []; } catch (e) { FEED.evQ = []; } }
  return FEED.evQ;
}
function saveFeedEvQ() { try { localStorage.setItem(FEED_EVQ_LS, JSON.stringify(feedEvQ().slice(-500))); } catch (e) { } }
let feedEvTimer = null;
function logFeedEvent(card, kind, dwell) {
  if (!card || !curUser) return;
  feedEvQ().push({
    uid: curUser.id, item_id: card.db ? card.id : null, kind, topic_id: card.topicId || null, subtopic: card.subtopic || null,
    type: card.type || null, tags: card.tags && card.tags.length ? card.tags : null,
    dwell_ms: dwell == null ? null : Math.round(Math.min(dwell, 600000)), created_at: new Date().toISOString()
  });
  if (card.db && (kind === 'view' || kind === 'skip')) { markFeedViewed(card.id); (card.mergedIds || []).forEach(markFeedViewed); }
  saveFeedEvQ();
  clearTimeout(feedEvTimer); feedEvTimer = setTimeout(flushFeedEvents, 4000);
}
async function flushFeedEvents() {
  clearTimeout(feedEvTimer); feedEvTimer = null;
  if (!cloudOn() || FEED.evFlushing) return;
  const uid = curUser.id;
  FEED.evQ = feedEvQ().filter(e => e.uid === uid); // eventi di un altro account: scartati
  const batch = FEED.evQ.slice(0, 200);
  if (!batch.length) { saveFeedEvQ(); return; }
  FEED.evFlushing = true;
  let ok = false;
  try {
    const rows = batch.map(({ uid: u, ...e }) => ({ ...e, user_id: u }));
    let { error } = await sb.from('feed_events').insert(rows);
    // notizia cancellata nel frattempo (FK): l'evento resta, senza item_id
    if (error && error.code === '23503') ({ error } = await sb.from('feed_events').insert(rows.map(r => ({ ...r, item_id: null }))));
    if (error) console.warn('feed_events', error.message); else ok = true;
  } catch (e) { }
  FEED.evFlushing = false;
  if (ok && curUser && curUser.id === uid) {
    FEED.evQ = feedEvQ().filter(e => !batch.includes(e));
    saveFeedEvQ();
    if (FEED.evQ.length) feedEvTimer = setTimeout(flushFeedEvents, 1000);
  }
}
// Viste: una card è "vista" se resta ≥ FEED_VIEW_MS nel feed (60% visibile), altrimenti "skip".
function observeFeedViews() {
  const f = document.getElementById('disc-feed');
  if (!f || !('IntersectionObserver' in window) || FEED.activeTopic === 'saved') return;
  if (!FEED.viewObs || FEED.viewObs.root !== f) {
    if (FEED.viewObs) FEED.viewObs.disconnect();
    FEED.viewObs = new IntersectionObserver(entries => {
      const now = performance.now();
      entries.forEach(e => {
        const id = e.target.dataset.id; if (!id) return;
        if (e.isIntersecting && document.visibilityState === 'visible') { if (!FEED.viewing.has(id)) FEED.viewing.set(id, now); }
        else endFeedView(id, now);
      });
    }, { root: f, threshold: 0.6 });
  }
  f.querySelectorAll('.feed-slide.card').forEach(el => { if (!el.dataset.obs) { el.dataset.obs = '1'; FEED.viewObs.observe(el); } });
}
function endFeedView(id, now = performance.now()) {
  const t0 = FEED.viewing.get(id); if (t0 == null) return;
  FEED.viewing.delete(id);
  const card = FEED.data && FEED.data.cards.find(c => c.id === id); if (!card) return;
  const dwell = now - t0;
  logFeedEvent(card, dwell >= FEED_VIEW_MS ? 'view' : 'skip', dwell);
}
function endAllFeedViews() { [...FEED.viewing.keys()].forEach(id => endFeedView(id)); }
function initFeedEvents() {
  if (FEED.evInit) return;
  FEED.evInit = true;
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { endAllFeedViews(); flushFeedEvents(); } });
  window.addEventListener('pagehide', () => { endAllFeedViews(); saveFeedEvQ(); });
  // Popover dei voti: si chiude toccando fuori o scorrendo il feed
  document.addEventListener('click', e => { if (FEED.votePop && !(e.target.closest && e.target.closest('.feed-vote-pop, .feed-vote'))) closeFeedVotePop(); });
  const f = document.getElementById('disc-feed');
  if (f) f.addEventListener('scroll', () => { if (FEED.votePop) closeFeedVotePop(); }, { passive: true });
  if (feedEvQ().length) flushFeedEvents();
  if (cloudOn()) syncFeedSettings().catch(() => { }); // modifiche rimaste in coda da una sessione offline
}
function feedSourceClick(id) { logFeedEvent(feedCardById(id), 'open'); }

// ── Impostazioni del feed nel cloud (profiles.feed_settings) ──
// { area, profile, profileAt, profileManual, prefs: { moreSub, lessSub, blockedSources }, …altre chiavi }
// Il JSON è condiviso con la Edge Function (che scrive profile/profileAt): il client non lo sovrascrive
// mai intero. Ogni modifica è un'operazione (ops) salvata subito in localStorage e applicata sull'ultima
// versione letta dal cloud (leggi → applica → update); se il cloud non risponde resta in coda e riparte
// al prossimo caricamento del feed. Operazioni: { k, v } imposta una chiave; { list, add | del } in prefs.
function feedSetStore() {
  const u = curUser ? curUser.id : null;
  if (!FEED.setStore || FEED.setStore.uid !== u) {
    let o = null;
    try { o = JSON.parse(localStorage.getItem(FEED_SET_LS) || 'null'); } catch (e) { }
    FEED.setStore = o && o.uid === u && o.s && typeof o.s === 'object' ? { uid: u, s: o.s, ops: Array.isArray(o.ops) ? o.ops : [] } : { uid: u, s: {}, ops: [] };
  }
  return FEED.setStore;
}
function saveFeedSetStore() { try { localStorage.setItem(FEED_SET_LS, JSON.stringify(feedSetStore())); } catch (e) { } }
function applyFeedSettingsOps(s, ops) {
  const out = Object.assign({}, s && typeof s === 'object' && !Array.isArray(s) ? s : {});
  out.prefs = Object.assign({}, out.prefs && typeof out.prefs === 'object' && !Array.isArray(out.prefs) ? out.prefs : {});
  (ops || []).forEach(op => {
    if (!op) return;
    if (op.k) { out[op.k] = op.v; return; }
    if (!op.list) return;
    const v = String(op.add ?? op.del ?? '').trim(); if (!v) return;
    const l = (Array.isArray(out.prefs[op.list]) ? out.prefs[op.list] : []).filter(x => typeof x === 'string' && x.toLowerCase() !== v.toLowerCase());
    out.prefs[op.list] = op.add != null ? [...l, v].slice(-100) : l;
  });
  return out;
}
function feedSettings() { return feedSetStore().s || {}; }
function feedPrefs() {
  const p = feedSettings().prefs || {};
  const arr = l => (Array.isArray(l) ? l : []).filter(x => typeof x === 'string' && x.trim());
  return { moreSub: arr(p.moreSub), lessSub: arr(p.lessSub), blockedSources: arr(p.blockedSources) };
}
function changeFeedSettings(ops) {
  const st = feedSetStore();
  st.s = applyFeedSettingsOps(st.s, ops);
  if (st.uid) st.ops.push(...ops);
  saveFeedSetStore();
  if (cloudOn()) syncFeedSettings().then(ok => { if (!ok) console.warn('feed_settings: modifica in coda, riprovo più tardi'); }, () => { });
}
// Legge feed_settings dal cloud e, se ci sono modifiche in coda, le applica e le scrive.
// Una sola esecuzione alla volta; una chiamata durante l'esecuzione la fa ripetere alla fine.
async function syncFeedSettings() {
  if (!cloudOn()) return false;
  if (FEED.setFlush) { FEED.setFlushAgain = true; return FEED.setFlush; }
  const run = (async () => {
    let ok;
    do { FEED.setFlushAgain = false; ok = await syncFeedSettingsOnce(); } while (ok && FEED.setFlushAgain);
    return ok;
  })();
  FEED.setFlush = run;
  try { return await run; } finally { if (FEED.setFlush === run) FEED.setFlush = null; }
}
async function syncFeedSettingsOnce() {
  const uid = curUser.id;
  FEED.setFetchedAt = Date.now();
  const res = await sb.from('profiles').select('feed_settings').eq('id', uid).maybeSingle();
  if (!curUser || curUser.id !== uid || res.error) return false;
  const fs = res.data && res.data.feed_settings;
  const remote = fs && typeof fs === 'object' && !Array.isArray(fs) ? fs : {};
  const st = feedSetStore();
  const ops = st.ops.slice();
  if (ops.length) {
    const merged = applyFeedSettingsOps(remote, ops);
    const up = await sb.from('profiles').update({ feed_settings: merged }).eq('id', uid);
    if (!curUser || curUser.id !== uid || up.error) { if (up && up.error) console.warn('feed_settings', up.error.message); return false; }
    st.ops = st.ops.slice(ops.length); // quelle aggiunte durante l'update restano in coda
    st.s = applyFeedSettingsOps(merged, st.ops);
  } else st.s = applyFeedSettingsOps(remote, []);
  saveFeedSetStore();
  return true;
}

// ── Voti 👍/👎 (card del cloud) ──
// Il voto resta in localStorage per card (evidenziato alla riapertura); ogni tocco registra up / down,
// il secondo tocco sullo stesso voto registra unvote. Dopo il voto un popover propone "di più / meno
// su «sotto-argomento»", "Non mostrarmi <fonte>" o "Segui la storia".
function loadFeedVotes() {
  let o = {};
  try { o = JSON.parse(localStorage.getItem(FEED_VOTES_LS) || '{}') || {}; } catch (e) { }
  const cut = Date.now() - FEED_VOTES_TTL;
  Object.keys(o).forEach(k => { if (!o[k] || !(o[k].ts > cut)) delete o[k]; });
  return o;
}
function feedVote(id) { const v = loadFeedVotes()[id]; return v ? v.v : ''; }
function setFeedVote(id, v) {
  const o = loadFeedVotes();
  if (v) o[id] = { v, ts: Date.now() }; else delete o[id];
  try { localStorage.setItem(FEED_VOTES_LS, JSON.stringify(o)); } catch (e) { }
}
function paintFeedVote(id) {
  const v = feedVote(id);
  document.querySelectorAll(`.feed-slide[data-id="${CSS.escape(id)}"] .feed-vbtn`).forEach(b => {
    const on = b.dataset.v === v;
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
  });
}
function voteFeedCard(id, v) {
  const c = feedCardById(id); if (!c || !c.db) return;
  const cur = feedVote(id);
  closeFeedVotePop();
  if (cur === v) { setFeedVote(id, ''); logFeedEvent(c, 'unvote'); paintFeedVote(id); return; }
  setFeedVote(id, v);
  logFeedEvent(c, v);
  paintFeedVote(id);
  openFeedVotePop(c, v);
}
// Fonte che il 👎 propone di bloccare: la prima non ancora bloccata (dominio se c'è, altrimenti nome)
function feedBlockCandidate(c) {
  const blocked = feedPrefs().blockedSources.map(b => b.toLowerCase());
  return feedCardSources(c).find(x => !blocked.includes((x.domain || x.name).toLowerCase())) || null;
}
function feedVoteOptions(c, v) {
  const pr = feedPrefs();
  const has = (l, k) => l.some(x => x.toLowerCase() === k);
  const opts = [];
  if (c.subtopic) {
    const k = subtopicKey(c.topicId, c.subtopic);
    const list = v === 'up' ? pr.moreSub : pr.lessSub;
    const done = has(list, k);
    opts.push({ act: v === 'up' ? 'more' : 'less', label: (done ? '✓ ' : '') + (v === 'up' ? 'Di più su' : 'Meno su') + ` «${c.subtopic}»`, done });
  }
  if (v === 'down') {
    const src = feedBlockCandidate(c);
    if (src) opts.push({ act: 'block', label: 'Non mostrarmi ' + (src.domain || src.name) });
  } else if (cloudOn()) {
    const f = feedFollowOf(c.id);
    opts.push({ act: 'follow', label: f ? '✓ Storia seguita' : 'Segui la storia', done: !!f });
  }
  return opts;
}
function openFeedVotePop(c, v) {
  const opts = feedVoteOptions(c, v);
  if (!opts.length) return;
  const card = document.querySelector(`.feed-slide[data-id="${CSS.escape(c.id)}"] .feed-card`); if (!card) return;
  const pop = document.createElement('div');
  pop.className = 'feed-vote-pop';
  pop.setAttribute('role', 'menu');
  pop.innerHTML = opts.map(o => `<button type="button" role="menuitem" class="feed-vote-opt" ${o.done ? 'disabled' : ''} onclick="feedVoteAction('${escFeed(c.id)}','${o.act}')">${escFeed(o.label)}</button>`).join('');
  card.appendChild(pop);
  FEED.votePop = c.id;
  if (v === 'up' && cloudOn() && !FEED.follows && !FEED.followsLoading) loadFeedFollows().catch(() => { });
}
function closeFeedVotePop() {
  FEED.votePop = null;
  document.querySelectorAll('.feed-vote-pop').forEach(el => el.remove());
}
function feedVoteAction(id, act) {
  const c = feedCardById(id);
  closeFeedVotePop();
  if (!c) return;
  if (act === 'more' || act === 'less') {
    if (!c.subtopic) return;
    const val = `${c.topicId}:${c.subtopic.trim()}`;
    changeFeedSettings(act === 'more'
      ? [{ list: 'moreSub', add: val }, { list: 'lessSub', del: val }]
      : [{ list: 'lessSub', add: val }, { list: 'moreSub', del: val }]);
    logFeedEvent(c, act);
    showToast((act === 'more' ? 'Più notizie su «' : 'Meno notizie su «') + c.subtopic + '»', 'info', 2200);
  } else if (act === 'block') {
    const src = feedBlockCandidate(c); if (!src) return;
    changeFeedSettings([{ list: 'blockedSources', add: (src.domain || src.name).toLowerCase() }]);
    showToast('Non vedrai più notizie da ' + (src.domain || src.name), 'info', 2600);
  } else if (act === 'follow') followFeedStory(id);
  refreshFeedSettings();
}

// ── Storie seguite (feed_follows) ──
// Ogni mattina la funzione cerca novità sulle storie attive (14 giorni) e le inserisce con follow_id.
const FEED_FOLLOW_COLS = 'id,item_id,topic_id,title,created_at,until,updates,checked_at';
async function loadFeedFollows(force) {
  if (!cloudOn()) return [];
  if (FEED.followsLoading) return FEED.followsLoading;
  if (FEED.follows && !force) return FEED.follows;
  const uid = curUser.id;
  const run = (async () => {
    const { data, error } = await sb.from('feed_follows').select(FEED_FOLLOW_COLS).eq('user_id', uid).eq('active', true)
      .gte('until', new Date().toISOString()).order('created_at', { ascending: false }).limit(50);
    if (!curUser || curUser.id !== uid) return [];
    if (error) { FEED.followsErr = error.message; FEED.follows = FEED.follows || []; return FEED.follows; }
    FEED.followsErr = null;
    FEED.follows = data || [];
    return FEED.follows;
  })();
  FEED.followsLoading = run;
  try { return await run; } finally { if (FEED.followsLoading === run) FEED.followsLoading = null; }
}
function feedFollowOf(itemId) { return (FEED.follows || []).find(f => f.item_id === itemId) || null; }
async function followFeedStory(id) {
  const c = feedCardById(id);
  if (!c || !c.db || !cloudOn()) return;
  await loadFeedFollows();
  if (feedFollowOf(c.id)) { showToast('Segui già questa storia', 'info', 1800); return; }
  const { data, error } = await sb.from('feed_follows')
    .insert({ item_id: c.id, topic_id: c.topicId, title: String(c.title).slice(0, 300), summary: String(c.summary || '').slice(0, 1200), url: feedSafeUrl(c.url) || null })
    .select(FEED_FOLLOW_COLS).single();
  if (error || !data) { console.warn('feed_follows', error && error.message); showToast('Non riesco a seguire la storia', 'error'); return; }
  (FEED.follows = FEED.follows || []).unshift(data);
  showToast('Storia seguita per 14 giorni: le novità arrivano al mattino', 'info', 3000);
  updateArticleTools();
  refreshFeedSettings();
}
async function stopFollowFeedStory(f) {
  if (!f || !cloudOn()) return;
  const { error } = await sb.from('feed_follows').update({ active: false }).eq('id', f.id);
  if (error) { showToast('Non riesco a smettere di seguire la storia', 'error'); return; }
  FEED.follows = (FEED.follows || []).filter(x => x.id !== f.id);
  showToast('Non segui più questa storia', 'info', 1800);
  updateArticleTools();
  refreshFeedSettings();
}
function unfollowFeedStory(i) { stopFollowFeedStory((FEED.follows || [])[i]); }
function toggleFollowFeedStory(id) {
  const f = feedFollowOf(id);
  if (f) stopFollowFeedStory(f); else followFeedStory(id);
}

// ── Gemini REST ──
// Cloud (proxy nella Edge Function) se loggato; chiave locale se non loggato o se il cloud
// non risponde (rete / 5xx). Risposte ed errori hanno la stessa forma nei due casi.
async function geminiFetch(body, stream, signal) {
  if (cloudOn()) {
    try {
      const res = await feedFnFetch({ mode: 'proxy', model: feedModel(), stream: !!stream, request: body }, signal);
      adoptCloudModel(res);
      if (res.status < 500 || !feedKey()) return res;
    } catch (e) { if (e.code !== 'network' || !feedKey()) throw e; }
  }
  const key = feedKey();
  if (!key) throw Object.assign(new Error('nokey'), { code: 'nokey' });
  try {
    return await fetch(geminiUrl(stream), { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), signal });
  } catch (e) { throw signal && signal.aborted ? feedAbortErr() : Object.assign(new Error('network'), { code: 'network' }); }
}
// Il modello scelto non esiste più: la funzione ha usato un sostituto (header x-dayflow-model)
// → lo adotto anche nelle impostazioni, così le richieste successive lo chiedono direttamente.
function adoptCloudModel(res) {
  const used = (res.headers && res.headers.get('x-dayflow-model')) || '';
  const cur = feedModel();
  if (!used || used === cur || !GEMINI_MODEL_RE.test(used)) return;
  try { localStorage.setItem(GEMINI_MODEL_LS, used); } catch (e) { return; }
  showToast(`${cur} non è più disponibile: ora uso ${used}`, 'warn', 4000);
  refreshFeedSettings();
}
async function geminiRequest(body) {
  const res = await geminiFetch(body, false);
  if (!res.ok) throw await feedHttpError(res);
  const json = await res.json();
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const text = parts.filter(p => !p.thought).map(p => p.text || '').join('').trim();
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
  const signal = opts.signal;
  const aborted = feedAbortErr;
  let res;
  try { res = await geminiFetch(body, true, signal); } catch (e) { throw signal && signal.aborted ? aborted() : e; }
  if (!res.ok) throw await feedHttpError(res);
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
// tools (url_context / google_search) facoltativi: se il modello li rifiuta (400) si riprova senza.
async function geminiText(contents, system, tools) {
  const body = { systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { temperature: 0.7 } };
  if (tools && tools.length) {
    try { return await geminiRequest(Object.assign({}, body, { tools })); }
    catch (e) { if (!(e.code === 'http' && e.status === 400)) throw e; }
  }
  return geminiRequest(body);
}
function feedErrorMessage(e) {
  if (!e) return 'Errore sconosciuto.';
  if (e.code === 'nokey') return 'Nessuna chiave API configurata.';
  if (e.code === 'network') return navigator.onLine ? 'La rete non risponde. Riprova tra poco.' : 'Sei offline. Il feed torna quando sei connesso.';
  if (e.code === 'truncated') return 'Articolo interrotto.';
  if (e.code === 'parse' || e.code === 'empty') return 'Risposta dell\'AI non valida. Riprova.';
  if (e.code === 'pool') return 'Non riesco a leggere le notizie dal cloud.';
  if (e.detail === 'dayflow-auth') return 'Sessione scaduta: esci e rientra in DayFlow.';
  if (e.detail === 'dayflow-rate') return 'Troppe richieste in poco tempo. Riprova tra qualche minuto.';
  if (e.detail === 'dayflow-few-signals') return 'Servono almeno 5 reazioni alle notizie';
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
  initFeedEvents();
  updateTopProgressBar(calcPct(todayStr()) || 0);
  renderFeedChips();
  renderFeed();
  if (feedAIReady() && !FEED.data && !FEED.loading && !FEED.error) generateFeed();
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
  endAllFeedViews(); // il DOM viene ricostruito: chiudo le viste in corso (ripartono con le nuove card)
  FEED.votePop = null;
  const stale = document.getElementById('disc-stale');
  const regen = document.getElementById('disc-regen');
  if (regen) regen.disabled = FEED.loading;
  if (stale) stale.innerHTML = (FEED.data && FEED.data.stale && !FEED.loading) ? `<div class="feed-stale"><span>Argomenti cambiati</span><button onclick="regenerateFeed()">↻ Rigenera</button></div>` : '';

  if (!feedAIReady()) {
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
        <div class="feed-meta"><div class="feed-spinner"></div><span>${cloudOn() ? 'Carico le notizie di oggi…' : 'Gemini sta preparando il tuo feed…'}</span></div>
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
          <button class="feed-btn sec" onclick="openFeedSheet('settings')">${cloudOn() ? 'Impostazioni' : 'Cambia chiave'}</button>
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
  observeFeedViews();
}
// Card del feed coerenti con il filtro attivo (chip 'saved' escluso: non usa FEED.data).
function feedVisibleCards(topicId = FEED.activeTopic) {
  if (!FEED.data || topicId === 'saved') return [];
  return FEED.data.cards.filter(c => topicId === 'all' || c.topicId === topicId);
}
function feedCardHTML(c, i) {
  const t = feedTopic(c.topicId);
  const id = escFeed(c.id);
  const v = c.db ? feedVote(c.id) : '';
  // 👍/👎 solo sulle notizie del cloud (i segnali vanno in feed_events e feed_settings)
  const vote = c.db ? `<div class="feed-vote" role="group" aria-label="Valuta la notizia">
          <button type="button" class="feed-vbtn${v === 'up' ? ' on' : ''}" data-v="up" aria-pressed="${v === 'up'}" aria-label="Mi interessa" onclick="voteFeedCard('${id}','up')">👍</button>
          <button type="button" class="feed-vbtn${v === 'down' ? ' on' : ''}" data-v="down" aria-pressed="${v === 'down'}" aria-label="Non mi interessa" onclick="voteFeedCard('${id}','down')">👎</button>
        </div>` : '';
  const nSrc = feedCardSources(c).length;
  return `
      <article class="feed-slide card" data-id="${id}"><div class="feed-card" style="--tc:${escFeed(t.color)};animation-delay:${Math.min(i, 3) * 40}ms">
        <div class="feed-top"><div class="feed-badge"><span>${escFeed(t.emoji)}</span>${escFeed(t.label)}</div>${c.followId ? '<div class="feed-upd">↻ Aggiornamento</div>' : ''}${vote}</div>
        <h2 class="feed-title">${escFeed(c.title)}</h2>
        <div class="feed-summary"><p>${escFeed(c.summary)}</p>${c.why ? `<p class="feed-why"><b>Perché conta</b> ${escFeed(c.why)}</p>` : ''}</div>
        <div class="feed-meta">${feedSourceHTML(c)}${nSrc >= 2 ? `<span class="feed-meta-dot"></span><span class="feed-nsrc">${nSrc} fonti</span>` : ''}<span class="feed-meta-dot"></span><span>${escFeed(feedRelTime(c))}</span><span class="feed-meta-dot"></span><span class="feed-idx"></span></div>
        <div class="feed-actions">
          <button class="feed-btn pri" onclick="expandArticle('${escFeed(c.id)}')">📖 Leggi</button>
          <button class="feed-btn sec" onclick="openFeedChat('${escFeed(c.id)}')">💬 Chiedi</button>
          <button class="feed-btn ico feed-save${isFeedSaved(c.id) ? ' on' : ''}" onclick="toggleFeedSaved('${escFeed(c.id)}')" aria-label="Salva per dopo" title="Salva per dopo"><svg viewBox="0 0 24 24"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg></button>
          <button class="feed-btn ico" onclick="shareFeedCard('${escFeed(c.id)}')" aria-label="Condividi" title="Condividi"><svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg></button>
        </div>
      </div></article>`;
}
// Fonte: link all'articolo originale se c'è (notizie del cloud), altrimenti solo il nome
function feedSourceHTML(c) {
  const u = feedSafeUrl(c.url);
  return u ? `<a class="feed-src" href="${escFeed(u)}" target="_blank" rel="noopener noreferrer" onclick="feedSourceClick('${escFeed(c.id)}')">${escFeed(c.source)} ↗</a>` : `<span>${escFeed(c.source)}</span>`;
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
        <p>${empty ? 'Niente qui nel feed di oggi: cerco qualcosa su questo argomento.' : 'Cerco qualcosa che non hai ancora visto.'}</p>
        <div class="feed-disclaimer">${cloudOn() ? "Notizie da fonti reali, riassunte dall'AI · possono contenere imprecisioni" : "Contenuti generati dall'AI · possono contenere imprecisioni"}</div>`;
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
  if (!feedAIReady()) { renderFeed(); return; }
  if (FEED.loading) return;
  if (!FEED.topics.length) loadFeedTopics();
  const topics = FEED.topics;
  FEED.loading = true; FEED.error = null;
  if (force) FEED.data = null;
  FEED.moreError = null;
  renderFeed();
  try {
    let cards = null;
    if (cloudOn()) {
      try { cards = await cloudFeedCards(null, FEED_FIRST_N, true); }
      catch (e) { if (e.detail === 'dayflow-auth') throw e; console.warn('generateFeed cloud → generazione dal client', e); }
    }
    if (!cards) cards = await fetchFeedCards(topics, FEED_CARDS_N);
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
  if (FEED.more || FEED.loading || !FEED.data || !feedAIReady()) return;
  if (FEED.moreError && !retry) return;
  if (FEED.activeTopic === 'saved') return;
  const topicId = FEED.activeTopic;
  const data = FEED.data;
  FEED.more = true; FEED.moreTopic = topicId; FEED.moreError = null;
  let end = document.getElementById('disc-end');
  if (end) end.querySelector('.feed-card').innerHTML = feedEndInner();
  else if (curScreen === 'recap') renderFeed();
  let cards = null, err = null;
  try { cards = await nextFeedCards(topicId, FEED_CARDS_N); } catch (e) { err = e; }
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
  observeFeedViews();
}
function regenerateFeed() {
  if (FEED.loading) return;
  if (!feedAIReady()) { openFeedSheet('settings'); return; }
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
  if (FEED.tts && (!isCard || !FEED.card || FEED.card.id !== FEED.tts.id)) stopArticleSpeech();
  tabs.style.display = isCard ? 'flex' : 'none';
  document.getElementById('fsheet-tab-article').classList.toggle('on', mode === 'article');
  document.getElementById('fsheet-tab-chat').classList.toggle('on', mode === 'chat');
  foot.classList.toggle('on', mode === 'chat');
  title.textContent = isCard ? (feedTopic(FEED.card.topicId).emoji + ' ' + feedTopic(FEED.card.topicId).label) : mode === 'topics' ? 'Argomenti' : 'Impostazioni Discover';
  ov.classList.add('open');
  renderFeedSheet();
}
function switchFeedSheet(mode) { openFeedSheet(mode); }
function closeFeedSheet() { abortArticleStream(); stopArticleSpeech(); FEED.sheet = null; FEED.topicEdit = null; FEED.topicDraft = null; document.getElementById('feed-sheet').classList.remove('open'); }
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
  logFeedEvent(card, 'open');
  openFeedSheet('article', card);
  if (card.fullArticle || FEED.articleStream) return;
  streamArticle(card);
}
// Formato testo dell'articolo (parsabile a pezzi):
//   riga 1 = titolo · riga vuota · 3 righe "- punto" ("In breve") · riga vuota ·
//   "## Sottotitolo" · paragrafi separati da riga vuota.
// parseArticleText(text, final) → { title, tldr: [string], blocks: [{ tag: 'h3'|'p', text }] }.
// Le righe "- " prima del primo blocco sono il riassunto "In breve" (un'etichetta "In breve" si salta).
// Se !final l'ultima riga incompleta è inclusa nell'ultimo blocco (titolo solo a riga chiusa).
function parseArticleText(text, final) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const complete = final ? lines.length : lines.length - 1;
  const clean = s => s.replace(/\*\*|__/g, '').trim();
  let title = '', titleDone = false, para = null;
  const blocks = [], tldr = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!titleDone) {
      if (!line) continue;
      if (i >= complete) break;
      title = clean(line.replace(/^#+\s*/, '').replace(/^titolo\s*:\s*/i, ''));
      titleDone = true; continue;
    }
    if (!line) { para = null; continue; }
    if (!blocks.length) {
      if (/^(#+\s*)?(\*\*|__)?\s*in (breve|30 secondi)\s*:?\s*(\*\*|__)?\s*:?$/i.test(line)) { para = null; continue; }
      if (/^[-•*]\s+/.test(line)) { para = null; const t = clean(line.replace(/^[-•*]\s+/, '')); if (t) tldr.push(t); continue; }
    }
    if (/^#{1,6}(\s|$)/.test(line)) { para = null; blocks.push({ tag: 'h3', text: clean(line.replace(/^#+\s*/, '')) }); continue; }
    const t = clean(line);
    if (para) para.text += ' ' + t;
    else { para = { tag: 'p', text: t }; blocks.push(para); }
  }
  return { title, tldr, blocks };
}
// fullArticle = { title, tldr?: [3 punti], sections }; gli articoli in cache senza tldr restano validi.
function articleFromBlocks(title, blocks, tldr) {
  const sections = [];
  let cur = null;
  blocks.forEach(b => {
    if (b.tag === 'h3') { if (b.text) { cur = { heading: b.text, paragraphs: [] }; sections.push(cur); } }
    else if (b.text) { if (!cur) { cur = { heading: '', paragraphs: [] }; sections.push(cur); } cur.paragraphs.push(b.text); }
  });
  const art = { title, sections: sections.filter(s => s.paragraphs.length || s.heading) };
  const pts = (tldr || []).filter(Boolean).slice(0, 3);
  if (pts.length) art.tldr = pts;
  return art;
}
function abortArticleStream() {
  stopArticleSpeech();
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
  const url = feedSafeUrl(card.url);
  // Notizie del cloud: l'articolo si basa sulla pagina vera (url_context), con la ricerca come riserva
  const srcBlock = url ? `\nArticolo originale: ${url}\n\nLeggi l'articolo originale a quell'indirizzo e basati soprattutto su quello; se non riesci ad aprirlo, cerca la notizia con Google Search. Non inventare fatti, numeri o citazioni.` : '';
  const level = feedTopic(card.topicId).level === 'tecnico'
    ? 'Il lettore conosce la materia: usa i termini tecnici corretti e vai nel dettaglio.'
    : 'Il lettore è curioso ma non esperto: spiega in parole semplici i termini tecnici.';
  const prompt = `Scrivi in italiano un articolo di approfondimento (400-600 parole) a partire da questa notizia.\nTitolo: ${card.title}\nRiassunto: ${card.summary}\nFonte: ${card.source}\nArgomento: ${feedTopic(card.topicId).label}${srcBlock}\n\nTono giornalistico, chiaro, senza retorica. ${level} Contestualizza, spiega le implicazioni e chiudi con cosa aspettarsi. Non inventare citazioni virgolettate attribuite a persone reali.\n\nFORMATO DI OUTPUT (testo semplice, niente JSON, niente grassetti):\n- Prima riga: solo il titolo dell'articolo.\n- Poi una riga vuota.\n- "In breve": esattamente 3 righe che iniziano con "- ", ognuna un punto essenziale in una frase (massimo 20 parole). Non scrivere l'etichetta "In breve".\n- Poi una riga vuota.\n- 3-4 sezioni: ogni sezione inizia con una riga "## Sottotitolo breve", seguita da 1-3 paragrafi (niente elenchi puntati nelle sezioni).\n- Separa ogni paragrafo e ogni sottotitolo con una riga vuota.`;
  // 400-600 parole ≈ 800-1100 token: 3072 basta a thinking spento; con thinking attivo (pro, gemini-3,
  // sconosciuti) i token di ragionamento contano in maxOutputTokens → margine più alto.
  const thinking = geminiThinkingConfig();
  const generationConfig = { temperature: 0.7, maxOutputTokens: thinking && thinking.thinkingBudget === 0 ? 3072 : 8192 };
  if (thinking) generationConfig.thinkingConfig = thinking;
  const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig };
  if (url) body.tools = [{ url_context: {} }, { google_search: {} }];
  const onChunk = (d, all) => {
    if (FEED.articleStream !== st) return;
    st.text = all;
    if (!st.raf) st.raf = requestAnimationFrame(() => paintArticleStream(st, false));
  };
  try {
    let full;
    try { full = await geminiStream(body, onChunk, { signal: st.ctrl.signal }); }
    catch (e) {
      // strumenti rifiutati dal modello (400 prima di qualsiasi testo): riprovo senza
      if (!(body.tools && e.code === 'http' && e.status === 400 && !st.text) || FEED.articleStream !== st) throw e;
      delete body.tools;
      full = await geminiStream(body, onChunk, { signal: st.ctrl.signal });
    }
    if (FEED.articleStream !== st) return;
    const parsed = parseArticleText(full, true);
    const art = articleFromBlocks(parsed.title || card.title, parsed.blocks, parsed.tldr);
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
    // cache nel cloud: la stessa notizia si riapre già scritta anche da un altro dispositivo
    if (card.db && cloudOn()) sb.from('feed_items').update({ article: art }).eq('id', card.id).then(r => { if (r.error) console.warn('article cache', r.error.message); }, () => { });
    // Nessun re-render completo: il DOM è già allineato, si aggiunge solo il disclaimer
    const root = articleStreamRoot(st.id);
    if (root) {
      const s = root.querySelector('.art-status'); if (s) s.remove();
      const disc = document.createElement('div'); disc.className = 'feed-disclaimer';
      disc.textContent = feedArticleDisclaimer(card);
      root.appendChild(disc);
      root.removeAttribute('id');
      updateArticleTools(); // compare "Ascolta"
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
  const { title, blocks, tldr } = parseArticleText(st.text, final);
  if (title) { const h = root.querySelector('h2'); if (h && h.textContent !== title) h.textContent = title; }
  const box = root.querySelector('.art-tldr');
  if (box) {
    const pts = tldr.slice(0, 3), ul = box.querySelector('ul');
    box.hidden = !pts.length;
    while (ul.children.length > pts.length) ul.lastElementChild.remove();
    pts.forEach((t, i) => { let li = ul.children[i]; if (!li) { li = document.createElement('li'); ul.appendChild(li); } if (li.textContent !== t) li.textContent = t; });
  }
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
  root.classList.toggle('has-text', blocks.length > 0 || tldr.length > 0);
}
function feedArticleDisclaimer(c) {
  return feedSafeUrl(c.url) ? `Basato su ${c.source} · riscritto dall'AI · può contenere imprecisioni` : "Articolo generato dall'AI · può contenere imprecisioni";
}
function feedTldrHTML(pts) {
  const l = (Array.isArray(pts) ? pts : []).filter(Boolean).slice(0, 3);
  return l.length ? `<div class="art-tldr"><div class="art-tldr-h">In 30 secondi</div><ul>${l.map(x => `<li>${escFeed(x)}</li>`).join('')}</ul></div>` : '';
}
// Pulsanti sotto il titolo dell'articolo: Ascolta (solo ad articolo completo) e Segui la storia (notizie del cloud)
function articleToolsInner(c) {
  if (!c) return '';
  const out = [];
  if (c.fullArticle && ttsSupported()) {
    const on = !!(FEED.tts && FEED.tts.id === c.id);
    out.push(`<button type="button" class="feed-btn sec art-tool${on ? ' on' : ''}" aria-pressed="${on}" onclick="toggleArticleSpeech()">${on ? '■ Stop' : '🔊 Ascolta'}</button>`);
  }
  if (c.db && cloudOn()) {
    const f = feedFollowOf(c.id);
    out.push(`<button type="button" class="feed-btn sec art-tool${f ? ' on' : ''}" aria-pressed="${!!f}" onclick="toggleFollowFeedStory('${escFeed(c.id)}')">${f ? '✓ Storia seguita' : '📌 Segui la storia'}</button>`);
  }
  return out.join('');
}
function updateArticleTools() {
  const el = document.getElementById('fart-tools');
  if (el && FEED.sheet === 'article') el.innerHTML = articleToolsInner(FEED.card);
}

// ── Ascolta (speechSynthesis) ──
// Una utterance per blocco (titolo, punti "in breve", sottotitoli, paragrafi), tutte in coda subito:
// su iOS solo la prima deve partire da un tocco. Si ferma chiudendo il foglio, aprendo un'altra card
// o interrompendo l'articolo.
function ttsSupported() { return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function'; }
// Voci italiane dalla migliore: scelta dell'utente, poi Premium/Migliorata/Siri, poi voci "vere"
// (Alice, Federica, Luca…); in fondo le voci Eloquence di iOS (Eddy, Rocko, Grandma…), che suonano male.
const TTS_BAD = /(eddy|flo|grandma|grandpa|nonna|nonno|reed|rocko|sandy|shelley|albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox)/i;
function ttsVoiceScore(v) {
  let sc = 0;
  if (/^it[-_]it$/i.test(v.lang)) sc += 2;
  if (/premium/i.test(v.name) || /premium/i.test(v.voiceURI || '')) sc += 30;
  if (/enhanced|migliorat|siri|neural|natural|online/i.test(v.name) || /enhanced|siri/i.test(v.voiceURI || '')) sc += 20;
  if (/alice|federica|luca|emma|paola|elsa|diego|isabella|giorgio|cosimo/i.test(v.name)) sc += 5;
  if (TTS_BAD.test(v.name)) sc -= 50;
  return sc;
}
function ttsItVoices() {
  if (!ttsSupported()) return [];
  const all = speechSynthesis.getVoices() || [];
  return all.filter(v => /^it([-_]|$)/i.test(v.lang)).sort((a, b) => ttsVoiceScore(b) - ttsVoiceScore(a) || a.name.localeCompare(b.name));
}
function ttsVoice() {
  const list = ttsItVoices();
  let pick = '';
  try { pick = localStorage.getItem(FEED_TTS_VOICE_LS) || ''; } catch (e) { }
  return (pick && list.find(v => v.voiceURI === pick)) || list[0] || null;
}
function setFeedTtsVoice(uri) {
  try { if (uri) localStorage.setItem(FEED_TTS_VOICE_LS, uri); else localStorage.removeItem(FEED_TTS_VOICE_LS); } catch (e) { }
  testFeedTtsVoice();
}
function testFeedTtsVoice() {
  if (!ttsSupported()) return;
  stopArticleSpeech();
  try { speechSynthesis.cancel(); } catch (e) { }
  const u = new SpeechSynthesisUtterance('Ciao, questa è la voce che leggerà i tuoi approfondimenti.');
  u.lang = 'it-IT';
  const v = ttsVoice(); if (v) u.voice = v;
  speechSynthesis.speak(u);
}
function refreshTtsVoices() {
  if (!ttsSupported()) return;
  speechSynthesis.getVoices(); // chiede al sistema di ricaricare l'elenco
  setTimeout(() => { refreshFeedSettings(); showToast(plural(ttsItVoices().length, 'voce italiana', 'voci italiane'), 'info', 1800); }, 400);
}
function ttsSettingsHTML() {
  if (!ttsSupported()) return '';
  const list = ttsItVoices();
  let pick = '';
  try { pick = localStorage.getItem(FEED_TTS_VOICE_LS) || ''; } catch (e) { }
  // l'elenco può arrivare o cambiare dopo (voce scaricata): ridisegna ogni volta che il sistema lo aggiorna
  if (!FEED.ttsListen) { FEED.ttsListen = true; speechSynthesis.addEventListener('voiceschanged', () => refreshFeedSettings()); }
  const auto = list[0];
  return `
    <div class="settings-row">
      <label class="settings-lbl" for="set-tts-voice" style="display:block">Voce di "Ascolta"</label>
      ${list.length ? `<select class="form-select" id="set-tts-voice" onchange="setFeedTtsVoice(this.value)">
        <option value=""${pick ? '' : ' selected'}>Automatica${auto ? ' · ' + escFeed(auto.name) : ''}</option>
        ${list.map(v => `<option value="${escFeed(v.voiceURI)}"${v.voiceURI === pick ? ' selected' : ''}>${escFeed(v.name)}</option>`).join('')}
      </select>
      <div class="settings-val" style="margin-top:8px">${plural(list.length, 'voce italiana', 'voci italiane')} su questo dispositivo</div>` : '<div class="settings-val">Nessuna voce italiana trovata su questo dispositivo.</div>'}
      <div class="form-btns" style="margin-top:10px">${list.length ? '<button class="btn-sec" onclick="testFeedTtsVoice()">▶ Prova</button>' : ''}<button class="btn-sec" onclick="refreshTtsVoices()">↻ Aggiorna elenco</button></div>
      <div class="feed-hint" style="margin-top:8px">Le voci migliori vanno scaricate: su iPhone Impostazioni → Accessibilità → Contenuti letti → Voci → Italiano → scegli una voce "Migliorata" o "Premium" (es. Alice, Federica, Luca). Poi riapri DayFlow e selezionala qui.</div>
    </div>`;
}
function toggleArticleSpeech() { if (FEED.tts) stopArticleSpeech(); else startArticleSpeech(); }
function startArticleSpeech() {
  const c = FEED.card, a = c && c.fullArticle;
  if (!a || !ttsSupported()) return;
  stopArticleSpeech(false);
  const parts = [a.title, ...(a.tldr && a.tldr.length ? ['In breve.', ...a.tldr] : []), ...a.sections.flatMap(s => [s.heading, ...s.paragraphs])]
    .map(x => String(x || '').trim()).filter(Boolean);
  if (!parts.length) return;
  const voice = ttsVoice();
  const tts = { id: c.id };
  FEED.tts = tts;
  const done = () => { if (FEED.tts === tts) { FEED.tts = null; updateArticleTools(); } };
  parts.forEach((txt, i) => {
    const u = new SpeechSynthesisUtterance(txt);
    u.lang = 'it-IT';
    if (voice) u.voice = voice;
    if (i === parts.length - 1) u.onend = done;
    u.onerror = e => { if (e && (e.error === 'interrupted' || e.error === 'canceled')) return; done(); };
    speechSynthesis.speak(u);
  });
  updateArticleTools();
}
function stopArticleSpeech(update = true) {
  const had = FEED.tts;
  FEED.tts = null;
  if (had && ttsSupported()) { try { speechSynthesis.cancel(); } catch (e) { } }
  if (had && update) updateArticleTools();
}
function renderFeedArticle(b) {
  const c = FEED.card; if (!c) { b.innerHTML = ''; return; }
  const t = feedTopic(c.topicId);
  const srcs = feedCardSources(c);
  const meta = `<div class="feed-meta">${feedSourceHTML(c)}${srcs.length >= 2 ? `<span class="feed-meta-dot"></span><span class="feed-nsrc">${srcs.length} fonti</span>` : ''}<span class="feed-meta-dot"></span><span>${escFeed(feedRelTime(c))}</span><span class="feed-meta-dot"></span><span>${escFeed(t.label)}</span></div>`;
  // Stesso fatto da più testate: elenco delle fonti (link se c'è)
  const srcList = srcs.length >= 2 ? `<div class="art-srcs"><span class="art-srcs-h">Fonti</span>${srcs.map(x => x.url ? `<a href="${escFeed(x.url)}" target="_blank" rel="noopener noreferrer">${escFeed(x.domain || x.name)} ↗</a>` : `<span>${escFeed(x.domain || x.name)}</span>`).join('')}</div>` : '';
  const tools = `<div class="art-tools" id="fart-tools">${articleToolsInner(c)}</div>`;
  if (c.db && cloudOn() && !FEED.follows && !FEED.followsLoading) loadFeedFollows().then(updateArticleTools, () => { });
  const head = `<h2>${escFeed(c.fullArticle ? c.fullArticle.title : c.title)}</h2>${meta}${tools}${srcList}`;
  if (c.fullArticle) {
    const a = c.fullArticle;
    b.innerHTML = `<div class="article">${head}${feedTldrHTML(a.tldr)}${a.sections.map(s => `${s.heading ? `<h3>${escFeed(s.heading)}</h3>` : ''}${s.paragraphs.map(p => `<p>${escFeed(p)}</p>`).join('')}`).join('')}<div class="feed-disclaimer">${escFeed(feedArticleDisclaimer(c))}</div></div>`;
    return;
  }
  const st = FEED.articleStream;
  if (st && st.id === c.id) {
    // Struttura statica; il testo arriva via paintArticleStream (render sincrono dello stato già ricevuto)
    b.innerHTML = `<div class="article" id="fart" data-id="${escFeed(c.id)}"><h2>${escFeed(c.title)}</h2>${meta}${tools}${srcList}<div class="art-tldr" hidden><div class="art-tldr-h">In 30 secondi</div><ul></ul></div><div class="art-body"></div><div class="art-sk"><div class="sk-line w90"></div><div class="sk-line w90"></div><div class="sk-line w70"></div><div class="sk-line w40" style="margin-top:10px"></div><div class="sk-line w90"></div><div class="sk-line w70"></div></div><div class="feed-meta art-status"><div class="feed-spinner"></div><span>Gemini sta scrivendo…</span></div></div>`;
    st.els = [];
    paintArticleStream(st, false);
    return;
  }
  const partial = FEED.articlePartial && FEED.articlePartial.id === c.id ? parseArticleText(FEED.articlePartial.text, true) : null;
  const partialHtml = partial && partial.blocks.length ? partial.blocks.map(bl => `<${bl.tag}>${escFeed(bl.text)}</${bl.tag}>`).join('') : `<p>${escFeed(c.summary)}</p>`;
  const h2 = partial && partial.title ? partial.title : c.title;
  b.innerHTML = `<div class="article"><h2>${escFeed(h2)}</h2>${meta}${tools}${partial && partial.tldr.length ? feedTldrHTML(partial.tldr) : ''}${partialHtml}${c.articleError ? `<p style="color:var(--red)">${escFeed(c.articleError)}</p>` : ''}<div class="feed-actions"><button class="feed-btn pri" onclick="expandArticle('${escFeed(c.id)}')">↻ ${c.articleError ? 'Riprova' : "Genera l'articolo"}</button></div></div>`;
}

// Chat contestuale
function openFeedChat(id) {
  const card = feedCardById(id); if (!card) return;
  if (!FEED.card || FEED.card.id !== id) FEED.chat = [];
  recordFeedPref(card, 'chat');
  logFeedEvent(card, 'chat');
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
    const article = c.fullArticle ? '\n\nArticolo esteso:\n' + (c.fullArticle.tldr ? c.fullArticle.tldr.map(x => '- ' + x).join('\n') + '\n\n' : '') + c.fullArticle.sections.map(s => s.heading + '\n' + s.paragraphs.join('\n')).join('\n\n') : '';
    const url = feedSafeUrl(c.url);
    const system = `Sei l'assistente di DayFlow. Rispondi in italiano, in modo chiaro e conciso (massimo 120 parole), restando ancorato alla notizia seguente. Se non sai qualcosa, dillo. Non inventare citazioni di persone reali.\n\nNotizia: ${c.title}\nRiassunto: ${c.summary}\nFonte: ${c.source}${url ? `\nArticolo originale: ${url} (puoi leggerlo)` : ''}\nArgomento: ${feedTopic(c.topicId).label}${article}`;
    const contents = FEED.chat.map(m => ({ role: m.role, parts: [{ text: m.text }] }));
    const reply = await geminiText(contents, system, url ? [{ url_context: {} }] : null);
    FEED.chat.push({ role: 'model', text: reply });
  } catch (e) {
    console.error('sendFeedChat', e);
    FEED.chat.push({ role: 'model', text: '⚠ ' + feedErrorMessage(e) });
  }
  FEED.chatBusy = false;
  if (FEED.sheet === 'chat') renderFeedSheet();
}

// Argomenti
// Ogni argomento si modifica con ✎ (nome, emoji, focus, esclusioni, area, livello); "Crea da una frase"
// chiede a Gemini (via proxy, senza strumenti, responseSchema) un argomento già compilato da confermare.
function feedAreaLabel(id) { const a = FEED_AREAS.find(x => x.id === id); return a ? a.label : 'Misto'; }
function feedTopicSummary(t) {
  const bits = [];
  if (t.focus) bits.push('Focus: ' + t.focus);
  if (t.exclude) bits.push('Escludi: ' + t.exclude);
  if (t.area) bits.push('Area: ' + feedAreaLabel(t.area));
  if (t.level === 'tecnico') bits.push('Tecnico');
  return bits.join(' · ');
}
function renderFeedTopicsSheet(b) {
  const ai = feedAIReady();
  const busy = FEED.topicPhraseBusy;
  b.innerHTML = `
    <div class="feed-hint" style="margin-bottom:14px">Il feed viene generato sugli argomenti attivi. Con ✎ scegli focus, esclusioni, area e livello: valgono dalle prossime notizie.</div>
    ${FEED.topics.map(t => `<div class="topic-row" style="--tc:${escFeed(t.color)}"><div class="t-emoji">${escFeed(t.emoji)}</div><div class="t-name"><div>${escFeed(t.label)}</div>${feedTopicSummary(t) ? `<div class="t-sub">${escFeed(feedTopicSummary(t))}</div>` : ''}</div><div class="topic-acts"><button class="topic-edit" onclick="editFeedTopic('${escFeed(t.id)}')" aria-label="Modifica ${escFeed(t.label)}" aria-expanded="${FEED.topicEdit === t.id}">✎</button><button class="topic-del" onclick="removeFeedTopic('${escFeed(t.id)}')" ${FEED.topics.length <= 1 ? 'disabled' : ''} aria-label="Rimuovi ${escFeed(t.label)}">×</button></div></div>${FEED.topicEdit === t.id ? feedTopicEditorHTML(t, false) : ''}`).join('')}
    ${FEED.topicEdit === '__new' && FEED.topicDraft ? feedTopicEditorHTML(FEED.topicDraft, true) : ''}
    <div class="topic-form">
      <input class="form-input emoji" id="topic-emoji" maxlength="4" placeholder="✦" aria-label="Emoji">
      <input class="form-input" id="topic-label" maxlength="24" placeholder="Nuovo argomento (es. Cinema)" onkeydown="if(event.key==='Enter') addFeedTopic()">
      <button class="btn-pri" onclick="addFeedTopic()">Aggiungi</button>
    </div>
    ${ai ? `<div class="topic-phrase">
      <label class="form-label" for="topic-phrase">Crea da una frase</label>
      <textarea class="form-input" id="topic-phrase" rows="2" maxlength="300" placeholder="Es. novità sulle auto elettriche in Europa, niente gossip sui manager"></textarea>
      <div class="form-btns" style="margin-top:8px"><button class="btn-sec" onclick="createFeedTopicFromPhrase()" ${busy ? 'disabled' : ''}>${busy ? 'Preparo l\'argomento…' : '✦ Prepara argomento'}</button></div>
    </div>` : ''}`;
}
function feedTopicEditorHTML(t, isNew) {
  const areaOpts = `<option value=""${!t.area ? ' selected' : ''}>Come generale (${escFeed(feedAreaLabel(feedSettings().area))})</option>`
    + FEED_AREAS.map(a => `<option value="${a.id}"${t.area === a.id ? ' selected' : ''}>${escFeed(a.label)}</option>`).join('');
  const levelOpts = FEED_LEVELS.map(l => `<option value="${l.id}"${(t.level || 'divulgativo') === l.id ? ' selected' : ''}>${escFeed(l.label)}</option>`).join('');
  return `<div class="topic-editor" id="topic-editor">
      ${isNew ? '<div class="settings-lbl">Nuovo argomento · controlla e conferma</div>' : ''}
      <div class="topic-form" style="margin-top:0">
        <input class="form-input emoji" id="te-emoji" maxlength="4" value="${escFeed(t.emoji)}" aria-label="Emoji">
        <input class="form-input" id="te-label" maxlength="24" value="${escFeed(t.label)}" aria-label="Nome dell'argomento">
      </div>
      <label class="form-label" for="te-focus">Focus</label>
      <textarea class="form-input" id="te-focus" rows="2" maxlength="${FEED_TOPIC_TXT_MAX}" placeholder="Cosa ti interessa di più (es. startup italiane, chip)">${escFeed(t.focus || '')}</textarea>
      <label class="form-label" for="te-exclude">Escludi</label>
      <textarea class="form-input" id="te-exclude" rows="2" maxlength="${FEED_TOPIC_TXT_MAX}" placeholder="Cosa non vuoi vedere (es. gossip, recensioni)">${escFeed(t.exclude || '')}</textarea>
      <div class="te-grid">
        <div><label class="form-label" for="te-area">Area</label><select class="form-select" id="te-area">${areaOpts}</select></div>
        <div><label class="form-label" for="te-level">Livello</label><select class="form-select" id="te-level">${levelOpts}</select></div>
      </div>
      <div class="form-btns" style="margin-top:14px">
        <button class="btn-sec" onclick="cancelFeedTopicEdit()">Annulla</button>
        <button class="btn-pri" onclick="saveFeedTopicEdit()">${isNew ? 'Aggiungi' : 'Salva'}</button>
      </div>
    </div>`;
}
function editFeedTopic(id) {
  FEED.topicEdit = FEED.topicEdit === id ? null : id;
  FEED.topicDraft = null;
  renderFeedSheet();
  const el = document.getElementById('topic-editor'); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function cancelFeedTopicEdit() { FEED.topicEdit = null; FEED.topicDraft = null; renderFeedSheet(); }
function readFeedTopicEditor() {
  const v = id => (document.getElementById(id)?.value || '');
  return { label: v('te-label').trim(), emoji: v('te-emoji').trim(), focus: v('te-focus'), exclude: v('te-exclude'), area: v('te-area') || null, level: v('te-level') };
}
function saveFeedTopicEdit() {
  const f = readFeedTopicEditor();
  if (!f.label) { showToast('Serve un nome per l\'argomento', 'warn'); return; }
  if (FEED.topicEdit === '__new') {
    if (addFeedTopicObj(Object.assign({}, FEED.topicDraft || {}, f))) { FEED.topicEdit = null; FEED.topicDraft = null; renderFeedSheet(); }
    return;
  }
  const i = FEED.topics.findIndex(t => t.id === FEED.topicEdit); if (i < 0) return;
  const old = FEED.topics[i];
  FEED.topics[i] = normalizeTopic(Object.assign({}, old, f, { emoji: f.emoji || old.emoji }), i);
  FEED.topicEdit = null;
  saveFeedTopics();
  renderFeedChips();
  if (curScreen === 'recap') renderFeed(); // nome/emoji nelle card
  renderFeedSheet();
  showToast('Argomento aggiornato: vale dalle prossime notizie', 'info', 2400);
}
async function createFeedTopicFromPhrase() {
  const phrase = (document.getElementById('topic-phrase')?.value || '').trim();
  if (!phrase) { showToast('Scrivi una frase sull\'argomento', 'warn'); return; }
  if (FEED.topicPhraseBusy) return;
  if (FEED.topics.length >= 10) { showToast('Massimo 10 argomenti', 'warn'); return; }
  FEED.topicPhraseBusy = true;
  if (FEED.sheet === 'topics') renderFeedSheet();
  const keep = document.getElementById('topic-phrase'); if (keep) keep.value = phrase;
  try {
    const schema = {
      type: 'OBJECT',
      properties: { label: { type: 'STRING' }, emoji: { type: 'STRING' }, focus: { type: 'STRING' }, exclude: { type: 'STRING' }, level: { type: 'STRING', enum: ['divulgativo', 'tecnico'] } },
      required: ['label', 'emoji', 'focus', 'exclude', 'level']
    };
    const prompt = `Un utente di un'app di notizie descrive con una frase un argomento da seguire:\n"${phrase.slice(0, 300)}"\n\nTrasformala in un argomento del feed:\n- "label": nome breve in italiano, 1-3 parole, massimo 24 caratteri.\n- "emoji": una sola emoji adatta.\n- "focus": cosa privilegiare, in una frase in italiano (massimo 250 caratteri).\n- "exclude": cosa escludere se l'utente lo dice, altrimenti "".\n- "level": "tecnico" se chiede dettagli per addetti ai lavori, altrimenti "divulgativo".`;
    const out = await geminiJSON(prompt, schema, 0.3);
    if (!out || !out.label) throw Object.assign(new Error('parse'), { code: 'parse' });
    FEED.topicDraft = normalizeTopic({ id: '__draft', label: out.label, emoji: out.emoji, focus: out.focus, exclude: out.exclude, level: out.level, area: null, color: '#8b8cf8' });
    FEED.topicEdit = '__new';
  } catch (e) {
    console.error('createFeedTopicFromPhrase', e);
    showToast(feedErrorMessage(e), 'error');
  }
  FEED.topicPhraseBusy = false;
  if (FEED.sheet === 'topics') {
    renderFeedSheet();
    const ta = document.getElementById('topic-phrase'); if (ta && !FEED.topicDraft) ta.value = phrase;
    const el = document.getElementById('topic-editor'); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}
function addFeedTopic() {
  const lbl = (document.getElementById('topic-label')?.value || '').trim();
  const emoji = (document.getElementById('topic-emoji')?.value || '').trim();
  if (!lbl) return;
  addFeedTopicObj({ label: lbl, emoji: emoji || '✦' });
}
// Nuovo argomento (campi facoltativi focus/exclude/area/level); false se non aggiunto.
function addFeedTopicObj(o) {
  const lbl = String(o.label || '').trim();
  if (!lbl) return false;
  if (FEED.topics.length >= 10) { showToast('Massimo 10 argomenti', 'warn'); return false; }
  let id = lbl.toLowerCase().replace(/[^a-z0-9àèéìòù]+/g, '-').replace(/^-|-$/g, '') || uid();
  if (FEED.topics.some(t => t.id === id)) id += '-' + Math.random().toString(36).slice(2, 5);
  const used = new Set(FEED.topics.map(t => t.color));
  const color = FEED_PALETTE.find(c => !used.has(c)) || FEED_PALETTE[FEED.topics.length % FEED_PALETTE.length];
  FEED.topics.push(normalizeTopic(Object.assign({}, o, { id, label: lbl, emoji: o.emoji || '✦', color })));
  const saved = afterFeedTopicsChange();
  // Nuovo argomento: la funzione prepara subito qualche notizia (dopo che il profilo è salvato,
  // perché legge gli argomenti da profiles.feed_topics).
  if (cloudOn()) Promise.resolve(saved).then(() => requestCloudMore(id)).catch(e => console.warn('nuovo argomento', e));
  return true;
}
function removeFeedTopic(id) {
  if (FEED.topics.length <= 1) return;
  FEED.topics = FEED.topics.filter(t => t.id !== id);
  if (FEED.activeTopic === id) FEED.activeTopic = 'all';
  afterFeedTopicsChange();
}
function afterFeedTopicsChange() {
  const saved = saveFeedTopics();
  if (FEED.data) { FEED.data.stale = true; saveFeedCache(); }
  renderFeedChips(); renderFeed();
  if (FEED.sheet === 'topics') renderFeedSheet();
  return saved;
}

// Impostazioni Discover: markup unico, renderizzabile in qualsiasi contenitore.
// Oggi l'unico contenitore è #settings-discover-body (pannello Impostazioni globale);
// le azioni (chiave, modello, cache, cronologia, interessi) ri-renderizzano con refreshFeedSettings().
function renderFeedSettings(b) {
  if (!b) return;
  // Il profilo dei gusti in modifica sopravvive ai re-render (caricamenti in background, altre azioni)
  const prev = document.getElementById('set-feed-profile');
  const keep = prev && prev.dataset.dirty ? { value: prev.value, focus: document.activeElement === prev } : null;
  b.innerHTML = feedSettingsHTML();
  if (keep) {
    const ta = document.getElementById('set-feed-profile');
    if (ta) { ta.value = keep.value; ta.dataset.dirty = '1'; if (keep.focus) ta.focus({ preventScroll: true }); }
  }
  // Dati del cloud (area, profilo, preferenze, storie seguite): ricaricati all'apertura, al massimo ogni 30 s
  if (cloudOn() && Date.now() - FEED.setFetchedAt > 30000) {
    FEED.setFetchedAt = Date.now();
    Promise.allSettled([syncFeedSettings(), loadFeedFollows(true)]).then(refreshFeedSettings);
  }
}
function refreshFeedSettings() { if (SETTINGS.open) renderFeedSettings(document.getElementById('settings-discover-body')); }
function feedSettingsHTML() {
  const key = feedKey();
  const masked = key ? key.slice(0, 6) + '••••••••' + key.slice(-4) : '';
  const seen = loadFeedSeen();
  const prefs = loadFeedPrefs();
  const cloud = cloudOn();
  const left = FEED.pool ? feedPoolLeft(null).length : 0;
  const cloudRow = cloud ? `
    <div class="settings-row">
      <div class="settings-lbl">Notizie dal cloud</div>
      <div class="settings-val">${FEED.pool ? `${FEED.pool.length} nelle ultime 72 ore · ${left} ancora da vedere` : 'Non ancora caricate: apri Discover'}</div>
      <div class="feed-hint" style="margin-top:6px">Ogni mattina alle 6 il cloud cerca notizie vere sui tuoi argomenti; quando stanno per finire ne prepara altre. L'ordine segue quello che apri.${feedEvQ().length ? ` · ${feedEvQ().length} interazioni in attesa di invio` : ''}</div>
    </div>` : '';
  return `${cloudRow}${cloud ? feedCloudSettingsHTML() : ''}${ttsSettingsHTML()}
    <div class="settings-row">
      <div class="settings-lbl">${cloud ? 'Chiave API Gemini locale (facoltativa)' : 'Chiave API Gemini'}</div>
      <div class="settings-val">${key ? escFeed(masked) : cloud ? 'Nessuna · Discover usa la chiave nel cloud' : 'Nessuna chiave salvata'}</div>
      <div class="feed-key-wrap">
        <input class="form-input" id="settings-key-input" type="password" placeholder="${key ? 'Incolla una nuova chiave per sostituirla' : 'AIza…'}" autocomplete="off" spellcheck="false" onkeydown="if(event.key==='Enter') saveFeedKey('settings-key-input')">
        <button class="feed-eye" type="button" onclick="toggleFeedKeyVis('settings-key-input')" aria-label="Mostra chiave"><svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
      </div>
      <div class="form-btns" style="margin-top:10px">
        <button class="btn-pri" onclick="saveFeedKey('settings-key-input')">Salva chiave</button>
        ${key ? '<button class="btn-del" onclick="removeFeedKey()">Rimuovi</button>' : ''}
      </div>
      <div class="feed-hint" style="margin-top:10px">${cloud ? "Con l'account DayFlow notizie, approfondimenti e chat passano dal cloud (Supabase): la chiave Gemini resta nei suoi segreti e non arriva su questo dispositivo. Una chiave locale serve solo come riserva se il cloud non risponde: se non ti serve, rimuovila." : 'La chiave resta solo in questo browser (localStorage) e non viene mai inviata a DayFlow o Supabase.'} <a class="feed-link" href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer">Google AI Studio →</a></div>
    </div>
    <div class="settings-row">
      <div class="settings-lbl">Modello</div>
      ${renderFeedModelPicker(feedAIReady())}
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
      <div class="settings-lbl">${cloud ? 'Cronologia locale (72h, solo generazione di riserva)' : 'Cronologia (72h)'}</div>
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
// Righe cloud delle impostazioni Discover: area generale, profilo dei gusti, preferenze, storie seguite.
function feedCloudSettingsHTML() {
  const fs = feedSettings();
  const area = FEED_AREAS.some(a => a.id === fs.area) ? fs.area : 'misto';
  const pr = feedPrefs();
  const when = fs.profileAt && !isNaN(Date.parse(fs.profileAt)) ? new Date(fs.profileAt).toLocaleDateString('it-IT', { day: 'numeric', month: 'long' }) : '';
  const profMeta = !fs.profile ? 'Ancora nessun profilo: si crea da solo quando avrai reagito ad almeno 5 notizie, oppure scrivilo tu.'
    : fs.profileManual ? `Scritto da te${when ? ' il ' + when : ''}: non viene rigenerato in automatico. "Rigenera" torna a quello automatico.`
      : `Generato automaticamente${when ? ' il ' + when : ''} dalle tue reazioni; si aggiorna ogni settimana finché non lo modifichi.`;
  const topicLbl = id => { const t = FEED.topics.find(x => x.id === id); return t ? t.label : id; };
  const subLbl = v => { const i = v.indexOf(':'); return i > 0 ? `${topicLbl(v.slice(0, i))} · ${v.slice(i + 1)}` : v; };
  const prefList = (list, key, fmt) => list.length
    ? `<div class="pref-list">${list.map((v, i) => `<div class="pref-row"><span class="pref-txt">${escFeed(fmt(v))}</span><button class="topic-del pref-del" onclick="removeFeedPref('${key}', ${i})" aria-label="Rimuovi ${escFeed(fmt(v))}">×</button></div>`).join('')}</div>`
    : '<div class="settings-val pref-empty">Nessuna</div>';
  const follows = FEED.follows || [];
  const followHTML = FEED.follows == null ? '<div class="settings-val">Caricamento…</div>'
    : FEED.followsErr && !follows.length ? '<div class="settings-val">Non disponibili (serve lo SQL 04 su Supabase).</div>'
      : !follows.length ? '<div class="settings-val">Nessuna storia seguita. Tocca 👍 su una notizia e scegli "Segui la storia".</div>'
        : follows.map((f, i) => {
          const until = f.until ? new Date(f.until).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }) : '';
          return `<div class="follow-row"><div class="follow-txt"><div class="follow-title">${escFeed(f.title)}</div><div class="feed-hint">${escFeed(topicLbl(f.topic_id))}${until ? ' · fino al ' + escFeed(until) : ''}${f.updates ? ' · ' + plural(f.updates, 'aggiornamento', 'aggiornamenti') : ''}</div></div><button class="btn-sec follow-stop" onclick="unfollowFeedStory(${i})">Smetti di seguire</button></div>`;
        }).join('');
  return `
    <div class="settings-row">
      <label class="settings-lbl" for="set-feed-area" style="display:block">Area geografica</label>
      <select class="form-select" id="set-feed-area" onchange="setFeedArea(this.value)">${FEED_AREAS.map(a => `<option value="${a.id}"${a.id === area ? ' selected' : ''}>${escFeed(a.label)}${a.note ? ' · ' + escFeed(a.note) : ''}</option>`).join('')}</select>
      <div class="feed-hint" style="margin-top:8px">Vale per tutti gli argomenti, tranne quelli con un'area propria (Argomenti → ✎).</div>
    </div>
    <div class="settings-row">
      <label class="settings-lbl" for="set-feed-profile" style="display:block">Profilo dei gusti</label>
      <textarea class="form-input feed-profile" id="set-feed-profile" rows="5" maxlength="${FEED_PROFILE_MAX}" placeholder="Es. Mi interessano le startup italiane e i chip; poco sport minore, niente gossip." oninput="this.dataset.dirty='1'">${escFeed(fs.profile || '')}</textarea>
      <div class="feed-hint" style="margin-top:8px">${escFeed(profMeta)}</div>
      <div class="form-btns" style="margin-top:10px">
        <button class="btn-pri" onclick="saveFeedProfile()">Salva</button>
        <button class="btn-sec" onclick="regenFeedProfile()" ${FEED.profileBusy ? 'disabled' : ''}>${FEED.profileBusy ? 'Rigenero…' : '↻ Rigenera'}</button>
      </div>
    </div>
    <div class="settings-row">
      <div class="settings-lbl">Preferenze da 👍 / 👎</div>
      <div class="pref-h">Di più su</div>${prefList(pr.moreSub, 'moreSub', subLbl)}
      <div class="pref-h">Meno su</div>${prefList(pr.lessSub, 'lessSub', subLbl)}
      <div class="pref-h">Fonti bloccate</div>${prefList(pr.blockedSources, 'blockedSources', v => v)}
    </div>
    <div class="settings-row">
      <div class="settings-lbl">Storie seguite</div>
      ${followHTML}
      <div class="feed-hint" style="margin-top:8px">Per 14 giorni il cloud cerca ogni mattina le novità: arrivano nel feed col badge "↻ Aggiornamento".</div>
    </div>`;
}
function setFeedArea(v) {
  if (!FEED_AREAS.some(a => a.id === v)) return;
  changeFeedSettings([{ k: 'area', v }]);
  showToast('Area: ' + feedAreaLabel(v) + ' · vale dalle prossime notizie', 'info', 2200);
  refreshFeedSettings();
}
function saveFeedProfile() {
  const ta = document.getElementById('set-feed-profile');
  const text = (ta ? ta.value : '').trim().slice(0, FEED_PROFILE_MAX);
  // Profilo svuotato = torna a quello automatico
  changeFeedSettings([{ k: 'profile', v: text }, { k: 'profileManual', v: !!text }, { k: 'profileAt', v: new Date().toISOString() }]);
  if (ta) delete ta.dataset.dirty;
  showToast(text ? 'Profilo salvato' : 'Profilo svuotato: tornerà quello automatico', 'info', 2200);
  refreshFeedSettings();
}
async function regenFeedProfile() {
  if (!cloudOn() || FEED.profileBusy) return;
  FEED.profileBusy = true;
  const ta = document.getElementById('set-feed-profile'); if (ta) delete ta.dataset.dirty;
  refreshFeedSettings();
  try {
    const res = await feedFnFetch({ mode: 'profile' });
    if (!res.ok) throw await feedHttpError(res);
    let j = null; try { j = await res.json(); } catch (e) { }
    if (!j || typeof j.profile !== 'string') throw Object.assign(new Error('parse'), { code: 'parse' });
    // La funzione ha già scritto il profilo in feed_settings: aggiorno solo la copia locale
    const st = feedSetStore();
    st.s = Object.assign({}, st.s, { profile: j.profile, profileAt: j.profileAt || new Date().toISOString(), profileManual: false });
    st.ops = st.ops.filter(op => !(op && ['profile', 'profileAt', 'profileManual'].includes(op.k)));
    saveFeedSetStore();
    showToast('Profilo rigenerato', 'info', 2000);
  } catch (e) {
    console.warn('regenFeedProfile', e);
    showToast(feedErrorMessage(e), e.detail === 'dayflow-few-signals' ? 'warn' : 'error');
  } finally {
    FEED.profileBusy = false;
    refreshFeedSettings();
  }
}
function removeFeedPref(list, i) {
  const v = feedPrefs()[list] && feedPrefs()[list][i];
  if (!v) return;
  changeFeedSettings([{ list, del: v }]);
  refreshFeedSettings();
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
function renderFeedModelPicker(ready) {
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
        <button class="btn-sec" onclick="fetchGeminiModels()" ${ready && !FEED.modelsLoading ? '' : 'disabled'}>${FEED.modelsLoading ? 'Caricamento…' : 'Carica modelli dalla chiave'}</button>
      </div>
      <div class="topic-form">
        <input class="form-input" id="settings-model-input" type="text" placeholder="Altro modello (es. gemini-2.5-flash)" autocomplete="off" autocapitalize="off" spellcheck="false" onkeydown="if(event.key==='Enter') setFeedModelFromInput()">
        <button class="btn-pri" onclick="setFeedModelFromInput()">Usa</button>
      </div>
      <div class="feed-hint" style="margin-top:10px">${cloudOn() ? 'Vale per approfondimenti e chat. Le notizie del mattino usano il modello impostato nel cloud (segreto GEMINI_MODEL).' : 'Vale per feed, articoli e chat. Il feed attuale resta: trascinalo verso il basso per rigenerarlo col nuovo modello.'}</div>`;
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
  if (!feedAIReady()) { showToast(feedErrorMessage({ code: 'nokey' }), 'error'); return; }
  if (FEED.modelsLoading) return;
  FEED.modelsLoading = true;
  refreshFeedSettings();
  try {
    const all = [];
    let token = '';
    if (cloudOn()) { // elenco dalla chiave del cloud
      const res = await feedFnFetch({ mode: 'models' });
      if (!res.ok) throw await feedHttpError(res);
      let j; try { j = await res.json(); } catch (e) { throw Object.assign(new Error('parse'), { code: 'parse' }); }
      all.push(...(j.models || []));
    }
    for (let page = 0; page < 5 && !cloudOn(); page++) { // la chiave va solo nell'header, mai nell'URL
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

export {
  FEED, FEED_TOPICS_LS, setDiscoverHooks, escFeed, normalizeTopic, renderDiscover, renderFeedSettings,
  addFeedTopic, clearFeedCache, clearFeedPrefs, clearFeedSeen, closeFeedSheet, expandArticle, feedSheetOverlayClick, fetchGeminiModels,
  feedSourceClick, generateFeed, loadMoreFeed, openFeedChat, openFeedSheet, regenerateFeed, removeFeedKey, removeFeedTopic, saveFeedKey, sendFeedChat,
  setFeedModel, setFeedModelFromInput, setFeedTopic, shareFeedCard, switchFeedSheet, toggleFeedKeyVis, toggleFeedSaved,
  // fase 4
  voteFeedCard, feedVoteAction, toggleFollowFeedStory, unfollowFeedStory, toggleArticleSpeech,
  editFeedTopic, cancelFeedTopicEdit, saveFeedTopicEdit, createFeedTopicFromPhrase,
  setFeedArea, saveFeedProfile, regenFeedProfile, removeFeedPref, setFeedTtsVoice, testFeedTtsVoice, refreshTtsVoices,
  // test
  parseArticleText, articleFromBlocks, applyFeedSettingsOps
};
