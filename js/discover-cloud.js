import { showToast } from './utils.js';
import { sb, curUser } from './state.js';
import { topicWeights, rankFeedItems, mergeNearDuplicates, feedCardSources, subtopicKey } from './feedrank.js';
import {
  FEED, FEED_CARDS_N, escFeed, feedTopic, feedSafeUrl, feedCardById, feedVisibleCards,
  cloudOn, feedFnFetch, feedHttpError, refreshFeedSettings, updateArticleTools
} from './discover-state.js';
import { fetchFeedCards } from './discover-gemini.js';

// Discover — notizie dal cloud (Supabase): pool di feed_items, ordinamento, richieste "more",
// registro interazioni (feed_events), impostazioni condivise (profiles.feed_settings), voti 👍/👎,
// storie seguite (feed_follows).
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
const FEED_SET_LS = 'dayflow_feed_settings';  // { uid, s: feed_settings, ops: [modifiche non ancora nel cloud] }

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
  if (f) f.addEventListener('click', feedDoubleTap);
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
  if (cur === v) {
    setFeedVote(id, ''); logFeedEvent(c, 'unvote'); paintFeedVote(id);
    if (v === 'up' && c.subtopic) { changeFeedSettings([{ list: 'moreSub', del: subtopicVal(c) }]); refreshFeedSettings(); }
    return;
  }
  setFeedVote(id, v);
  logFeedEvent(c, v);
  paintFeedVote(id);
  if (v === 'up') feedMoreLikeThis(c); else openFeedVotePop(c, v);
}
function subtopicVal(c) { return `${c.topicId}:${c.subtopic.trim()}`; }
// 👍: niente menu, solo "più notizie come questa" (il voto alza già il peso dell'argomento;
// con un sottotema lo si aggiunge anche a moreSub)
function feedMoreLikeThis(c) {
  if (c.subtopic) {
    const val = subtopicVal(c);
    changeFeedSettings([{ list: 'moreSub', add: val }, { list: 'lessSub', del: val }]);
    logFeedEvent(c, 'more');
    refreshFeedSettings();
  }
  showToast('Ti mostrerò più notizie come questa', 'info', 2000);
}
// Doppio tocco su una card del cloud = 👍 (mai toglie un voto già messo)
const FEED_DTAP_MS = 320;
function feedDoubleTap(e) {
  const t = e.target;
  if (!t || !t.closest || t.closest('button, a, input, textarea, select, .feed-vote-pop')) { FEED.lastTap = null; return; }
  const slide = t.closest('.feed-slide.card'); if (!slide) return;
  const id = slide.dataset.id, now = performance.now(), last = FEED.lastTap;
  if (!last || last.id !== id || now - last.t > FEED_DTAP_MS) { FEED.lastTap = { id, t: now }; return; }
  FEED.lastTap = null;
  try { const sel = window.getSelection && window.getSelection(); if (sel) sel.removeAllRanges(); } catch (err) { }
  const c = feedCardById(id); if (!c || !c.db) return;
  feedTapBurst(slide);
  if (feedVote(id) !== 'up') voteFeedCard(id, 'up');
}
function feedTapBurst(slide) {
  const card = slide.querySelector('.feed-card'); if (!card) return;
  const b = document.createElement('div');
  b.className = 'feed-tap-burst'; b.setAttribute('aria-hidden', 'true'); b.textContent = '👍';
  card.appendChild(b);
  setTimeout(() => b.remove(), 800);
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
    const val = subtopicVal(c);
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

export {
  cloudFeedCards, nextFeedCards, requestCloudMore, feedPoolLeft,
  feedEvQ, logFeedEvent, observeFeedViews, endAllFeedViews, initFeedEvents, feedSourceClick,
  feedSetStore, saveFeedSetStore, applyFeedSettingsOps, feedSettings, feedPrefs, changeFeedSettings, syncFeedSettings,
  feedVote, voteFeedCard, feedVoteAction,
  loadFeedFollows, feedFollowOf, unfollowFeedStory, toggleFollowFeedStory
};
