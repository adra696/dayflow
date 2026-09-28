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

const FR = {
  halfLifeH: 36,     // freschezza dimezzata ogni 36 ore
  minFresh: 0.15,    // anche le notizie di qualche giorno restano in gioco
  exploreEvery: 6,   // 6ª, 12ª, … card = esplorazione
  wMin: 0.4, wMax: 2.5,
  defaultQ: 0.6,     // qualità se Gemini non ha dato voti (card generate dal client)
  negDecay: 0.85     // ogni segnale negativo moltiplica il peso per questo fattore
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

// events: [{ topic_id, kind }] (ultimi 30 giorni). Tasso d'interesse con smoothing
// (pos+1)/(viste+5), normalizzato sulla media: 1 = argomento nella media.
function topicWeights(events, topicIds) {
  const st = {};
  topicIds.forEach(id => { st[id] = { views: 0, pos: 0, neg: 0 }; });
  (events || []).forEach(e => {
    const s = e && st[e.topic_id]; if (!s) return;
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
function feedScore(c, w, now = Date.now()) {
  return feedQuality(c) * ((w && w[c.topicId]) ?? 1) * feedFreshness(feedAgeHours(c, now));
}

// items: card candidate; w: pesi per argomento.
// opts.offset = card già presenti nel feed (per le posizioni di esplorazione e l'apertura),
// opts.prevTypes = tipi delle ultime card già mostrate (regola dei 3 di fila).
function rankFeedItems(items, w = {}, { now = Date.now(), offset = 0, prevTypes = [] } = {}) {
  const rest = (items || []).map(c => ({ c, s: feedScore(c, w, now) })).sort((a, b) => b.s - a.s);
  const out = [];
  const types = prevTypes.slice(-2);
  const push = i => { const { c } = rest.splice(i, 1)[0]; out.push(c); types.push(c.type || ''); if (types.length > 2) types.shift(); };
  if (offset === 0 && rest.length) {
    let bi = 0, bv = -1;
    rest.forEach((x, i) => {
      const imp = Array.isArray(x.c.q) && Number.isFinite(x.c.q[2]) ? x.c.q[2] : 3;
      const v = imp * feedFreshness(feedAgeHours(x.c, now)) * (0.5 + feedQuality(x.c));
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
        const v = feedQuality(x.c) * feedFreshness(feedAgeHours(x.c, now));
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

export { FR, feedQuality, feedAgeHours, feedFreshness, topicWeights, feedScore, rankFeedItems };
