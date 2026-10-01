import { showToast } from './utils.js';
import { FEED, TTSC, cloudOn, feedAbortErr, feedFnFetch, feedHttpError, updateArticleTools } from './discover-state.js';
import { feedErrorMessage } from './discover-gemini.js';

// Discover — "Ascolta": voce del cloud (Google Cloud TTS via Edge Function) e voce del dispositivo
// (speechSynthesis). Le impostazioni della voce sono in discover-settings.js (ttsSettingsHTML).
const FEED_TTS_VOICE_LS = 'dayflow_tts_voice'; // voiceURI della voce scelta per Ascolta (solo locale)
const FEED_TTS_ENGINE_LS = 'dayflow_tts_engine';           // 'cloud' | 'device' (default: cloud se loggato)
const FEED_TTS_CLOUD_VOICE_LS = 'dayflow_tts_cloud_voice'; // voce Chirp 3 HD scelta ('' = automatica)
const TTS_CLOUD_VOICE_RE = /^it-IT-[A-Za-z0-9-]+$/;       // stessa regola della Edge Function
const TTS_CHUNK_MAX = 1500;                                // caratteri per richiesta al cloud
const TTS_PREFETCH = 2;                                    // pezzi scaricati in anticipo

// ── Ascolta (speechSynthesis) ──
// Una utterance per blocco (sottotitoli e paragrafi), tutte in coda subito:
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

// ── Ascolta: motore ──
// 'cloud' = Google Cloud Text-to-Speech (voci Chirp 3 HD) tramite la Edge Function (mode 'tts'),
// 'device' = speechSynthesis. Default: cloud se loggato. Il cloud non è disponibile da non loggati;
// la voce del dispositivo resta la riserva quando il cloud fallisce.
function ttsEngine() {
  let e = '';
  try { e = localStorage.getItem(FEED_TTS_ENGINE_LS) || ''; } catch (x) { }
  if (!cloudOn()) return 'device';
  if (e === 'device' && ttsSupported()) return 'device';
  return 'cloud';
}
function ttsCloudVoice() {
  let v = '';
  try { v = localStorage.getItem(FEED_TTS_CLOUD_VOICE_LS) || ''; } catch (e) { }
  if (!TTS_CLOUD_VOICE_RE.test(v)) return '';
  // voce non più nell'elenco del cloud → automatica
  if (TTSC.voices && TTSC.voices.list && TTSC.voices.list.length && !TTSC.voices.list.some(x => x.name === v)) return '';
  return v;
}
async function loadTtsCloudVoices() {
  if (TTSC.voicesLoading) return TTSC.voicesLoading;
  const run = (async () => {
    try {
      const res = await feedFnFetch({ mode: 'tts-voices' });
      if (!res.ok) throw await feedHttpError(res);
      const j = await res.json();
      TTSC.voices = { at: Date.now(), list: Array.isArray(j.voices) ? j.voices.filter(x => x && TTS_CLOUD_VOICE_RE.test(x.name)) : [], def: j.defaultVoice || '', monthChars: typeof j.monthChars === 'number' ? j.monthChars : null, cap: j.cap || null };
    } catch (e) {
      TTSC.voices = { at: Date.now(), err: e.detail || e.code || 'errore', errObj: e };
    }
  })();
  TTSC.voicesLoading = run;
  try { await run; } finally { TTSC.voicesLoading = null; }
}

// ── Ascolta: testo → parti → pezzi ──
// Parti = sottotitoli e paragrafi: si parte dal corpo dell'articolo, senza titolo, "In breve" né
// riassunto della card. Si scartano anche, in testa al corpo, un sottotitolo uguale al titolo, una
// sezione "In breve / Riassunto / In sintesi", elenchi puntati o numerati e un paragrafo che ripete il
// riassunto della card (articoli scritti dal modello in formato diverso). Corpo vuoto → punti in breve.
const TTS_SUMMARY_HEAD = /^(in breve|in 30 secondi|in sintesi|riassunto|sommario|punti chiave|tl;?dr)\b/i;
function ttsArticleParts(a, card) {
  const norm = x => String(x || '').replace(/\s+/g, ' ').trim();
  const key = x => norm(x).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const skip = new Set([key(a.title), key(card && card.title), key(card && card.summary)].filter(Boolean));
  const body = [];
  (a.sections || []).forEach(s => {
    const head = norm(s.heading);
    const paras = (s.paragraphs || []).map(norm).filter(Boolean);
    if (!body.length && head && TTS_SUMMARY_HEAD.test(head)) return; // sezione riassunto in testa
    if (head && !(body.length === 0 && skip.has(key(head)))) body.push(head);
    paras.forEach(p => {
      if (!body.length && (/^(\d+[.)]|[-•*])\s/.test(p) || skip.has(key(p)))) return;
      body.push(p);
    });
  });
  return body.length ? body : (a.tldr || []).map(norm).filter(Boolean);
}
// Velocità di lettura (1 = normale): voce del cloud via playbackRate (tono invariato), dispositivo via rate
const TTS_RATE = 1.3;
function ttsApplyRate(el) { try { el.preservesPitch = true; el.defaultPlaybackRate = TTS_RATE; el.playbackRate = TTS_RATE; } catch (e) { } }
// Un testo lungo diviso in pezzi ≤ max caratteri ai confini di frase (una frase più lunga di max
// si taglia a una virgola o a uno spazio). Il cloud rifiuta i pezzi oltre 1500 caratteri.
function ttsSplit(text, max = TTS_CHUNK_MAX) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  if (t.length <= max) return [t];
  const sents = t.match(/[^.!?…]+(?:[.!?…]+["'»”’)\]]*)?\s*|[.!?…]+\s*/g) || [t];
  const out = [];
  let cur = '';
  const flush = () => { if (cur) { out.push(cur); cur = ''; } };
  for (let s of sents) {
    s = s.trim(); if (!s) continue;
    while (s.length > max) {
      flush();
      let cut = s.lastIndexOf(', ', max - 1);
      let piece, rest;
      if (cut >= max / 2) { piece = s.slice(0, cut + 1); rest = s.slice(cut + 2); }
      else {
        cut = s.lastIndexOf(' ', max);
        if (cut > 0) { piece = s.slice(0, cut); rest = s.slice(cut + 1); }
        else { piece = s.slice(0, max); rest = s.slice(max); }
      }
      out.push(piece.trim()); s = rest.trim();
    }
    if (!s) continue;
    if (cur && cur.length + 1 + s.length > max) flush();
    cur = cur ? cur + ' ' + s : s;
  }
  flush();
  return out;
}
// [{ text, part }]: part = indice della parte, per ripartire da lì con la voce del dispositivo.
function ttsChunks(parts) { return parts.flatMap((p, i) => ttsSplit(p).map(text => ({ text, part: i }))); }

// ── Ascolta: riproduzione ──
function toggleArticleSpeech() {
  const t = FEED.tts;
  if (t && t.engine === 'cloud' && t.paused) { ttsResume(t); return; }
  if (t) stopArticleSpeech(); else startArticleSpeech();
}
function startArticleSpeech() {
  const c = FEED.card, a = c && c.fullArticle;
  if (!a) return;
  stopArticleSpeech(false);
  const parts = ttsArticleParts(a, c);
  if (!parts.length) return;
  const cloudOk = ttsEngine() === 'cloud' && !(TTSC.skipUntil > Date.now());
  if (cloudOk) startCloudSpeech(c, parts);
  else if (ttsSupported()) startDeviceSpeech(c, parts, 0);
  else if (cloudOn()) startCloudSpeech(c, parts); // niente voce del dispositivo: si riprova il cloud
}
// Voce del dispositivo: una utterance per parte, tutte in coda subito (su iOS solo la prima deve
// partire da un tocco). from = prima parte da leggere (ripresa dopo un errore del cloud).
function startDeviceSpeech(c, parts, from) {
  const list = parts.slice(from || 0);
  if (!list.length || !ttsSupported()) return;
  const voice = ttsVoice();
  const tts = { id: c.id, engine: 'device' };
  FEED.tts = tts;
  const done = () => { if (FEED.tts === tts) { FEED.tts = null; updateArticleTools(); } };
  list.forEach((txt, i) => {
    const u = new SpeechSynthesisUtterance(txt);
    u.lang = 'it-IT';
    u.rate = TTS_RATE;
    if (voice) u.voice = voice;
    if (i === list.length - 1) u.onend = done;
    u.onerror = e => { if (e && (e.error === 'interrupted' || e.error === 'canceled')) return; done(); };
    speechSynthesis.speak(u);
  });
  updateArticleTools();
}
// MP3 muto di 3 frame (MPEG-1 Layer III, 32 kbps, 44,1 kHz, mono, dati a zero) per lo sblocco iOS.
function ttsSilentSrc() {
  if (!TTSC.silent) {
    const b = new Uint8Array(312);
    for (let k = 0; k < 3; k++) b.set([0xFF, 0xFB, 0x10, 0xC4], k * 104);
    TTSC.silent = 'data:audio/mpeg;base64,' + btoa(String.fromCharCode.apply(null, b));
  }
  return TTSC.silent;
}
function ttsAudio() {
  if (!TTSC.audio) { TTSC.audio = new Audio(); TTSC.audio.preload = 'auto'; }
  return TTSC.audio;
}
// Da chiamare DENTRO il tocco (prima di qualunque await): su iOS un play() partito dal gesto
// sblocca l'elemento audio, così i play() successivi (dopo il fetch) sono permessi. Sblocca anche
// speechSynthesis, che serve se il cloud fallisce e si passa alla voce del dispositivo.
function ttsUnlock() {
  const el = ttsAudio();
  try { el.onended = null; el.onerror = null; el.src = ttsSilentSrc(); const p = el.play(); if (p && p.catch) p.catch(() => { }); } catch (e) { }
  if (ttsSupported() && !TTSC.speechUnlocked) {
    TTSC.speechUnlocked = true;
    try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch (e) { }
  }
}
function ttsB64Blob(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Blob([u8], { type: 'audio/mpeg' });
}
async function ttsSynth(text, voice, signal) {
  const res = await feedFnFetch({ mode: 'tts', text, voice: voice || undefined }, signal);
  if (!res.ok) throw await feedHttpError(res);
  let j = null;
  try { j = await res.json(); } catch (e) { throw signal && signal.aborted ? feedAbortErr() : Object.assign(new Error('network'), { code: 'network' }); }
  if (!j || typeof j.audio !== 'string' || !j.audio) throw Object.assign(new Error('empty'), { code: 'empty' });
  return ttsB64Blob(j.audio);
}
function startCloudSpeech(c, parts) {
  const voice = ttsCloudVoice();
  const key = c.id + '|' + voice;
  // cache della sessione: Stop → Ascolta sullo stesso articolo (e stessa voce) non ripaga i caratteri
  if (TTSC.cacheKey !== key) { TTSC.cacheKey = key; TTSC.blobs = new Map(); }
  const tts = { id: c.id, engine: 'cloud', card: c, parts, chunks: ttsChunks(parts), voice, key, i: 0, loading: true, paused: false, url: '', fetches: new Map(), ctrls: new Set() };
  FEED.tts = tts;
  ttsUnlock();
  ttsMediaSession(c, tts);
  updateArticleTools();
  ttsPlayChunk(tts, 0);
}
function ttsFetchChunk(tts, i) {
  if (TTSC.cacheKey === tts.key && TTSC.blobs.has(i)) return Promise.resolve(TTSC.blobs.get(i));
  if (tts.fetches.has(i)) return tts.fetches.get(i);
  const ctrl = new AbortController();
  tts.ctrls.add(ctrl);
  const p = ttsSynth(tts.chunks[i].text, tts.voice, ctrl.signal).then(blob => {
    if (TTSC.cacheKey === tts.key) TTSC.blobs.set(i, blob);
    return blob;
  });
  p.then(() => tts.ctrls.delete(ctrl), () => tts.ctrls.delete(ctrl));
  tts.fetches.set(i, p);
  return p;
}
async function ttsPlayChunk(tts, i) {
  if (FEED.tts !== tts) return;
  if (i >= tts.chunks.length) { ttsFinish(tts); return; }
  tts.i = i;
  const cached = TTSC.cacheKey === tts.key && TTSC.blobs.has(i);
  const cur = ttsFetchChunk(tts, i);
  // prefetch dei 2 pezzi successivi mentre questo si scarica / suona
  for (let k = 1; k <= TTS_PREFETCH; k++) if (i + k < tts.chunks.length) ttsFetchChunk(tts, i + k).catch(() => { });
  if (!cached && !tts.loading) { tts.loading = true; updateArticleTools(); }
  let blob;
  try { blob = await cur; }
  catch (e) { if (FEED.tts === tts) ttsCloudFail(tts, e); return; }
  if (FEED.tts !== tts) return;
  const el = ttsAudio();
  ttsRevoke(tts);
  tts.url = URL.createObjectURL(blob);
  el.onended = () => { if (FEED.tts === tts && tts.i === i) ttsPlayChunk(tts, i + 1); };
  el.onerror = () => { if (FEED.tts === tts && tts.i === i) ttsCloudFail(tts, Object.assign(new Error('decode'), { code: 'decode' })); };
  el.src = tts.url;
  ttsApplyRate(el);
  if (tts.loading) { tts.loading = false; updateArticleTools(); }
  try { await el.play(); ttsSetPlaybackState('playing'); }
  catch (e) {
    if (FEED.tts !== tts || tts.i !== i) return;
    if (e && e.name === 'AbortError') return; // src cambiato nel frattempo
    // play() senza gesto rifiutato (autoplay): si aspetta un tocco su "Riprendi"
    tts.paused = true; ttsSetPlaybackState('paused'); updateArticleTools();
  }
}
function ttsPause(tts) {
  if (!tts || FEED.tts !== tts || tts.engine !== 'cloud') return;
  try { ttsAudio().pause(); } catch (e) { }
  tts.paused = true; ttsSetPlaybackState('paused'); updateArticleTools();
}
function ttsResume(tts) {
  if (!tts || FEED.tts !== tts || tts.engine !== 'cloud') return;
  tts.paused = false; updateArticleTools();
  if (!tts.url) { ttsPlayChunk(tts, tts.i); return; }
  const p = ttsAudio().play();
  ttsSetPlaybackState('playing');
  if (p && p.catch) p.catch(e => { if (FEED.tts === tts && !(e && e.name === 'AbortError')) { tts.paused = true; ttsSetPlaybackState('paused'); updateArticleTools(); } });
}
function ttsRevoke(tts) { if (tts.url) { try { URL.revokeObjectURL(tts.url); } catch (e) { } tts.url = ''; } }
// Ferma l'audio del cloud: fetch in corso annullate, elemento audio svuotato, blob URL revocato.
function ttsCloudCleanup(tts) {
  tts.ctrls.forEach(c => { try { c.abort(); } catch (e) { } });
  tts.ctrls.clear();
  const el = TTSC.audio;
  if (el) { el.onended = null; el.onerror = null; try { el.pause(); el.removeAttribute('src'); el.load(); } catch (e) { } }
  ttsRevoke(tts);
}
function ttsFinish(tts) {
  if (FEED.tts !== tts) return;
  FEED.tts = null;
  ttsCloudCleanup(tts);
  ttsMediaSessionClear();
  updateArticleTools();
}
// Errore del cloud: si continua dalla parte corrente con la voce del dispositivo (se c'è).
function ttsCloudFail(tts, e) {
  if (!e || e.code === 'abort' || FEED.tts !== tts) return;
  console.warn('Ascolta cloud', e);
  const part = (tts.chunks[tts.i] || { part: 0 }).part;
  FEED.tts = null;
  ttsCloudCleanup(tts);
  ttsMediaSessionClear();
  // quota finita o voce spenta nel cloud: per un po' si va diretti alla voce del dispositivo
  if (e.detail === 'dayflow-tts-quota' || e.detail === 'dayflow-tts-off') TTSC.skipUntil = Date.now() + 10 * 60000;
  const dev = ttsSupported();
  const msg = e.detail === 'dayflow-tts-quota' ? 'Quota voce del mese finita: uso la voce del dispositivo'
    : e.detail === 'dayflow-auth' || e.detail === 'dayflow-rate' ? feedErrorMessage(e)
      : (dev ? 'Voce del cloud non disponibile: uso la voce del dispositivo' : 'Voce del cloud non disponibile. Riprova tra poco.')
        + ' (' + (e.detail === 'dayflow-tts-off' ? 'manca la chiave nel cloud' : e.status ? e.status + (e.detail ? ': ' + String(e.detail).slice(0, 120) : '') : (e.message || e.code || 'errore')) + ')';
  showToast(msg, dev ? 'warn' : 'error', 7000);
  if (dev) startDeviceSpeech(tts.card, tts.parts, part);
  else updateArticleTools();
}
function ttsSetPlaybackState(s) { try { if (navigator.mediaSession) navigator.mediaSession.playbackState = s; } catch (e) { } }
// Schermata di blocco / centro di controllo: titolo dell'articolo, play/pausa/stop.
function ttsMediaSession(c, tts) {
  const ms = typeof navigator !== 'undefined' && navigator.mediaSession;
  if (!ms) return;
  try { if (typeof MediaMetadata === 'function') ms.metadata = new MediaMetadata({ title: (c.fullArticle && c.fullArticle.title) || c.title || 'Articolo', artist: 'DayFlow', album: 'Discover' }); } catch (e) { }
  const h = (a, fn) => { try { ms.setActionHandler(a, fn); } catch (e) { } };
  h('play', () => ttsResume(tts));
  h('pause', () => ttsPause(tts));
  h('stop', () => { if (FEED.tts === tts) stopArticleSpeech(); });
}
function ttsMediaSessionClear() {
  const ms = typeof navigator !== 'undefined' && navigator.mediaSession;
  if (!ms) return;
  ['play', 'pause', 'stop'].forEach(a => { try { ms.setActionHandler(a, null); } catch (e) { } });
  try { ms.metadata = null; ms.playbackState = 'none'; } catch (e) { }
}
function stopArticleSpeech(update = true) {
  const had = FEED.tts;
  FEED.tts = null;
  if (had && had.engine === 'cloud') { ttsCloudCleanup(had); ttsMediaSessionClear(); }
  if (had && ttsSupported()) { try { speechSynthesis.cancel(); } catch (e) { } }
  if (had && update) updateArticleTools();
}
// Un altro articolo aperto: via i pezzi audio in memoria di quello precedente.
function ttsDropCache(id) {
  if (TTSC.cacheKey && !TTSC.cacheKey.startsWith(id + '|')) { TTSC.cacheKey = ''; TTSC.blobs = new Map(); }
}

export {
  TTS_RATE, FEED_TTS_VOICE_LS, FEED_TTS_ENGINE_LS, FEED_TTS_CLOUD_VOICE_LS, TTS_CLOUD_VOICE_RE,
  ttsSupported, ttsItVoices, ttsVoice, ttsEngine, ttsCloudVoice, loadTtsCloudVoices,
  ttsUnlock, ttsSynth, ttsAudio, ttsApplyRate,
  toggleArticleSpeech, stopArticleSpeech, ttsDropCache,
  // test
  ttsSplit, ttsChunks, ttsArticleParts
};
