import { todayStr, showToast, setSS, fmtHeaderDate } from './utils.js';
import { curScreen, calcPct, updateTopProgressBar } from './state.js';
import { feedCardSources } from './feedrank.js';
import {
  FEED, FEED_CARDS_N, escFeed, feedTopic, loadFeedTopics, loadFeedCache, saveFeedCache,
  loadFeedSaved, persistFeedSaved, isFeedSaved, feedCardById, feedVisibleCards, feedSourceHTML,
  feedRelTime, feedSafeUrl, cloudOn, feedAIReady
} from './discover-state.js';
import { feedErrorMessage, fetchFeedCards } from './discover-gemini.js';
import { cloudFeedCards, nextFeedCards, logFeedEvent, initFeedEvents, endAllFeedViews, observeFeedViews, feedVote } from './discover-cloud.js';
import { openFeedSheet } from './discover-article.js';

// Discover — schermata del feed: render delle card e dei chip, pull-to-refresh, scroll infinito
// (observer + prefetch), generazione, salvati, condivisione. Stato in discover-state.js (FEED).
const FEED_PREFETCH_AHEAD = 3;              // card rimanenti davanti all'utente sotto cui parte il prefetch
const FEED_PTR_THRESHOLD = 72;              // px di trascinamento per aggiornare
const FEED_FIRST_N = 12;                    // card del primo caricamento dal cloud

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

// ── Salvati per dopo ──
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

export {
  renderDiscover, renderFeedChips, renderFeed, setFeedTopic, generateFeed, regenerateFeed, loadMoreFeed,
  toggleFeedSaved, shareFeedCard
};
