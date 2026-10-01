import { sb } from './state.js';
import { feedCardSources } from './feedrank.js';
import {
  FEED, escFeed, feedTopic, feedSafeUrl, feedRelTime, feedSourceHTML, feedCardById,
  recordFeedPref, saveFeedCache, syncFeedSaved, cloudOn, updateArticleTools
} from './discover-state.js';
import { geminiThinkingConfig, geminiStream, geminiText, feedErrorMessage } from './discover-gemini.js';
import { logFeedEvent, feedFollowOf, loadFeedFollows } from './discover-cloud.js';
import { ttsSupported, stopArticleSpeech, ttsDropCache } from './discover-tts.js';

// Discover — foglio in basso (#feed-sheet): articolo esteso in streaming, chat contestuale,
// pulsanti Ascolta / Segui la storia. Il foglio Argomenti è disegnato da discover-topics.js.

// Dipendenze "verso l'alto" (settings.js e discover-topics.js importano già questo modulo):
// app.js le registra con setArticleHooks() all'avvio.
let openSettings, renderFeedTopicsSheet;
function setArticleHooks(h) { ({ openSettings, renderFeedTopicsSheet } = h); }

// ── Bottom sheet ──
function openFeedSheet(mode, card) {
  // Le impostazioni Discover vivono nel pannello Impostazioni globale (sezione Discover)
  if (mode === 'settings') { if (FEED.sheet) closeFeedSheet(); openSettings('discover'); return; }
  FEED.sheet = mode;
  if (card) { FEED.card = card; ttsDropCache(card.id); }
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
  if (c.fullArticle && (ttsSupported() || cloudOn())) {
    const t = FEED.tts && FEED.tts.id === c.id ? FEED.tts : null;
    if (t && t.paused) {
      out.push(`<button type="button" class="feed-btn sec art-tool on" onclick="toggleArticleSpeech()">▶ Riprendi</button>`);
      out.push(`<button type="button" class="feed-btn sec art-tool" onclick="stopArticleSpeech()">■ Stop</button>`);
    } else {
      const label = !t ? '🔊 Ascolta' : t.loading ? '⏳ Preparo l\'audio…' : '■ Stop';
      out.push(`<button type="button" class="feed-btn sec art-tool${t ? ' on' : ''}" aria-pressed="${!!t}"${t && t.loading ? ' aria-label="Preparo l\'audio, tocca per fermare"' : ''} onclick="toggleArticleSpeech()">${label}</button>`);
    }
  }
  if (c.db && cloudOn()) {
    const f = feedFollowOf(c.id);
    out.push(`<button type="button" class="feed-btn sec art-tool${f ? ' on' : ''}" aria-pressed="${!!f}" onclick="toggleFollowFeedStory('${escFeed(c.id)}')">${f ? '✓ Storia seguita' : '📌 Segui la storia'}</button>`);
  }
  return out.join('');
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

export {
  setArticleHooks, openFeedSheet, switchFeedSheet, closeFeedSheet, feedSheetOverlayClick, renderFeedSheet,
  expandArticle, articleToolsInner, openFeedChat, sendFeedChat,
  // test
  parseArticleText, articleFromBlocks
};
