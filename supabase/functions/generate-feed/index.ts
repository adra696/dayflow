// DayFlow · Edge Function "generate-feed"
// Genera notizie candidate VERE (Gemini + Google Search) e le scrive in public.feed_items.
//
// Due modi di chiamarla:
//  - cron del mattino: header x-cron-secret = FEED_CRON_SECRET, body { mode: 'morning', force? }.
//    Risponde subito 202 e lavora in background per ogni utente con argomenti salvati.
//    Senza force lavora solo se a Roma sono le 6 (il cron parte alle 4 e alle 5 UTC).
//  - dall'app: Authorization = JWT dell'utente, e nel body:
//    { mode: 'more', topicId? } → genera un gruppo più piccolo e restituisce le righe inserite
//      (limite MAX_MORE_PER_HOUR);
//    { mode: 'proxy', model?, stream?, request } → inoltra a Gemini (approfondimenti, chat), anche in
//      streaming SSE, con la chiave del cloud (limite MAX_PROXY_PER_HOUR);
//    { mode: 'models' } → elenco modelli Gemini disponibili per la chiave del cloud;
//    { mode: 'profile' } → rigenera il profilo dei gusti dagli eventi degli ultimi 30 giorni
//      (limite MAX_MORE_PER_HOUR): 200 { profile, profileAt } oppure
//      422 { error: 'dayflow-few-signals', signals } se ci sono meno di 5 segnali;
//    { mode: 'tts', text, voice? } → Google Cloud Text-to-Speech (voci Chirp 3 HD italiane) per
//      "Ascolta": 200 { audio: base64 MP3, chars, voice } (limite MAX_TTS_PER_HOUR a utente e
//      TTS_MONTH_CAP caratteri al mese per tutto il progetto);
//    { mode: 'tts-voices' } → { voices: [{ name, gender }], monthChars, cap, defaultVoice }.
//
// Al mattino, per ogni utente: profilo dei gusti (se serve), notizie, poi le storie seguite
// (feed_follows): le novità finiscono in feed_items con follow_id valorizzato.
//
// Segreti (Dashboard → Edge Functions → Secrets): GEMINI_API_KEY, FEED_CRON_SECRET,
// opzionali GEMINI_MODEL (default gemini-2.5-flash) e GEMINI_THINKING ('off' default | 'model'),
// GOOGLE_TTS_KEY (chiave API con Cloud Text-to-Speech; senza, i modi tts rispondono 503
// 'dayflow-tts-off') e TTS_MONTH_CAP (default 900000 caratteri al mese).
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY sono già presenti in ogni Edge Function.
//
// Verify JWT va DISATTIVATO sulla funzione: il gateway rifiuta la chiave anon del cron
// (UNAUTHORIZED_INVALID_JWT_FORMAT). L'autenticazione è fatta qui: x-cron-secret oppure
// auth.getUser(token) per le chiamate dall'app.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const GEMINI_KEY = Deno.env.get('GEMINI_API_KEY') ?? '';
const MODEL = Deno.env.get('GEMINI_MODEL') || 'gemini-2.5-flash';
const THINKING = Deno.env.get('GEMINI_THINKING') || 'off';
const CRON_SECRET = Deno.env.get('FEED_CRON_SECRET') ?? '';
const SB_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SB_SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const API = 'https://generativelanguage.googleapis.com/v1beta/';
const TTS_KEY = Deno.env.get('GOOGLE_TTS_KEY') ?? '';
const TTS_API = 'https://texttospeech.googleapis.com/v1/';
const ADMIN = createClient(SB_URL, SB_SERVICE, { auth: { persistSession: false } });

// ── parametri modificabili ─────────────────────────────────────────────────
const MORNING_TOTAL = 40;      // candidate del mattino, divise tra gli argomenti
const MORE_TOTAL = 12;         // candidate per ogni richiesta "more" dall'app
const MAX_PER_TOPIC_CALL = 12; // oltre, una sola chiamata dà risultati peggiori
const MAX_MORE_PER_HOUR = 6;
const MAX_PROXY_PER_HOUR = 120;  // approfondimenti + chat
const MODEL_RE = /^[a-z0-9][a-z0-9.\-]*$/i;
const SEEN_DAYS = 7;           // titoli degli ultimi N giorni esclusi dalla generazione
const SEEN_MAX_PER_TOPIC = 60;
const KEEP_DAYS = 30;          // notizie più vecchie cancellate (gli eventi restano)
const HARD_MAX_AGE_DAYS = 7;   // notizie più vecchie scartate a prescindere
const TEMPERATURE = 0.7;
// Text-to-Speech (Ascolta): 1 milione di caratteri gratis al mese per progetto, poi 30 $ / milione.
const TTS_DEFAULT_VOICE = 'it-IT-Chirp3-HD-Aoede';
const TTS_VOICE_RE = /^it-IT-[A-Za-z0-9-]+$/;
const TTS_MAX_CHARS = 1500;      // per richiesta (il limite di Google è 5000 byte)
const TTS_MONTH_CAP = Number(Deno.env.get('TTS_MONTH_CAP')) || 900_000; // tutti gli utenti insieme
const MAX_TTS_PER_HOUR = 400;    // pezzi di articolo a utente
const TTS_VOICES_TTL = 24 * 3600_000;

const TYPES = ['notizia', 'analisi', 'curiosita', 'da_tenere_docchio'] as const;
const AREAS: Record<string, string> = {
  misto: 'misto: notizie italiane quando esistono fonti italiane rilevanti, altrimenti internazionali',
  italia: 'Italia (fonti e fatti italiani)',
  europa: 'Europa',
  mondo: 'mondo (fonti internazionali, anche in inglese; scrivi comunque in italiano)',
};
const LEVELS: Record<Level, string> = {
  divulgativo: 'divulgativo: spiega in modo chiaro per un lettore curioso non esperto, niente gergo non spiegato',
  tecnico: 'tecnico: il lettore è esperto, usa i termini del settore e dai dettagli tecnici, numeri e metodi',
};
const FOLLOWS_MAX = 6;          // storie seguite controllate ogni mattina (una chiamata ciascuna)
const FOLLOW_ITEMS_MAX = 2;     // novità al massimo per storia
const PROFILE_MIN_SIGNALS = 5;  // sotto, niente profilo dei gusti
const PROFILE_DAYS = 30;        // eventi considerati per il profilo
const PROFILE_MAX_AGE_DAYS = 7; // al mattino si rigenera se più vecchio (e non modificato a mano)
const POS_EVENTS = ['open', 'chat', 'save', 'share', 'up', 'more'];
const NEG_EVENTS = ['down', 'less'];

// Campi JSON di ogni voce (i nomi sono letti da parseItems e dal client, non cambiarli).
const ITEM_FIELDS = `Ogni voce ha questi campi, in quest'ordine:
- "title": titolo in italiano, massimo 14 parole, niente clickbait. Deve essere una frase vera, con soggetto e verbo, non telegrafica.
  Sbagliato: "Rischio 230 miliardi ricavi bancari da stablecoin". Giusto: "Le stablecoin potrebbero togliere alle banche 230 miliardi di ricavi".
- "subtopic": sotto-argomento breve
- "tags": 2-4 parole chiave minuscole
- "type": uno tra ${TYPES.map(x => `"${x}"`).join(', ')}
- "summary": 2-3 frasi concrete in italiano: cosa è successo, con fatti, numeri e nomi
- "whyItMatters": una frase su perché conta
- "source": nome della testata o del sito da cui viene il fatto (se più testate, la più autorevole)
- "url": link all'articolo originale, solo se lo hai trovato con la ricerca, altrimenti ""
- "publishedAt": data di pubblicazione, formato YYYY-MM-DD (con THH:MM se la conosci)
- "quality": oggetto con "specificity", "novelty", "importance", interi da 1 a 5, dati con SEVERITÀ:
  - specificity: 1 = generica, nessun dato concreto; 3 = qualche fatto o nome ma pochi dettagli; 5 = numeri, nomi e date precisi e verificabili.
  - novelty: 1 = cosa già nota o ripetuta da giorni; 3 = sviluppo nuovo di una storia già nota; 5 = fatto davvero nuovo (primo annuncio, scoperta, svolta).
  - importance: 1 = curiosità di nicchia senza conseguenze; 3 = conta per chi segue l'argomento; 5 = cambia le cose per molte persone, da prima pagina del settore.
  La maggior parte delle voci deve avere 2 o 3. Il 5 è raro: al massimo un solo 5 in tutto il gruppo. Nel dubbio, il voto più basso.`;

const SOURCE_RULES = `FONTI:
- Preferisci testate giornalistiche affermate, agenzie di stampa e fonti primarie (enti, aziende, studi, documenti ufficiali).
- Evita aggregatori, blog SEO, siti che ripubblicano comunicati stampa, contenuti sponsorizzati.
- Stesso fatto riportato da più testate = UNA sola voce, basata su tutte quelle fonti (non una voce per testata).`;

const DEFAULT_TOPICS: Topic[] = [
  { id: 'tech', label: 'Tech' }, { id: 'sport', label: 'Sport' },
  { id: 'crypto', label: 'Crypto' }, { id: 'scienza', label: 'Scienza' },
];
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Expose-Headers': 'x-dayflow-model',
};

type Level = 'divulgativo' | 'tecnico';
// area: chiave di AREAS, oppure null = usa settings.area
type Topic = { id: string; label: string; focus?: string; exclude?: string; area?: string | null; level?: Level };
// prefs scritte dal client: moreSub/lessSub = "topicId:sotto-argomento"; blockedSources = nome o dominio
type Prefs = { moreSub?: string[]; lessSub?: string[]; blockedSources?: string[] };
type Settings = {
  area?: string; maxAgeDays?: number; profile?: string;
  profileAt?: string; profileManual?: boolean; prefs?: Prefs;
};
// deno-lint-ignore no-explicit-any
type Item = Record<string, any> & { title: string; title_key: string; published_at: string | null };
type Follow = { id: string; topic_id: string; title: string; summary: string; url: string | null; created_at: string; checked_at: string | null; updates: number };
type WebChunk = { uri: string; title: string };
// deno-lint-ignore no-explicit-any
type Body = { mode?: string; force?: boolean; topicId?: string; model?: string; stream?: boolean; request?: any; text?: unknown; voice?: unknown };
type Usage = { prompt: number; output: number; thinking: number; tool: number; total: number };

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (!GEMINI_KEY) return json({ error: 'GEMINI_API_KEY mancante nei segreti' }, 500);
  const admin = ADMIN;
  let body: Body = {};
  try { body = await req.json(); } catch { /* body vuoto */ }

  // ── cron ──
  const cronHdr = req.headers.get('x-cron-secret');
  if (cronHdr !== null) {
    if (!CRON_SECRET || !safeEqual(cronHdr, CRON_SECRET)) return json({ error: 'forbidden' }, 403);
    if (!body.force && romeParts().hour !== 6) return json({ skipped: 'non sono le 6 a Roma' });
    EdgeRuntime.waitUntil(runMorning(admin, !!body.force));
    return json({ started: true }, 202);
  }

  // ── app (utente loggato) ──
  // Errori in forma Gemini ({ error: { message } }): il client li gestisce come quelli di Gemini.
  // 'dayflow-auth' / 'dayflow-rate' sono riconosciuti dal client (feedErrorMessage).
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: userData, error: authErr } = await admin.auth.getUser(token);
  const user = userData?.user;
  if (authErr || !user) return json({ error: { message: 'dayflow-auth' } }, 401);
  const MODES = ['proxy', 'models', 'profile', 'tts', 'tts-voices'];
  const mode = typeof body.mode === 'string' && MODES.includes(body.mode) ? body.mode : 'more';
  if ((mode === 'tts' || mode === 'tts-voices') && !TTS_KEY) return json({ error: { message: 'dayflow-tts-off' } }, 503);
  // tts-voices: niente limite orario (elenco in cache, nessun costo) e nessuna riga in feed_runs
  if (mode !== 'tts-voices') {
    const limit = mode === 'more' || mode === 'profile' ? MAX_MORE_PER_HOUR : mode === 'tts' ? MAX_TTS_PER_HOUR : MAX_PROXY_PER_HOUR;
    const since = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await admin.from('feed_runs').select('id', { count: 'exact', head: true })
      .eq('user_id', user.id).eq('kind', mode).gte('started_at', since);
    if ((count ?? 0) >= limit) return json({ error: { message: 'dayflow-rate' } }, 429);
  }
  try {
    if (mode === 'tts') return await synthTts(admin, user.id, body);
    if (mode === 'tts-voices') return await ttsVoices();
    if (mode === 'proxy') return await proxyGemini(admin, user.id, body);
    if (mode === 'models') return await listModels(admin, user.id);
    if (mode === 'profile') {
      const p = await buildProfile(admin, user.id);
      if (!p.ok) return json({ error: 'dayflow-few-signals', signals: p.signals }, 422);
      return json({ profile: p.profile, profileAt: p.profileAt });
    }
    const res = await generateForUser(admin, user.id, 'more', MORE_TOTAL, body.topicId);
    return json(res, res.ok ? 200 : 502);
  } catch (e) {
    return json({ error: { message: String((e as Error)?.message ?? e) } }, 500);
  }
});

// ── proxy Gemini per approfondimenti e chat (la chiave resta nel cloud) ──────
// body: { mode: 'proxy', model?, stream?, request: { contents, systemInstruction?, generationConfig?, tools? } }
// Risposta: quella di Gemini così com'è (JSON, oppure SSE se stream), con lo stesso status.
async function proxyGemini(admin: SupabaseClient, userId: string, body: Body) {
  const t0 = Date.now();
  const r = body.request ?? {};
  if (!Array.isArray(r.contents) || !r.contents.length) return json({ error: { message: 'contents mancante' } }, 400);
  const tools = (Array.isArray(r.tools) ? r.tools : [])
    // deno-lint-ignore no-explicit-any
    .filter((t: any) => t && typeof t === 'object' && (('google_search' in t) || ('url_context' in t)))
    // deno-lint-ignore no-explicit-any
    .map((t: any) => ('google_search' in t ? { google_search: {} } : { url_context: {} }));
  const requested = typeof body.model === 'string' && MODEL_RE.test(body.model) ? body.model : MODEL;
  // Il thinkingConfig arriva dal client per il modello richiesto: se si passa a un altro modello
  // (ritirato → sostituto) va ricalcolato, e col thinking acceso serve più spazio in uscita.
  const build = (m: string) => {
    const request: Record<string, unknown> = { contents: r.contents };
    if (r.systemInstruction) request.systemInstruction = r.systemInstruction;
    if (tools.length) request.tools = tools;
    const gc = r.generationConfig && typeof r.generationConfig === 'object' ? { ...r.generationConfig } : null;
    if (gc && m !== requested) {
      const tc = thinkingConfig(m, true);
      if (tc) gc.thinkingConfig = tc; else { delete gc.thinkingConfig; if (gc.maxOutputTokens) gc.maxOutputTokens = Math.max(gc.maxOutputTokens, 8192); }
    }
    if (gc) request.generationConfig = gc;
    return request;
  };
  const { res, model } = await callGemini(requested, m => ({
    url: `${API}models/${encodeURIComponent(m)}:${body.stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`,
    body: JSON.stringify(build(m)),
  }), 140_000);
  const hdr = { ...CORS, 'x-dayflow-model': model };
  const log = (ok: boolean, detail: Record<string, unknown>) =>
    EdgeRuntime.waitUntil(Promise.resolve(admin.from('feed_runs').insert({ user_id: userId, kind: 'proxy', ms: Date.now() - t0, ok, inserted: 0, detail: { model, stream: !!body.stream, tools: tools.length, ...detail } })));
  if (!res.ok) {
    const j = await res.json().catch(() => null);
    log(false, { status: res.status, error: j?.error?.message });
    return new Response(JSON.stringify(j ?? { error: { message: 'HTTP ' + res.status } }), { status: res.status, headers: { ...hdr, 'Content-Type': 'application/json' } });
  }
  log(true, model !== requested ? { requested } : {});
  if (body.stream) return new Response(res.body, { status: 200, headers: { ...hdr, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
  return new Response(await res.text(), { status: 200, headers: { ...hdr, 'Content-Type': 'application/json' } });
}

// ── elenco modelli disponibili per la chiave del cloud ──────────────────────
async function listModels(admin: SupabaseClient, userId: string) {
  const all: unknown[] = [];
  let token = '';
  for (let page = 0; page < 5; page++) {
    const res = await fetch(`${API}models?pageSize=200${token ? '&pageToken=' + encodeURIComponent(token) : ''}`, { headers: { 'x-goog-api-key': GEMINI_KEY } });
    const j = await res.json().catch(() => null);
    if (!res.ok) return json(j ?? { error: { message: 'HTTP ' + res.status } }, res.status);
    all.push(...(j?.models ?? []));
    token = j?.nextPageToken ?? '';
    if (!token) break;
  }
  await admin.from('feed_runs').insert({ user_id: userId, kind: 'models', ms: 0, ok: true, inserted: 0, detail: { n: all.length } });
  return json({ models: all });
}

// ── Text-to-Speech per "Ascolta" (Google Cloud, voci Chirp 3 HD) ─────────────
// body: { mode: 'tts', text, voice? } → 200 { audio: base64 MP3, chars, voice }.
// Errori ({ error: { message } }): 400 testo mancante / 'dayflow-tts-long' (> TTS_MAX_CHARS) /
// voce non valida o rifiutata da Google; 429 'dayflow-tts-quota' (tetto mensile del progetto);
// 503 'dayflow-tts-off' (manca GOOGLE_TTS_KEY) o consumo non verificabile; 502 errore di Google.
// Ogni chiamata va in feed_runs (kind 'tts', inserted = caratteri sintetizzati, 0 se fallita):
// la somma del mese è il consumo di tutto il progetto.
async function synthTts(admin: SupabaseClient, userId: string, body: Body) {
  const t0 = Date.now();
  const text = typeof body.text === 'string' ? body.text.replace(/\s+/g, ' ').trim() : '';
  if (!text) return json({ error: { message: 'testo mancante' } }, 400);
  if (text.length > TTS_MAX_CHARS) return json({ error: { message: 'dayflow-tts-long' } }, 400);
  if (body.voice != null && body.voice !== '' && !(typeof body.voice === 'string' && TTS_VOICE_RE.test(body.voice)))
    return json({ error: { message: 'voce non valida' } }, 400);
  const voice = typeof body.voice === 'string' && body.voice ? body.voice : TTS_DEFAULT_VOICE;
  let used: number;
  try { used = await ttsMonthChars(); }
  catch (e) {
    console.error('tts quota', e);
    return json({ error: { message: 'quota voce non verificabile' } }, 503); // nel dubbio non si spende
  }
  if (used + text.length > TTS_MONTH_CAP) return json({ error: { message: 'dayflow-tts-quota' } }, 429);
  const log = (ok: boolean, detail: Record<string, unknown>) =>
    EdgeRuntime.waitUntil(Promise.resolve(admin.from('feed_runs').insert({ user_id: userId, kind: 'tts', ms: Date.now() - t0, ok, inserted: ok ? text.length : 0, detail: { voice, chars: text.length, ...detail } })));
  const res = await fetch(`${TTS_API}text:synthesize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': TTS_KEY },
    body: JSON.stringify({ input: { text }, voice: { languageCode: 'it-IT', name: voice }, audioConfig: { audioEncoding: 'MP3' } }),
    signal: AbortSignal.timeout(30_000),
  }).catch(e => { console.error('tts fetch', e); return null; });
  if (!res) { log(false, { error: 'rete' }); return json({ error: { message: 'tts: Google non risponde' } }, 502); }
  const j = await res.json().catch(() => null);
  if (!res.ok || typeof j?.audioContent !== 'string') {
    const msg = String(j?.error?.message ?? 'risposta senza audio');
    log(false, { status: res.status, error: msg });
    // 400 = testo o voce rifiutati; il resto (chiave, quota Google, 5xx) è un problema del cloud
    return json({ error: { message: `tts ${res.status}: ${msg}` } }, res.status === 400 ? 400 : 502);
  }
  log(true, {});
  return json({ audio: j.audioContent, chars: text.length, voice });
}

// Caratteri TTS del mese (UTC) di tutti gli utenti. Lettura incrementale per id: a ogni chiamata
// si leggono solo le righe nuove (PostgREST restituisce al più ~1000 righe per richiesta, e se ne
// dà meno il resto arriva alla chiamata dopo). Una riga scritta in ritardo con un id più basso di
// una già letta può sfuggire: per questo il tetto è sotto il milione gratuito.
const ttsMonth = { month: '', sum: 0, lastId: 0 };
async function ttsMonthChars(): Promise<number> {
  const now = new Date();
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  if (ttsMonth.month !== month) { ttsMonth.month = month; ttsMonth.sum = 0; ttsMonth.lastId = 0; }
  for (let page = 0; page < 50; page++) {
    const { data, error } = await ADMIN.from('feed_runs').select('id, inserted')
      .eq('kind', 'tts').gte('started_at', month).gt('id', ttsMonth.lastId)
      .order('id', { ascending: true }).limit(1000);
    if (error) throw new Error('feed_runs: ' + error.message);
    const rows = data ?? [];
    for (const r of rows) {
      ttsMonth.sum += Number(r.inserted) || 0;
      ttsMonth.lastId = Math.max(ttsMonth.lastId, Number(r.id) || 0);
    }
    if (rows.length < 1000) break;
  }
  return ttsMonth.sum;
}

// Voci italiane Chirp 3 HD (in memoria 24 h) + consumo del mese per le impostazioni.
type TtsVoice = { name: string; gender: string };
let ttsVoiceCache: { at: number; voices: TtsVoice[] } | null = null;
async function ttsVoices() {
  if (!ttsVoiceCache || Date.now() - ttsVoiceCache.at > TTS_VOICES_TTL) {
    const res = await fetch(`${TTS_API}voices?languageCode=it-IT`, { headers: { 'x-goog-api-key': TTS_KEY }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    const j = res ? await res.json().catch(() => null) : null;
    if (!res || !res.ok) return json({ error: { message: `tts-voices ${res?.status ?? 'rete'}: ${j?.error?.message ?? ''}` } }, 502);
    const voices: TtsVoice[] = (Array.isArray(j?.voices) ? j.voices : [])
      // deno-lint-ignore no-explicit-any
      .filter((v: any) => typeof v?.name === 'string' && v.name.includes('Chirp3-HD') && TTS_VOICE_RE.test(v.name)
        && (!Array.isArray(v.languageCodes) || v.languageCodes.includes('it-IT')))
      // deno-lint-ignore no-explicit-any
      .map((v: any) => ({ name: String(v.name), gender: String(v.ssmlGender ?? '') }));
    voices.sort((a, b) => a.name.localeCompare(b.name));
    ttsVoiceCache = { at: Date.now(), voices };
  }
  let monthChars: number | null = null;
  try { monthChars = await ttsMonthChars(); } catch (e) { console.error('tts quota', e); }
  return json({ voices: ttsVoiceCache.voices, monthChars, cap: TTS_MONTH_CAP, defaultVoice: TTS_DEFAULT_VOICE });
}

// ── mattino: tutti gli utenti con argomenti salvati ────────────────────────
async function runMorning(admin: SupabaseClient, force: boolean) {
  const { data: profiles, error } = await admin.from('profiles').select('id').not('feed_topics', 'is', null);
  if (error) { console.error('profiles', error.message); return; }
  const todayStart = romeMidnightUtc();
  for (const p of profiles ?? []) {
    if (!force) {
      const { count } = await admin.from('feed_runs').select('id', { count: 'exact', head: true })
        .eq('user_id', p.id).eq('kind', 'morning').eq('ok', true).gte('started_at', todayStart);
      if ((count ?? 0) > 0) continue; // già fatto oggi
    }
    // 1. profilo dei gusti: settimanale, solo se non modificato a mano; gli errori non fermano il resto
    try {
      const { data: prof } = await admin.from('profiles').select('feed_settings').eq('id', p.id).maybeSingle();
      const s = readSettings(prof?.feed_settings);
      const at = s.profileAt ? Date.parse(s.profileAt) : NaN;
      if (!s.profileManual && (isNaN(at) || Date.now() - at > PROFILE_MAX_AGE_DAYS * 86400_000)) await buildProfile(admin, p.id);
    } catch (e) { console.error('profile', p.id, e); }
    // 2. notizie
    try { await generateForUser(admin, p.id, 'morning', MORNING_TOTAL); }
    catch (e) { console.error('morning', p.id, e); }
    // 3. storie seguite
    try { await checkFollows(admin, p.id); }
    catch (e) { console.error('follows', p.id, e); }
  }
  const old = new Date(Date.now() - KEEP_DAYS * 86400_000).toISOString();
  await admin.from('feed_items').delete().lt('created_at', old);
  await admin.from('feed_runs').delete().lt('started_at', new Date(Date.now() - 60 * 86400_000).toISOString());
}

// ── generazione per un utente ──────────────────────────────────────────────
async function generateForUser(admin: SupabaseClient, userId: string, kind: 'morning' | 'more', total: number, topicId?: string) {
  const t0 = Date.now();
  const { data: prof } = await admin.from('profiles').select('feed_topics, feed_settings').eq('id', userId).maybeSingle();
  const settings = readSettings(prof?.feed_settings);
  let topics = normalizeTopics(prof?.feed_topics);
  if (topicId) topics = topics.filter(t => t.id === topicId);
  if (!topics.length) topics = topicId ? [] : DEFAULT_TOPICS;
  if (!topics.length) return logRun(admin, userId, kind, t0, false, 0, { error: 'argomento sconosciuto', topicId });

  const sinceSeen = new Date(Date.now() - SEEN_DAYS * 86400_000).toISOString();
  const { data: seenRows } = await admin.from('feed_items').select('topic_id, title, title_key')
    .eq('user_id', userId).gte('created_at', sinceSeen).order('created_at', { ascending: false }).limit(1000);
  const seenKeys = new Set((seenRows ?? []).map(r => r.title_key as string));

  const per = Math.min(MAX_PER_TOPIC_CALL, Math.max(3, Math.ceil(total / topics.length)));
  const maxAge = Math.min(HARD_MAX_AGE_DAYS, Math.max(1, Number(settings.maxAgeDays) || 3));
  const results = await Promise.allSettled(topics.map(t => {
    const seen = (seenRows ?? []).filter(r => r.topic_id === t.id).slice(0, SEEN_MAX_PER_TOPIC).map(r => r.title as string);
    return generateTopic(t, per, maxAge, seen, settings);
  }));

  const batchId = crypto.randomUUID();
  const rows: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const usage: Usage = { prompt: 0, output: 0, thinking: 0, tool: 0, total: 0 };
  let queries = 0;
  results.forEach((r, i) => {
    if (r.status === 'rejected') { errors.push(`${topics[i].id}: ${String(r.reason?.message ?? r.reason)}`); return; }
    queries += r.value.queries;
    for (const k of Object.keys(usage) as (keyof Usage)[]) usage[k] += r.value.usage[k];
    for (const it of r.value.items) {
      if (seenKeys.has(it.title_key)) continue;
      seenKeys.add(it.title_key);
      rows.push({ ...it, user_id: userId, batch_id: batchId, kind, origin: 'search', model: r.value.model });
    }
  });

  let inserted: Record<string, unknown>[] = [];
  if (rows.length) {
    const { data, error } = await admin.from('feed_items')
      .upsert(rows, { onConflict: 'user_id,title_key', ignoreDuplicates: true }).select('*');
    if (error) errors.push('insert: ' + error.message);
    inserted = data ?? [];
  }
  const ok = inserted.length > 0;
  await logRun(admin, userId, kind, t0, ok, inserted.length, {
    model: effectiveModel(MODEL), topics: topics.map(t => t.id), perTopic: per, candidates: rows.length, queries, usage,
    errors: errors.length ? errors : undefined,
  });
  return { ok, inserted: inserted.length, items: inserted, errors };
}

async function logRun(admin: SupabaseClient, userId: string, kind: string, t0: number, ok: boolean, inserted: number, detail: Record<string, unknown>) {
  await admin.from('feed_runs').insert({ user_id: userId, kind, ms: Date.now() - t0, ok, inserted, detail });
  return { ok, inserted, items: [] as unknown[], errors: detail.error ? [String(detail.error)] : [] };
}

// ── un argomento = una chiamata Gemini con Google Search ───────────────────
async function generateTopic(topic: Topic, n: number, maxAgeDays: number, seen: string[], settings: Settings) {
  const prompt = buildPrompt(topic, n, maxAgeDays, areaText(topic, settings), seen, settings);
  const { text, gm, usage, model } = await gemini(prompt);
  const items = await parseItems(text, gm, topic.id, settings);
  return { items, usage, model, queries: (gm?.webSearchQueries ?? []).length };
}

// Testo di Gemini (array JSON) + groundingMetadata → righe per feed_items (senza user_id/batch/kind).
// Scarta: voci senza titolo, troppo vecchie, e le fonti bloccate dall'utente (settings.prefs.blockedSources);
// una voce che aveva fonti e le perde tutte per il blocco viene scartata.
// deno-lint-ignore no-explicit-any
async function parseItems(text: string, gm: any, topicId: string, settings: Settings): Promise<Item[]> {
  const raw = extractJSON(text);
  if (!Array.isArray(raw)) throw new Error('risposta non è un array');
  const chunks: WebChunk[] = (gm?.groundingChunks ?? []).map((c: { web?: WebChunk }) => c.web).filter(Boolean);
  const perItem = mapSources(raw, text, gm);
  const resolved = await resolveAll(chunks.map(c => c.uri));
  const blocked = blockedSourceMatcher(settings);
  const now = Date.now();
  const items: Item[] = [];
  for (let i = 0; i < raw.length; i++) {
    const it = raw[i] ?? {};
    const title = clean(it.title, 200);
    if (!title) continue;
    const pub = parseDate(it.publishedAt);
    if (pub && (now - pub.getTime() > HARD_MAX_AGE_DAYS * 86400_000)) continue;
    const all = perItem[i].map(j => ({ title: chunks[j]?.title ?? '', uri: chunks[j]?.uri ?? '', url: resolved.get(chunks[j]?.uri ?? '') ?? null }))
      .filter(s => s.uri);
    const srcs = all.filter(s => !blocked(s.title, s.url));
    if (all.length && !srcs.length) continue;
    const declared = clean(it.source, 80);
    if (!all.length && (blocked(declared, null) || blocked('', clean(it.url, 500) || null))) continue;
    const modelHost = host(it.url);
    // Link: la fonte Google dello stesso sito del link dichiarato, altrimenti la prima fonte Google.
    // Un link che non corrisponde a nessuna fonte trovata non si usa (potrebbe essere inventato).
    const match = srcs.find(s => s.url && modelHost && host(s.url) === modelHost);
    const url = match?.url ?? srcs.find(s => s.url)?.url ?? null;
    const q = it.quality ?? {};
    items.push({
      topic_id: topicId,
      subtopic: clean(it.subtopic, 60),
      tags: Array.isArray(it.tags) ? it.tags.map((t: unknown) => clean(t, 30).toLowerCase()).filter(Boolean).slice(0, 6) : [],
      type: (TYPES as readonly string[]).includes(it.type) ? it.type : 'notizia',
      title,
      title_key: titleKey(title),
      summary: clean(it.summary, 1200),
      why: clean(it.whyItMatters, 400),
      source: (declared && !blocked(declared, null) ? declared : '') || srcs[0]?.title || '',
      url,
      sources: srcs,
      published_at: pub && pub.getTime() <= now + 86400_000 ? pub.toISOString() : null,
      q_specificity: score(q.specificity), q_novelty: score(q.novelty), q_importance: score(q.importance),
    });
  }
  return items;
}

function areaText(t: { area?: string | null }, settings: Settings) {
  return AREAS[t.area || settings.area || 'misto'] ?? AREAS.misto;
}
// Sotto-argomenti "di più"/"di meno" dell'argomento (le voci sono "topicId:sotto-argomento").
function subsFor(list: string[] | undefined, topicId: string) {
  const p = topicId + ':';
  return (list ?? []).filter(s => s.startsWith(p)).map(s => s.slice(p.length).trim()).filter(Boolean);
}

function buildPrompt(t: Topic, n: number, days: number, area: string, seen: string[], settings: Settings) {
  const today = romeToday();
  const more = subsFor(settings.prefs?.moreSub, t.id);
  const less = subsFor(settings.prefs?.lessSub, t.id);
  const blocked = settings.prefs?.blockedSources ?? [];
  return `Oggi è ${today}. Usa Google Search per trovare notizie VERE pubblicate negli ultimi ${days} giorni sull'argomento "${t.label}", poi scegli le ${n} più interessanti per un lettore curioso e già informato.
${t.focus ? `Focus: ${t.focus}.\n` : ''}${t.exclude ? `Escludi: ${t.exclude}.\n` : ''}Area geografica preferita: ${area}.
${t.level ? `Livello: ${LEVELS[t.level]}.\n` : ''}${more.length ? `Sotto-argomenti da privilegiare: ${more.join(', ')}.\n` : ''}${less.length ? `Sotto-argomenti da ridurre molto (solo se davvero importanti): ${less.join(', ')}.\n` : ''}${settings.profile ? `\nPROFILO DEI GUSTI DELL'UTENTE:\n${settings.profile}\n` : ''}
CRITERI:
- Specifiche: fatti, numeri, nomi concreti. Niente notizie generiche, gossip, comunicati promozionali, liste di consigli.
- Nuove e rilevanti: preferisci ciò che cambia qualcosa o che un appassionato vorrebbe sapere.
- Mescola i tipi: notizie, analisi, curiosità, cose "da tenere d'occhio".
- Varia i sotto-argomenti.
- Ogni voce deve basarsi su una fonte trovata con la ricerca. Non inventare fatti, fonti, link o dichiarazioni.

${SOURCE_RULES}
${blocked.length ? `- Non usare MAI queste fonti (l'utente le ha bloccate): ${blocked.join(', ')}.\n` : ''}${seen.length ? `\nGIÀ MOSTRATE ALL'UTENTE (non riproporle, nemmeno riformulate o con un altro angolo sullo stesso fatto):\n${seen.map(s => '- ' + s).join('\n')}\n` : ''}
Rispondi SOLO con un array JSON dentro un blocco \`\`\`json, senza altro testo. ${ITEM_FIELDS}`;
}

function buildFollowPrompt(f: Follow, since: string, area: string, settings: Settings, level?: Level) {
  const sinceTxt = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(since));
  const blocked = settings.prefs?.blockedSources ?? [];
  return `Oggi è ${romeToday()}. L'utente segue questa storia:
"${f.title}" — ${f.summary}${f.url ? ` (${f.url})` : ''}

Usa Google Search per trovare novità VERE su questa storia pubblicate dopo il ${sinceTxt}: sviluppi, conseguenze, reazioni, nuovi dati. Non riproporre il fatto iniziale né cose già note prima di quella data.
Se non c'è niente di nuovo, rispondi con un array vuoto [].
Al massimo ${FOLLOW_ITEMS_MAX} voci. Area geografica preferita: ${area}.
${level ? `Livello: ${LEVELS[level]}.
` : ''}
${SOURCE_RULES}
${blocked.length ? `- Non usare MAI queste fonti (l'utente le ha bloccate): ${blocked.join(', ')}.\n` : ''}
Rispondi SOLO con un array JSON dentro un blocco \`\`\`json, senza altro testo. ${ITEM_FIELDS}`;
}

// ── storie seguite: novità dal controllo precedente ─────────────────────────
// Le novità vanno in feed_items con follow_id = id della storia (kind 'morning': il check della
// tabella ammette solo 'morning'/'more'). Un errore su una storia non ferma le altre; checked_at
// si aggiorna solo se la storia è stata controllata davvero (così un errore si ritenta domani).
async function checkFollows(admin: SupabaseClient, userId: string) {
  const t0 = Date.now();
  const nowIso = new Date().toISOString();
  await admin.from('feed_follows').update({ active: false }).eq('user_id', userId).eq('active', true).lt('until', nowIso);
  const { data, error } = await admin.from('feed_follows')
    .select('id, topic_id, title, summary, url, created_at, checked_at, updates')
    .eq('user_id', userId).eq('active', true)
    .order('checked_at', { ascending: true, nullsFirst: true }).limit(FOLLOWS_MAX);
  if (error) return logRun(admin, userId, 'follows', t0, false, 0, { error: error.message });
  const follows = (data ?? []) as Follow[];
  if (!follows.length) return { ok: true, inserted: 0, items: [] as unknown[], errors: [] as string[] };

  const { data: prof } = await admin.from('profiles').select('feed_topics, feed_settings').eq('id', userId).maybeSingle();
  const settings = readSettings(prof?.feed_settings);
  const topics = normalizeTopics(prof?.feed_topics);
  const batchId = crypto.randomUUID();
  const usage: Usage = { prompt: 0, output: 0, thinking: 0, tool: 0, total: 0 };
  const perFollow: Record<string, unknown>[] = [];

  const results = await Promise.allSettled(follows.map(async f => {
    const since = f.checked_at ?? f.created_at;
    const topic: Partial<Topic> = topics.find(t => t.id === f.topic_id) ?? { area: null };
    const { text, gm, usage: u, model } = await gemini(buildFollowPrompt(f, since, areaText(topic, settings), settings, topic.level));
    for (const k of Object.keys(usage) as (keyof Usage)[]) usage[k] += u[k];
    const sinceMs = Date.parse(since) - 86400_000; // un giorno di tolleranza sulle date date da Gemini
    const items = (await parseItems(text, gm, f.topic_id, settings))
      .filter(it => !it.published_at || Date.parse(it.published_at) >= sinceMs)
      .slice(0, FOLLOW_ITEMS_MAX);
    let inserted = 0;
    if (items.length) {
      const rows = items.map(it => ({ ...it, user_id: userId, batch_id: batchId, kind: 'morning', origin: 'search', model, follow_id: f.id }));
      const { data: ins, error: e } = await admin.from('feed_items')
        .upsert(rows, { onConflict: 'user_id,title_key', ignoreDuplicates: true }).select('id');
      if (e) throw new Error('insert: ' + e.message);
      inserted = ins?.length ?? 0;
    }
    const { error: ue } = await admin.from('feed_follows')
      .update({ checked_at: new Date().toISOString(), updates: (f.updates ?? 0) + inserted }).eq('id', f.id);
    if (ue) throw new Error('update: ' + ue.message);
    return { id: f.id, candidates: items.length, inserted };
  }));

  let inserted = 0;
  const errors: string[] = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') { errors.push(`${follows[i].id}: ${String(r.reason?.message ?? r.reason)}`); return; }
    inserted += r.value.inserted;
    perFollow.push(r.value);
  });
  return logRun(admin, userId, 'follows', t0, errors.length < follows.length, inserted, {
    model: effectiveModel(MODEL), follows: perFollow, usage, errors: errors.length ? errors : undefined,
  });
}

// ── profilo dei gusti dagli eventi degli ultimi 30 giorni ───────────────────
// feed_events.item_id → feed_items.id (può essere null: le notizie oltre KEEP_DAYS sono cancellate,
// allora restano argomento/sotto-argomento/tag copiati nell'evento). Gemini SENZA ricerca.
// Salva profile/profileAt/profileManual:false in profiles.feed_settings senza toccare le altre chiavi.
async function buildProfile(admin: SupabaseClient, userId: string):
  Promise<{ ok: true; profile: string; profileAt: string } | { ok: false; signals: number }> {
  const t0 = Date.now();
  const since = new Date(Date.now() - PROFILE_DAYS * 86400_000).toISOString();
  const { data: evRows, error } = await admin.from('feed_events')
    .select('kind, item_id, topic_id, subtopic, tags, created_at')
    .eq('user_id', userId).in('kind', [...POS_EVENTS, ...NEG_EVENTS]).gte('created_at', since)
    .order('created_at', { ascending: false }).limit(300);
  if (error) throw new Error('feed_events: ' + error.message);
  const evs = evRows ?? [];
  if (evs.length < PROFILE_MIN_SIGNALS) {
    await logRun(admin, userId, 'profile', t0, false, 0, { error: 'dayflow-few-signals', signals: evs.length });
    return { ok: false, signals: evs.length };
  }
  try {
    const ids = [...new Set(evs.map(e => e.item_id as string | null).filter((x): x is string => !!x))].slice(0, 150);
    const titles = new Map<string, string>();
    if (ids.length) {
      const { data: its } = await admin.from('feed_items').select('id, title').in('id', ids);
      for (const it of its ?? []) titles.set(it.id as string, it.title as string);
    }
    const { data: prof } = await admin.from('profiles').select('feed_topics').eq('id', userId).maybeSingle();
    const labels = new Map(normalizeTopics(prof?.feed_topics).map(t => [t.id, t.label]));
    const line = (e: Record<string, unknown>) => {
      const parts = [labels.get(String(e.topic_id)) ?? e.topic_id, e.subtopic].filter(Boolean).join(' / ');
      const title = e.item_id ? titles.get(String(e.item_id)) : '';
      const tags = Array.isArray(e.tags) && e.tags.length ? ` [${e.tags.join(', ')}]` : '';
      return `- (${e.kind}) ${parts}${title ? ': ' + title : ''}${tags}`;
    };
    const pos = evs.filter(e => POS_EVENTS.includes(e.kind as string)).slice(0, 120).map(line);
    const neg = evs.filter(e => NEG_EVENTS.includes(e.kind as string)).slice(0, 60).map(line);
    const prompt = `Sei l'assistente di un feed di notizie personale. Dai segnali qui sotto (ultimi ${PROFILE_DAYS} giorni) scrivi il PROFILO DEI GUSTI del lettore: 3-5 frasi in italiano, in terza persona ("Il lettore..."). Descrivi cosa lo interessa davvero (argomenti, sotto-argomenti, taglio: fatti, analisi, tecnica, curiosità), cosa non gli interessa, e che tipo di notizie apprezza. Sii concreto, niente frasi generiche. Solo testo semplice: niente elenchi, niente markdown, niente titolo.
Legenda: open = ha aperto l'approfondimento, chat = ne ha chiesto di più, save = salvata, share = condivisa, up = pollice su, more = "di più su questo", down = pollice giù, less = "meno così".

SEGNALI POSITIVI:
${pos.length ? pos.join('\n') : '- nessuno'}

SEGNALI NEGATIVI:
${neg.length ? neg.join('\n') : '- nessuno'}`;
    const { text, model } = await gemini(prompt, false);
    const profile = clean(text.replace(/[*#_`]+/g, ''), 1200);
    if (!profile) throw new Error('profilo vuoto');
    const profileAt = new Date().toISOString();
    // Rilettura subito prima della scrittura: il client scrive prefs/area in feed_settings.
    const { data: cur, error: re } = await admin.from('profiles').select('feed_settings').eq('id', userId).maybeSingle();
    if (re) throw new Error('profiles: ' + re.message);
    const base = cur?.feed_settings && typeof cur.feed_settings === 'object' ? cur.feed_settings : {};
    const { error: we } = await admin.from('profiles')
      .update({ feed_settings: { ...base, profile, profileAt, profileManual: false } }).eq('id', userId);
    if (we) throw new Error('profiles: ' + we.message);
    await logRun(admin, userId, 'profile', t0, true, 0, { model, signals: evs.length, pos: pos.length, neg: neg.length });
    return { ok: true, profile, profileAt };
  } catch (e) {
    await logRun(admin, userId, 'profile', t0, false, 0, { error: String((e as Error)?.message ?? e), signals: evs.length });
    throw e;
  }
}

// ── Gemini ─────────────────────────────────────────────────────────────────
function thinkingConfig(model: string, ignoreEnv = false) {
  if (THINKING === 'model' && !ignoreEnv) return undefined;
  const m = model.toLowerCase();
  if (/^gemini-2\.5-flash(-lite)?(-|$)/.test(m)) return { thinkingBudget: 0 };
  if (m.startsWith('gemini-3')) return { thinkingLevel: 'low' };
  return undefined;
}
// deno-lint-ignore no-explicit-any
// search = false → nessuno strumento (es. profilo dei gusti). Passa sempre da callGemini (modello ritirato).
async function gemini(prompt: string, search = true): Promise<{ text: string; gm: any; usage: Usage; model: string }> {
  const build = (m: string) => {
    const generationConfig: Record<string, unknown> = { temperature: TEMPERATURE };
    const tc = thinkingConfig(m); if (tc) generationConfig.thinkingConfig = tc;
    const req: Record<string, unknown> = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig };
    if (search) req.tools = [{ google_search: {} }];
    return { url: `${API}models/${encodeURIComponent(m)}:generateContent`, body: JSON.stringify(req) };
  };
  for (let attempt = 0; ; attempt++) {
    const { res, model } = await callGemini(MODEL, build, 100_000);
    const j = await res.json().catch(() => null);
    if (res.ok) {
      const cand = j?.candidates?.[0] ?? {};
      // deno-lint-ignore no-explicit-any
      const text = (cand.content?.parts ?? []).filter((p: any) => !p.thought).map((p: any) => p.text ?? '').join('');
      if (!text.trim()) throw new Error('risposta vuota (' + (cand.finishReason ?? j?.promptFeedback?.blockReason ?? '?') + ')');
      const u = j?.usageMetadata ?? {};
      return {
        text, gm: cand.groundingMetadata ?? null, model,
        usage: { prompt: u.promptTokenCount ?? 0, output: u.candidatesTokenCount ?? 0, thinking: u.thoughtsTokenCount ?? 0, tool: u.toolUsePromptTokenCount ?? 0, total: u.totalTokenCount ?? 0 },
      };
    }
    const msg = `Gemini ${res.status}: ${j?.error?.message ?? ''}`;
    if (attempt === 0 && (res.status === 429 || res.status >= 500)) { await sleep(4000); continue; }
    throw new Error(msg);
  }
}

// ── Modello ritirato → sostituto automatico ────────────────────────────────
// Se Google toglie il modello (404, o 400 "not found / not supported"), si sceglie il migliore
// tra quelli disponibili per la chiave: stabile > preview, stessa famiglia (flash → flash),
// poi versione più alta. La scelta resta in memoria per REPLACE_TTL (a ogni avvio a freddo
// si rifà: costa una chiamata all'elenco modelli) e viene registrata in feed_runs
// (kind 'model-fallback'). Per renderla definitiva: segreto GEMINI_MODEL nella dashboard.
const replaced = new Map<string, { to: string; at: number }>();
const REPLACE_TTL = 6 * 3600_000;
const MODEL_EXCLUDE = /embed|tts|image|imagen|live|audio|veo|aqa|native|robotics|computer-use|learnlm|gemma/i;
function effectiveModel(m: string) {
  const r = replaced.get(m);
  return r && Date.now() - r.at < REPLACE_TTL ? r.to : m;
}
function modelGone(status: number, msg: string) {
  return status === 404 || (status === 400 && /not found|not supported|no longer|deprecated|unsupported model|is not available/i.test(msg));
}
function modelFamily(id: string) { return /flash-lite/.test(id) ? 'flash-lite' : /flash/.test(id) ? 'flash' : /pro/.test(id) ? 'pro' : 'other'; }
function modelScore(id: string, fam: string) {
  const v = parseFloat((id.match(/^gemini-(\d+(?:\.\d+)?)/) ?? [])[1] ?? '0');
  const f = modelFamily(id);
  return (/preview|exp/i.test(id) ? 0 : 1e6) + (f === fam ? 1e5 : 0)
    + ({ flash: 3e4, pro: 2e4, 'flash-lite': 1e4, other: 0 } as Record<string, number>)[f] + v * 100;
}
async function pickReplacement(gone: string): Promise<string | null> {
  const res = await fetch(`${API}models?pageSize=200`, { headers: { 'x-goog-api-key': GEMINI_KEY }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!res || !res.ok) return null;
  const j = await res.json().catch(() => null);
  const fam = modelFamily(gone);
  const ids: string[] = (j?.models ?? [])
    // deno-lint-ignore no-explicit-any
    .filter((m: any) => /^models\/gemini/.test(m?.name ?? '') && (m.supportedGenerationMethods ?? []).includes('generateContent'))
    // deno-lint-ignore no-explicit-any
    .map((m: any) => String(m.name).slice(7))
    .filter((id: string) => id !== gone && MODEL_RE.test(id) && !MODEL_EXCLUDE.test(id));
  ids.sort((a, b) => modelScore(b, fam) - modelScore(a, fam));
  return ids[0] ?? null;
}
// Chiama Gemini con il modello richiesto (o il suo sostituto già noto); se risulta ritirato,
// sceglie un sostituto e riprova una volta. build(m) prepara URL e body per il modello m.
async function callGemini(requested: string, build: (m: string) => { url: string; body: string }, timeoutMs: number) {
  const send = (m: string) => {
    const { url, body } = build(m);
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY }, body, signal: AbortSignal.timeout(timeoutMs) });
  };
  const model = effectiveModel(requested);
  const res = await send(model);
  if (res.ok) return { res, model };
  const msg = await res.clone().json().then(j => String(j?.error?.message ?? ''), () => '');
  if (!modelGone(res.status, msg)) return { res, model };
  const to = await pickReplacement(model);
  if (!to) return { res, model };
  const at = Date.now();
  replaced.set(requested, { to, at }); replaced.set(model, { to, at });
  console.warn(`modello ${model} non disponibile (${res.status}: ${msg}) → ${to}`);
  EdgeRuntime.waitUntil(Promise.resolve(ADMIN.from('feed_runs').insert({ user_id: null, kind: 'model-fallback', ms: 0, ok: true, inserted: 0, detail: { from: model, to, status: res.status, error: msg } })));
  return { res: await send(to), model: to };
}

function extractJSON(text: string) {
  let t = text;
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (m) t = m[1];
  else { const a = t.indexOf('['), b = t.lastIndexOf(']'); if (a >= 0 && b > a) t = t.slice(a, b + 1); }
  return JSON.parse(t.trim());
}
// Collega ogni voce alle fonti Google: le groundingSupports dicono quali pezzi del testo
// si basano su quali chunk; una voce va dal suo titolo al titolo della voce successiva.
// deno-lint-ignore no-explicit-any
function mapSources(items: any[], text: string, gm: any): number[][] {
  const sups = gm?.groundingSupports ?? [];
  const pos = items.map(it => {
    const t = String(it?.title ?? '');
    if (!t) return -1;
    const p = text.indexOf(JSON.stringify(t).slice(1, -1));
    return p >= 0 ? p : text.indexOf(t);
  });
  const order = pos.map((p, i) => ({ p, i })).filter(x => x.p >= 0).sort((a, b) => a.p - b.p);
  const span: Record<number, [number, number]> = {};
  order.forEach((x, k) => { span[x.i] = [x.p, k + 1 < order.length ? order[k + 1].p : text.length]; });
  return items.map((_, i) => {
    const s = span[i], idx = new Set<number>();
    if (s) for (const sp of sups) {
      const st = sp.segment?.text ? text.indexOf(sp.segment.text) : -1;
      if (st >= s[0] && st < s[1]) (sp.groundingChunkIndices ?? []).forEach((j: number) => idx.add(j));
    }
    return [...idx];
  });
}
// I link delle fonti Google sono redirect (vertexaisearch.cloud.google.com/grounding-api-redirect/…):
// si legge l'header Location per avere il link diretto alla testata.
async function resolveAll(uris: string[]) {
  const out = new Map<string, string | null>();
  const todo = [...new Set(uris)];
  const worker = async () => {
    for (let u = todo.shift(); u !== undefined; u = todo.shift()) out.set(u, await resolveUrl(u));
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return out;
}
async function resolveUrl(uri: string): Promise<string | null> {
  if (!/grounding-api-redirect/.test(uri)) return uri;
  try {
    const r = await fetch(uri, { redirect: 'manual', signal: AbortSignal.timeout(6000) });
    await r.body?.cancel();
    const loc = r.headers.get('location');
    return loc && /^https?:\/\//.test(loc) ? loc : null;
  } catch { return null; }
}

// ── utilità ────────────────────────────────────────────────────────────────
function normalizeTopics(raw: unknown): Topic[] {
  if (!Array.isArray(raw)) return [];
  // deno-lint-ignore no-explicit-any
  return raw.filter((t: any) => t && t.id && t.label).map((t: any) => ({
    id: String(t.id), label: clean(t.label, 40), focus: clean(t.focus, 300) || undefined,
    exclude: clean(t.exclude, 300) || undefined, area: t.area && AREAS[t.area] ? t.area : null,
    level: t.level && t.level in LEVELS ? t.level as Level : undefined,
  }));
}
// feed_settings scritto dal client: si tiene solo ciò che ha la forma attesa.
function readSettings(raw: unknown): Settings {
  // deno-lint-ignore no-explicit-any
  const s: any = raw && typeof raw === 'object' ? raw : {};
  const list = (v: unknown, lower = false) => (Array.isArray(v) ? v : [])
    .filter((x): x is string => typeof x === 'string')
    .map(x => { const c = clean(x, 120); return lower ? c.toLowerCase() : c; })
    .filter(Boolean).slice(0, 100);
  const p = s.prefs && typeof s.prefs === 'object' ? s.prefs : {};
  return {
    area: typeof s.area === 'string' && AREAS[s.area] ? s.area : undefined,
    maxAgeDays: Number(s.maxAgeDays) || undefined,
    profile: typeof s.profile === 'string' ? clean(s.profile, 1500) || undefined : undefined,
    profileAt: typeof s.profileAt === 'string' ? s.profileAt : undefined,
    profileManual: s.profileManual === true,
    prefs: {
      moreSub: list(p.moreSub), lessSub: list(p.lessSub),
      blockedSources: list(p.blockedSources, true).map(b => /^\S+\.\S+$/.test(b) ? b.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '') : b),
    },
  };
}
// Fonte bloccata se il nome (titolo della fonte Google o testata dichiarata) o l'host del link
// coincidono con una voce di blockedSources (minuscole); l'host vale anche per i sottodomini.
function blockedSourceMatcher(settings: Settings) {
  const list = settings.prefs?.blockedSources ?? [];
  return (name: string, url: string | null) => {
    if (!list.length) return false;
    const n = name.toLowerCase().trim().replace(/^www\./, '');
    const h = url ? host(url).toLowerCase() : '';
    return list.some(b => (n && (n === b || n.endsWith('.' + b))) || (h && (h === b || h.endsWith('.' + b))));
  };
}
function romeToday() {
  return new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
}
function clean(v: unknown, max: number) { return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max); }
function titleKey(t: string) { return t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
function score(v: unknown) { const n = Math.round(Number(v)); return n >= 1 && n <= 5 ? n : null; }
function host(u: unknown) { try { return new URL(String(u)).hostname.replace(/^www\./, ''); } catch { return ''; } }
function parseDate(v: unknown) { const t = Date.parse(String(v ?? '')); return isNaN(t) ? null : new Date(t); }
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function romeParts(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, hour: +p.hour };
}
// Mezzanotte di oggi a Roma, in UTC ISO (per "già generato oggi").
function romeMidnightUtc() {
  const { y, m, d, hour } = romeParts();
  const nowUtcH = new Date().getUTCHours();
  const offset = ((hour - nowUtcH) + 24) % 24; // 1 o 2 ore
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - offset * 3600_000).toISOString();
}
