// Punteggio e ordinamento delle notizie di Discover (funzioni pure, senza DOM né rete).
//
//   punteggio = qualità (voto Gemini) × peso argomento × freschezza
//
// Poi l'ordine si costruisce una card alla volta:
//  - apertura: in cima la notizia più importante (importanza × freschezza);
//  - esplorazione: 1 card ogni FR.exploreEvery viene da un argomento che apri meno della media;
//  - tipi: mai 3 card di fila dello stesso tipo (notizia, analisi, …).
// Il peso di un argomento cresce con aperture, chat, salvataggi e condivisioni e cala solo con
// i segnali negativi espliciti (👎, "meno così"); le card scorse via (skip) non penalizzano.
// Preferenze esplicite (feed_settings.prefs): sotto-argomenti "di più" ×1,5 / "meno" ×0,4,
// fonti bloccate (card esclusa solo se TUTTE le sue fonti sono bloccate).
// mergeNearDuplicates() unisce lo stesso fatto riportato da più testate in una card con "N fonti".

const FR = {
  halfLifeH: 36,     // freschezza dimezzata ogni 36 ore
  minFresh: 0.15,    // anche le notizie di qualche giorno restano in gioco
  exploreEvery: 6,   // 6ª, 12ª, … card = esplorazione
  wMin: 0.4, wMax: 2.5,
  defaultQ: 0.6,     // qualità se Gemini non ha dato voti (card generate dal client)
  negDecay: 0.85,    // ogni segnale negativo moltiplica il peso per questo fattore
  subMore: 1.5,      // sotto-argomento in "di più su"
  subLess: 0.4,      // sotto-argomento in "meno su"
  // Jaccard sulle parole dei titoli (≥3 lettere, senza parole vuote). Testate diverse sullo
  // stesso fatto condividono nomi, numeri e verbo chiave: in genere metà delle parole o più.
  // Sotto 0,5 due titoli dello stesso argomento parlano spesso di fatti diversi (stesso
  // protagonista, altra notizia): un'unione sbagliata nasconde una notizia, un'unione mancata
  // mostra solo un quasi-doppione, quindi la soglia resta prudente.
  mergeJaccard: 0.5
};
const FR_POS = { open: 1, chat: 1.5, save: 2, share: 2, up: 3, more: 3 };
const FR_NEG = { down: 1, less: 2 };

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// 0..1: specificità, novità e (con peso maggiore) importanza, voti 1-5.
function feedQuality(c) {
  const q = c && c.q;
  if (!Array.isArray(q) || q.length < 3 || !q.every(Number.isFinite)) return FR.defaultQ;
  return (q[0] + q[1] + 1.5 * q[2]) / (3.5 * 5);
}
function feedAgeHours(c, now = Date.now()) {
  const t = (c && (c.pubAt || c.createdAt)) || now;
  return Math.max(0, (now - t) / 3600000);
}
function feedFreshness(ageH) { return Math.max(FR.minFresh, Math.pow(0.5, ageH / FR.halfLifeH)); }

// events: [{ item_id, topic_id, kind }] (ultimi 30 giorni), DAL PIÙ RECENTE. Tasso d'interesse con
// smoothing (pos+1)/(viste+5), normalizzato sulla media: 1 = argomento nella media.
// 👍/👎/unvote: per ogni notizia conta solo il voto più recente (un voto annullato non pesa).
const FR_VOTES = new Set(['up', 'down', 'unvote']);
function topicWeights(events, topicIds) {
  const st = {};
  topicIds.forEach(id => { st[id] = { views: 0, pos: 0, neg: 0 }; });
  const voted = new Set();
  (events || []).forEach(e => {
    const s = e && st[e.topic_id]; if (!s) return;
    if (FR_VOTES.has(e.kind) && e.item_id) {
      if (voted.has(e.item_id)) return; // voto più vecchio, superato
      voted.add(e.item_id);
    }
    if (e.kind === 'view' || e.kind === 'skip') s.views++;
    s.pos += FR_POS[e.kind] || 0;
    s.neg += FR_NEG[e.kind] || 0;
  });
  const rate = id => (st[id].pos + 1) / (st[id].views + 5);
  const mean = topicIds.reduce((a, id) => a + rate(id), 0) / (topicIds.length || 1);
  const w = {};
  // i 👎 si applicano dopo il clamp: contano anche su un argomento già al minimo
  topicIds.forEach(id => { w[id] = Math.max(0.1, clamp(rate(id) / mean, FR.wMin, FR.wMax) * Math.pow(FR.negDecay, st[id].neg)); });
  return w;
}
// ── Fonti ──
// Dominio senza "www." (minuscolo) da un URL; '' se non è un URL http(s).
function feedDomain(u) {
  const m = /^https?:\/\/([^/?#:]+)/i.exec(String(u || '').trim());
  return m ? m[1].toLowerCase().replace(/^www\./, '') : '';
}
// Le fonti di una card: la principale (source + url) e quelle trovate dalla ricerca
// (sources: [{ title, url }], title spesso = dominio). Deduplicate per dominio (o nome).
// Una principale senza link (solo nome) non si conta se ci sono fonti della ricerca: è quasi
// sempre una di loro, e contarla darebbe "2 fonti" per la stessa testata.
function feedCardSources(c) {
  const out = [], seen = new Set();
  const add = (name, url) => {
    name = String(name || '').trim();
    let domain = feedDomain(url);
    if (!domain && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(name)) domain = name.toLowerCase().replace(/^www\./, '');
    const key = domain || name.toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key); out.push({ name, domain, url: /^https?:\/\//i.test(String(url || '')) ? String(url) : '' });
  };
  if (c) {
    const extra = (Array.isArray(c.sources) ? c.sources : []).filter(s => s && (s.title || s.name || s.url));
    if (feedDomain(c.url) || !extra.length) add(c.source, c.url);
    extra.forEach(s => add(s.title || s.name, s.url));
  }
  return out;
}
// Numero di testate diverse (per "N fonti" sulla card).
function feedSourceCount(c) { return feedCardSources(c).length; }
// blocked: nomi o domini in minuscolo. Un dominio bloccato copre anche i sottodomini.
function feedSourceBlocked(src, blocked) {
  if (!blocked || !blocked.length) return false;
  const name = String(src.name || '').trim().toLowerCase(), d = src.domain;
  return blocked.some(b => b && (b === name || (d && (d === b || d.endsWith('.' + b)))));
}
// Card esclusa solo se tutte le sue fonti sono bloccate (un fatto ripreso da altre testate resta).
function feedCardBlocked(c, blocked) {
  if (!blocked || !blocked.length) return false;
  const srcs = feedCardSources(c);
  return srcs.length > 0 && srcs.every(s => feedSourceBlocked(s, blocked));
}

// ── Sotto-argomenti ──
// Chiave "topicId:sotto-argomento" (confronto senza maiuscole).
function subtopicKey(topicId, sub) { return (String(topicId || '') + ':' + String(sub || '').trim()).toLowerCase(); }
function subtopicMult(c, opts) {
  if (!c || !c.subtopic || !opts) return 1;
  const k = subtopicKey(c.topicId, c.subtopic);
  const has = l => Array.isArray(l) && l.some(x => String(x || '').trim().toLowerCase() === k);
  return (has(opts.moreSub) ? FR.subMore : 1) * (has(opts.lessSub) ? FR.subLess : 1);
}

function feedScore(c, w, now = Date.now(), opts) {
  return feedQuality(c) * ((w && w[c.topicId]) ?? 1) * feedFreshness(feedAgeHours(c, now)) * subtopicMult(c, opts);
}

// ── Quasi-doppioni ──
const FR_STOP = new Set(('the and for with from that this una uno gli dei del della delle dello degli nel nella nelle nei negli '
  + 'sul sulla sulle sui sugli alla alle allo agli dal dalla dalle dai dagli per con tra fra che chi cui non piu sono '
  + 'come dopo anche suo sua suoi sue loro questo questa quello quella ecco oggi ieri gia verso contro').split(' '));
// Parole normalizzate di un titolo: minuscole, senza accenti, ≥3 caratteri, senza parole vuote.
function titleWords(t) {
  return new Set(String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/).filter(x => x.length >= 3 && !FR_STOP.has(x)));
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  a.forEach(x => { if (b.has(x)) inter++; });
  return inter / (a.size + b.size - inter);
}
// Stesso argomento + titoli simili (Jaccard ≥ FR.mergeJaccard con almeno una card del gruppo)
// → una sola card: resta quella di qualità più alta (a parità, la prima), con le fonti di tutte
// unite (senza doppioni di dominio) e mergedIds = id delle card assorbite (da considerare viste
// insieme a lei). Le card unite sono oggetti nuovi; l'ordine segue la prima comparsa di ogni gruppo.
function mergeNearDuplicates(items) {
  const groups = []; // { topicId, members: [{ c, words, i }] }
  (items || []).filter(Boolean).forEach((c, i) => {
    const words = titleWords(c.title);
    const g = groups.find(g => g.topicId === c.topicId && g.members.some(m => jaccard(m.words, words) >= FR.mergeJaccard));
    if (g) g.members.push({ c, words, i }); else groups.push({ topicId: c.topicId, members: [{ c, words, i }] });
  });
  return groups.map(g => {
    if (g.members.length === 1) return g.members[0].c;
    const best = g.members.slice().sort((a, b) => (feedQuality(b.c) - feedQuality(a.c)) || (a.i - b.i))[0].c;
    const others = g.members.map(m => m.c).filter(c => c !== best);
    const sources = [], seen = new Set();
    [best, ...others].forEach(c => feedCardSources(c).forEach(s => {
      const k = s.domain || s.name.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k); sources.push({ title: s.domain || s.name, url: s.url });
    }));
    const mergedIds = [...(best.mergedIds || [])];
    others.forEach(c => { mergedIds.push(c.id, ...(c.mergedIds || [])); });
    return Object.assign({}, best, { sources, mergedIds });
  });
}

// items: card candidate; w: pesi per argomento.
// opts.offset = card già presenti nel feed (per le posizioni di esplorazione e l'apertura),
// opts.prevTypes = tipi delle ultime card già mostrate (regola dei 3 di fila),
// opts.moreSub / opts.lessSub = ["topicId:sotto-argomento"], opts.blockedSources = [nome o dominio].
function rankFeedItems(items, w = {}, { now = Date.now(), offset = 0, prevTypes = [], moreSub = [], lessSub = [], blockedSources = [] } = {}) {
  const sub = { moreSub, lessSub };
  const blocked = (blockedSources || []).map(b => String(b || '').trim().toLowerCase()).filter(Boolean);
  const rest = (items || []).filter(c => c && !feedCardBlocked(c, blocked))
    .map(c => ({ c, s: feedScore(c, w, now, sub) })).sort((a, b) => b.s - a.s);
  const out = [];
  const types = prevTypes.slice(-2);
  const push = i => { const { c } = rest.splice(i, 1)[0]; out.push(c); types.push(c.type || ''); if (types.length > 2) types.shift(); };
  if (offset === 0 && rest.length) {
    let bi = 0, bv = -1;
    rest.forEach((x, i) => {
      const imp = Array.isArray(x.c.q) && Number.isFinite(x.c.q[2]) ? x.c.q[2] : 3;
      const v = imp * feedFreshness(feedAgeHours(x.c, now)) * (0.5 + feedQuality(x.c)) * subtopicMult(x.c, sub);
      if (v > bv) { bv = v; bi = i; }
    });
    push(bi);
  }
  while (rest.length) {
    const pos = offset + out.length;
    let idx = 0;
    if (pos > 0 && (pos + 1) % FR.exploreEvery === 0) {
      // argomento poco aperto (peso < 1): la migliore per qualità × freschezza, senza peso
      let bv = -1;
      rest.forEach((x, i) => {
        if (((w && w[x.c.topicId]) ?? 1) >= 1) return;
        const v = feedQuality(x.c) * feedFreshness(feedAgeHours(x.c, now)) * subtopicMult(x.c, sub);
        if (v > bv) { bv = v; idx = i; }
      });
    }
    const t = rest[idx].c.type || '';
    if (t && types.length === 2 && types[0] === t && types[1] === t) {
      const j = rest.findIndex(x => (x.c.type || '') !== t);
      if (j >= 0) idx = j;
    }
    push(idx);
  }
  return out;
}

export {
  FR, feedQuality, feedAgeHours, feedFreshness, topicWeights, feedScore, rankFeedItems,
  feedDomain, feedCardSources, feedSourceCount, feedSourceBlocked, feedCardBlocked, subtopicKey, subtopicMult,
  titleWords, jaccard, mergeNearDuplicates
};
