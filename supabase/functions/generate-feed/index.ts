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
//    { mode: 'models' } → elenco modelli Gemini disponibili per la chiave del cloud.
//
// Segreti (Dashboard → Edge Functions → Secrets): GEMINI_API_KEY, FEED_CRON_SECRET,
// opzionali GEMINI_MODEL (default gemini-2.5-flash) e GEMINI_THINKING ('off' default | 'model').
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

const TYPES = ['notizia', 'analisi', 'curiosita', 'da_tenere_docchio'] as const;
const AREAS: Record<string, string> = {
  misto: 'misto: notizie italiane quando esistono fonti italiane rilevanti, altrimenti internazionali',
  italia: 'Italia (fonti e fatti italiani)',
  europa: 'Europa',
  mondo: 'mondo (fonti internazionali, anche in inglese; scrivi comunque in italiano)',
};
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

type Topic = { id: string; label: string; focus?: string; exclude?: string; area?: string | null };
type Settings = { area?: string; maxAgeDays?: number; profile?: string };
type WebChunk = { uri: string; title: string };
// deno-lint-ignore no-explicit-any
type Body = { mode?: string; force?: boolean; topicId?: string; model?: string; stream?: boolean; request?: any };
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
  const mode = body.mode === 'proxy' || body.mode === 'models' ? body.mode : 'more';
  const limit = mode === 'more' ? MAX_MORE_PER_HOUR : MAX_PROXY_PER_HOUR;
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await admin.from('feed_runs').select('id', { count: 'exact', head: true })
    .eq('user_id', user.id).eq('kind', mode).gte('started_at', since);
  if ((count ?? 0) >= limit) return json({ error: { message: 'dayflow-rate' } }, 429);
  try {
    if (mode === 'proxy') return await proxyGemini(admin, user.id, body);
    if (mode === 'models') return await listModels(admin, user.id);
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
    try { await generateForUser(admin, p.id, 'morning', MORNING_TOTAL); }
    catch (e) { console.error('morning', p.id, e); }
  }
  const old = new Date(Date.now() - KEEP_DAYS * 86400_000).toISOString();
  await admin.from('feed_items').delete().lt('created_at', old);
  await admin.from('feed_runs').delete().lt('started_at', new Date(Date.now() - 60 * 86400_000).toISOString());
}

// ── generazione per un utente ──────────────────────────────────────────────
async function generateForUser(admin: SupabaseClient, userId: string, kind: 'morning' | 'more', total: number, topicId?: string) {
  const t0 = Date.now();
  const { data: prof } = await admin.from('profiles').select('feed_topics, feed_settings').eq('id', userId).maybeSingle();
  const settings: Settings = prof?.feed_settings ?? {};
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
  const area = AREAS[topic.area || settings.area || 'misto'] ?? AREAS.misto;
  const prompt = buildPrompt(topic, n, maxAgeDays, area, seen, settings.profile);
  const { text, gm, usage, model } = await gemini(prompt);
  const raw = extractJSON(text);
  if (!Array.isArray(raw)) throw new Error('risposta non è un array');
  const chunks: WebChunk[] = (gm?.groundingChunks ?? []).map((c: { web?: WebChunk }) => c.web).filter(Boolean);
  const perItem = mapSources(raw, text, gm);
  const resolved = await resolveAll(chunks.map(c => c.uri));
  const now = Date.now();
  const items = [];
  for (let i = 0; i < raw.length; i++) {
    const it = raw[i] ?? {};
    const title = clean(it.title, 200);
    if (!title) continue;
    const pub = parseDate(it.publishedAt);
    if (pub && (now - pub.getTime() > HARD_MAX_AGE_DAYS * 86400_000)) continue;
    const srcs = perItem[i].map(j => ({ title: chunks[j]?.title ?? '', uri: chunks[j]?.uri ?? '', url: resolved.get(chunks[j]?.uri ?? '') ?? null }))
      .filter(s => s.uri);
    const modelHost = host(it.url);
    // Link: la fonte Google dello stesso sito del link dichiarato, altrimenti la prima fonte Google.
    // Un link che non corrisponde a nessuna fonte trovata non si usa (potrebbe essere inventato).
    const match = srcs.find(s => s.url && modelHost && host(s.url) === modelHost);
    const url = match?.url ?? srcs.find(s => s.url)?.url ?? null;
    const q = it.quality ?? {};
    items.push({
      topic_id: topic.id,
      subtopic: clean(it.subtopic, 60),
      tags: Array.isArray(it.tags) ? it.tags.map((t: unknown) => clean(t, 30).toLowerCase()).filter(Boolean).slice(0, 6) : [],
      type: (TYPES as readonly string[]).includes(it.type) ? it.type : 'notizia',
      title,
      title_key: titleKey(title),
      summary: clean(it.summary, 1200),
      why: clean(it.whyItMatters, 400),
      source: clean(it.source, 80) || srcs[0]?.title || '',
      url,
      sources: srcs,
      published_at: pub && pub.getTime() <= now + 86400_000 ? pub.toISOString() : null,
      q_specificity: score(q.specificity), q_novelty: score(q.novelty), q_importance: score(q.importance),
    });
  }
  return { items, usage, model, queries: (gm?.webSearchQueries ?? []).length };
}

function buildPrompt(t: Topic, n: number, days: number, area: string, seen: string[], profile?: string) {
  const today = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
  return `Oggi è ${today}. Usa Google Search per trovare notizie VERE pubblicate negli ultimi ${days} giorni sull'argomento "${t.label}", poi scegli le ${n} più interessanti per un lettore curioso e già informato.
${t.focus ? `Focus: ${t.focus}.\n` : ''}${t.exclude ? `Escludi: ${t.exclude}.\n` : ''}Area geografica preferita: ${area}.
${profile ? `\nPROFILO DEI GUSTI DELL'UTENTE:\n${profile}\n` : ''}
CRITERI:
- Specifiche: fatti, numeri, nomi concreti. Niente notizie generiche, gossip, comunicati promozionali, liste di consigli.
- Nuove e rilevanti: preferisci ciò che cambia qualcosa o che un appassionato vorrebbe sapere.
- Mescola i tipi: notizie, analisi, curiosità, cose "da tenere d'occhio".
- Varia i sotto-argomenti.
- Ogni voce deve basarsi su una fonte trovata con la ricerca. Non inventare fatti, fonti, link o dichiarazioni.
${seen.length ? `\nGIÀ MOSTRATE ALL'UTENTE (non riproporle, nemmeno riformulate o con un altro angolo sullo stesso fatto):\n${seen.map(s => '- ' + s).join('\n')}\n` : ''}
Rispondi SOLO con un array JSON dentro un blocco \`\`\`json, senza altro testo. Ogni voce ha questi campi, in quest'ordine:
- "title": titolo in italiano, massimo 12 parole, niente clickbait
- "subtopic": sotto-argomento breve
- "tags": 2-4 parole chiave minuscole
- "type": uno tra ${TYPES.map(x => `"${x}"`).join(', ')}
- "summary": 2-3 frasi concrete in italiano: cosa è successo, con fatti, numeri e nomi
- "whyItMatters": una frase su perché conta
- "source": nome della testata o del sito da cui viene il fatto
- "url": link all'articolo originale, solo se lo hai trovato con la ricerca, altrimenti ""
- "publishedAt": data di pubblicazione, formato YYYY-MM-DD (con THH:MM se la conosci)
- "quality": oggetto con "specificity", "novelty", "importance", interi da 1 a 5, dati con severità`;
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
async function gemini(prompt: string): Promise<{ text: string; gm: any; usage: Usage; model: string }> {
  const build = (m: string) => {
    const generationConfig: Record<string, unknown> = { temperature: TEMPERATURE };
    const tc = thinkingConfig(m); if (tc) generationConfig.thinkingConfig = tc;
    return { url: `${API}models/${encodeURIComponent(m)}:generateContent`, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], tools: [{ google_search: {} }], generationConfig }) };
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
  }));
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
