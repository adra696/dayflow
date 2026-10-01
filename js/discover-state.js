import { todayStr, uid } from './utils.js';
import { SUPA_URL, SUPA_KEY, sb, curUser, SETTINGS } from './state.js';
import { sbSaveFeedTopics } from './sync.js';

// Discover — stato condiviso e helper di base. È il modulo più in basso del Discover: tutti i
// discover-*.js lo importano, lui non importa nessuno di loro. FEED e TTSC vivono solo qui
// (si modificano le proprietà, mai riassegnati: niente setter).

// Dipendenze "verso l'alto" (discover-settings.js e discover-article.js importano questo modulo:
// importarle qui farebbe un ciclo). app.js le registra con setDiscoverHooks() all'avvio.
let renderFeedSettings, renderTtsSettings, articleToolsInner;
function setDiscoverHooks(h) { ({ renderFeedSettings, renderTtsSettings, articleToolsInner } = h); }

// Discover feed (Gemini) — stato e costanti comuni
const FEED_KEY_LS = 'dayflow_gemini_key';
const FEED_TOPICS_LS = 'dayflow_feed_topics';
const FEED_CARDS_N = 8;
const FEED_SAVED_LS = 'dayflow_feed_saved'; // notizie salvate "per dopo"
const FEED_PREFS_LS = 'dayflow_feed_prefs'; // interessi impliciti (articoli aperti / chat)
const FEED_PREFS_TTL = 14 * 24 * 60 * 60 * 1000;
const FEED_PREFS_MAX = 30;
// Notizie dal cloud (Supabase: tabella feed_items, Edge Function generate-feed)
const FEED_FN_PATH = '/functions/v1/generate-feed';
const FEED_AREAS = [
  { id: 'misto', label: 'Misto', note: 'italiane quando ci sono, altrimenti internazionali' },
  { id: 'italia', label: 'Italia', note: 'fonti e fatti italiani' },
  { id: 'europa', label: 'Europa', note: '' },
  { id: 'mondo', label: 'Mondo', note: 'fonti internazionali, anche in inglese' }
];
const FEED_TOPIC_TXT_MAX = 300;               // focus / esclusioni di un argomento
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
  follows: null, followsLoading: null, followsErr: null, profileBusy: false, topicEdit: null, topicDraft: null, topicPhraseBusy: false, tts: null, lastTap: null };
// Ascolta con la voce del cloud: elemento audio unico, pezzi dell'articolo aperto in memoria
// (cacheKey = "cardId|voce"), elenco voci + consumo del mese, prove per voce.
const TTSC = { audio: null, silent: '', speechUnlocked: false, cacheKey: '', blobs: new Map(), voices: null, voicesLoading: null, samples: new Map(), testSeq: 0, skipUntil: 0 };

// ── DISCOVER FEED (Gemini) ────────────────────────────────
function escFeed(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function feedKey() { try { return (localStorage.getItem(FEED_KEY_LS) || '').trim(); } catch (e) { return ''; } }
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
function feedCardById(id) { return (FEED.data && FEED.data.cards.find(c => c.id === id)) || loadFeedSaved().find(c => c.id === id) || null; }
// Card del feed coerenti con il filtro attivo (chip 'saved' escluso: non usa FEED.data).
function feedVisibleCards(topicId = FEED.activeTopic) {
  if (!FEED.data || topicId === 'saved') return [];
  return FEED.data.cards.filter(c => topicId === 'all' || c.topicId === topicId);
}
// Fonte: link all'articolo originale se c'è (notizie del cloud), altrimenti solo il nome
function feedSourceHTML(c) {
  const u = feedSafeUrl(c.url);
  return u ? `<a class="feed-src" href="${escFeed(u)}" target="_blank" rel="noopener noreferrer" onclick="feedSourceClick('${escFeed(c.id)}')">${escFeed(c.source)} ↗</a>` : `<span>${escFeed(c.source)}</span>`;
}
function feedAreaLabel(id) { const a = FEED_AREAS.find(x => x.id === id); return a ? a.label : 'Misto'; }

// Ridisegna la pagina Discover o Ascolta del pannello Impostazioni (solo quella visibile: le altre si
// ridisegnano quando si aprono) e i pulsanti sotto il titolo dell'articolo: chiamate da tutti i moduli
// Discover, le implementazioni arrivano dagli hook.
function refreshFeedSettings() {
  if (!SETTINGS.open) return;
  if (SETTINGS.page === 'discover') renderFeedSettings(document.getElementById('settings-discover-body'));
  else if (SETTINGS.page === 'ascolta') renderTtsSettings(document.getElementById('settings-tts-body'));
}
function updateArticleTools() {
  const el = document.getElementById('fart-tools');
  if (el && FEED.sheet === 'article') el.innerHTML = articleToolsInner(FEED.card);
}

export {
  setDiscoverHooks, refreshFeedSettings, updateArticleTools,
  FEED, TTSC, FEED_KEY_LS, FEED_TOPICS_LS, FEED_CARDS_N, FEED_PREFS_LS, FEED_AREAS, FEED_TOPIC_TXT_MAX, FEED_PALETTE,
  escFeed, feedKey, normalizeTopic, loadFeedTopics, saveFeedTopics, feedTopic, loadFeedCache, saveFeedCache,
  loadFeedSaved, persistFeedSaved, isFeedSaved, syncFeedSaved, loadFeedPrefs, recordFeedPref,
  feedRelTime, feedSafeUrl, cloudOn, feedAIReady, feedAbortErr, feedFnFetch, feedHttpError,
  feedCardById, feedVisibleCards, feedSourceHTML, feedAreaLabel
};
