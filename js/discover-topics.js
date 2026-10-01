import { uid, showToast } from './utils.js';
import { curScreen } from './state.js';
import {
  FEED, FEED_AREAS, FEED_TOPIC_TXT_MAX, FEED_PALETTE, escFeed, normalizeTopic, saveFeedTopics, saveFeedCache,
  feedAreaLabel, cloudOn, feedAIReady
} from './discover-state.js';
import { geminiJSON, feedErrorMessage } from './discover-gemini.js';
import { feedSettings, requestCloudMore } from './discover-cloud.js';
import { renderFeedSheet } from './discover-article.js';
import { renderFeedChips, renderFeed } from './discover.js';

// Discover — foglio Argomenti: elenco, editor (✎), aggiunta rapida, "Crea da una frase", rimozione.
const FEED_LEVELS = [{ id: 'divulgativo', label: 'Divulgativo' }, { id: 'tecnico', label: 'Tecnico' }];

// Argomenti
// Ogni argomento si modifica con ✎ (nome, emoji, focus, esclusioni, area, livello); "Crea da una frase"
// chiede a Gemini (via proxy, senza strumenti, responseSchema) un argomento già compilato da confermare.
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

export {
  renderFeedTopicsSheet, editFeedTopic, cancelFeedTopicEdit, saveFeedTopicEdit, createFeedTopicFromPhrase,
  addFeedTopic, removeFeedTopic
};
