import { uid, showToast } from './utils.js';
import { FEED, feedKey, feedTopic, loadFeedPrefs, cloudOn, feedAbortErr, feedFnFetch, feedHttpError, refreshFeedSettings } from './discover-state.js';

// Discover — trasporto Gemini (proxy nel cloud o chiave locale), streaming SSE, modello e thinking,
// messaggi d'errore, generazione del feed dal client (riserva) e memoria dei titoli già visti.
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/';
const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash';
const GEMINI_MODEL_LS = 'dayflow_gemini_model';    // modello scelto (solo locale)
const GEMINI_MODEL_RE = /^[a-z0-9][a-z0-9.\-]*$/i;
const FEED_SEEN_LS = 'dayflow_feed_seen';   // titoli già mostrati (dedupe)
const FEED_SEEN_TTL = 72 * 60 * 60 * 1000;  // memoria 72h
const FEED_SEEN_MAX = 80;                   // max titoli passati a Gemini

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

export {
  GEMINI_API, GEMINI_MODEL_LS, GEMINI_MODEL_RE, FEED_SEEN_LS,
  feedModel, geminiThinkingConfig, loadFeedSeen,
  geminiRequest, geminiStream, geminiJSON, geminiText, feedErrorMessage, fetchFeedCards
};
