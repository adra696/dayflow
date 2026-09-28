import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FR, feedQuality, feedFreshness, topicWeights, rankFeedItems,
  feedDomain, feedSourceCount, feedCardBlocked, subtopicMult, titleWords, jaccard, mergeNearDuplicates
} from '../js/feedrank.js';

const NOW = Date.parse('2026-09-28T08:00:00Z');
const H = 3600000;
const card = (id, topicId, q, ageH = 2, type = 'notizia') => ({ id, topicId, q, type, pubAt: NOW - ageH * H });

test('feedQuality: voti 1-5 → 0..1, default senza voti', () => {
  assert.equal(feedQuality({ q: [5, 5, 5] }), 1);
  assert.equal(feedQuality({ q: [1, 1, 1] }), 0.2);
  assert.equal(feedQuality({}), FR.defaultQ);
  assert.equal(feedQuality({ q: [4, null, 3] }), FR.defaultQ);
});

test('feedFreshness: dimezza ogni halfLifeH, mai sotto minFresh', () => {
  assert.equal(feedFreshness(0), 1);
  assert.equal(feedFreshness(FR.halfLifeH), 0.5);
  assert.equal(feedFreshness(24 * 30), FR.minFresh);
});

test('topicWeights: le aperture alzano il peso, gli skip no, il 👎 lo abbassa', () => {
  const ev = [
    ...Array(10).fill({ topic_id: 'tech', kind: 'view' }),
    ...Array(6).fill({ topic_id: 'tech', kind: 'open' }),
    ...Array(10).fill({ topic_id: 'sport', kind: 'view' }),
    ...Array(10).fill({ topic_id: 'crypto', kind: 'skip' }),
  ];
  const w = topicWeights(ev, ['tech', 'sport', 'crypto']);
  assert.ok(w.tech > 1 && w.tech > w.sport);
  assert.equal(w.sport, w.crypto); // skip = vista, non penalità
  const w2 = topicWeights([...ev, { topic_id: 'sport', kind: 'down' }], ['tech', 'sport', 'crypto']);
  assert.ok(w2.sport < w2.crypto);
});

test('topicWeights: per ogni notizia conta solo il voto più recente (eventi dal più recente)', () => {
  const ids = ['tech', 'sport'];
  const base = topicWeights([], ids);
  // 👎 poi annullato: nessun effetto
  const undone = topicWeights([{ item_id: 'a', topic_id: 'sport', kind: 'unvote' }, { item_id: 'a', topic_id: 'sport', kind: 'down' }], ids);
  assert.deepEqual(undone, base);
  // 👍 cambiato in 👎: conta solo il 👎
  const flipped = topicWeights([{ item_id: 'b', topic_id: 'tech', kind: 'down' }, { item_id: 'b', topic_id: 'tech', kind: 'up' }], ids);
  assert.ok(flipped.tech < flipped.sport);
  // voti su notizie diverse contano tutti
  const two = topicWeights([{ item_id: 'c', topic_id: 'tech', kind: 'down' }, { item_id: 'd', topic_id: 'tech', kind: 'down' }], ids);
  assert.ok(two.tech < flipped.tech);
});

test('topicWeights: senza eventi tutti a 1', () => {
  assert.deepEqual(topicWeights([], ['a', 'b']), { a: 1, b: 1 });
});

test('rankFeedItems: in cima la più importante, poi per punteggio', () => {
  const items = [card('a', 't', [5, 5, 3]), card('b', 't', [3, 3, 5]), card('c', 't', [2, 2, 2])];
  const r = rankFeedItems(items, { t: 1 }, { now: NOW });
  assert.equal(r[0].id, 'b');
  assert.deepEqual(r.map(c => c.id), ['b', 'a', 'c']);
});

test('rankFeedItems: il peso argomento conta, le notizie vecchie scendono', () => {
  const items = [card('old', 'a', [5, 5, 5], 96), card('fresh', 'a', [4, 4, 4], 1), card('liked', 'b', [3, 3, 3], 2)];
  const r = rankFeedItems(items, { a: 1, b: 2.5 }, { now: NOW, offset: 1 });
  assert.deepEqual(r.map(c => c.id), ['liked', 'fresh', 'old']);
});

test('rankFeedItems: posizione di esplorazione da un argomento sotto la media', () => {
  const items = [];
  for (let i = 0; i < 8; i++) items.push(card('top' + i, 'fav', [4, 4, 4], 1, i % 2 ? 'analisi' : 'notizia'));
  items.push(card('explore', 'rare', [4, 4, 4], 1));
  const r = rankFeedItems(items, { fav: 2, rare: 0.5 }, { now: NOW });
  assert.equal(r[FR.exploreEvery - 1].id, 'explore');
});

test('rankFeedItems: mai 3 dello stesso tipo di fila, se esiste un\'alternativa', () => {
  const items = [card('n1', 't', [5, 5, 5]), card('n2', 't', [5, 5, 4]), card('n3', 't', [5, 4, 4]), card('a1', 't', [2, 2, 2], 2, 'analisi')];
  const r = rankFeedItems(items, { t: 1 }, { now: NOW });
  assert.deepEqual(r.map(c => c.type), ['notizia', 'notizia', 'analisi', 'notizia']);
  const r2 = rankFeedItems([card('x', 't', [5, 5, 5])], { t: 1 }, { now: NOW, offset: 3, prevTypes: ['notizia', 'notizia'] });
  assert.equal(r2.length, 1); // nessuna alternativa: la card resta
});

// ── Fase 4: preferenze esplicite, fonti, quasi-doppioni ──

test('feedDomain: host minuscolo senza www, vuoto se non è un URL', () => {
  assert.equal(feedDomain('https://www.Repubblica.it/economia/x?y=1'), 'repubblica.it');
  assert.equal(feedDomain('http://ansa.it:8080/a'), 'ansa.it');
  assert.equal(feedDomain('ansa.it'), '');
  assert.equal(feedDomain(null), '');
});

test('subtopicMult: "di più" ×1,5, "meno" ×0,4, confronto senza maiuscole', () => {
  const c = { topicId: 'tech', subtopic: 'Intelligenza artificiale' };
  assert.equal(subtopicMult(c, { moreSub: ['tech:intelligenza artificiale'] }), FR.subMore);
  assert.equal(subtopicMult(c, { lessSub: ['tech:Intelligenza Artificiale'] }), FR.subLess);
  assert.equal(subtopicMult(c, { moreSub: ['sport:intelligenza artificiale'] }), 1); // altro argomento
  assert.equal(subtopicMult({ topicId: 'tech' }, { moreSub: ['tech:'] }), 1);         // senza sotto-argomento
});

test('rankFeedItems: il moltiplicatore del sotto-argomento cambia l\'ordine', () => {
  const a = { ...card('a', 't', [4, 4, 4]), subtopic: 'chip' };
  const b = { ...card('b', 't', [4, 4, 4]), subtopic: 'app' };
  const base = rankFeedItems([a, b], { t: 1 }, { now: NOW, offset: 1 }).map(c => c.id);
  assert.deepEqual(base, ['a', 'b']); // parità: resta l'ordine d'ingresso
  assert.deepEqual(rankFeedItems([a, b], { t: 1 }, { now: NOW, offset: 1, moreSub: ['t:app'] }).map(c => c.id), ['b', 'a']);
  assert.deepEqual(rankFeedItems([a, b], { t: 1 }, { now: NOW, offset: 1, lessSub: ['t:chip'] }).map(c => c.id), ['b', 'a']);
  // anche l'apertura (offset 0) tiene conto del "meno su"
  const top = { ...card('top', 't', [3, 3, 5]), subtopic: 'chip' };
  const r = rankFeedItems([top, card('x', 't', [3, 3, 4])], { t: 1 }, { now: NOW, lessSub: ['t:chip'] });
  assert.equal(r[0].id, 'x');
});

test('fonti bloccate: card esclusa solo se tutte le sue fonti sono bloccate', () => {
  const solo = { ...card('solo', 't', [4, 4, 4]), source: 'Blog X', url: 'https://www.blogx.com/a' };
  const multi = {
    ...card('multi', 't', [4, 4, 4]), source: 'Blog X', url: 'https://blogx.com/b',
    sources: [{ title: 'blogx.com', url: 'https://blogx.com/b' }, { title: 'ansa.it', url: null }]
  };
  const sub = { ...card('sub', 't', [4, 4, 4]), source: 'News', url: 'https://news.blogx.com/c' };
  const byName = { ...card('name', 't', [4, 4, 4]), source: 'Il Giornale Y' };
  assert.equal(feedCardBlocked(solo, ['blogx.com']), true);
  assert.equal(feedCardBlocked(multi, ['blogx.com']), false);          // ansa.it resta
  assert.equal(feedCardBlocked(multi, ['blogx.com', 'ansa.it']), true);
  assert.equal(feedCardBlocked(sub, ['blogx.com']), true);             // sottodominio
  assert.equal(feedCardBlocked(byName, ['il giornale y']), true);      // per nome
  assert.equal(feedCardBlocked(card('none', 't', [4, 4, 4]), ['blogx.com']), false); // nessuna fonte nota
  const r = rankFeedItems([solo, multi, sub, byName], { t: 1 }, { now: NOW, blockedSources: ['BlogX.com'] });
  assert.deepEqual(r.map(c => c.id).sort(), ['multi', 'name']);
});

test('feedSourceCount: testate diverse per dominio (o nome)', () => {
  assert.equal(feedSourceCount({ source: 'ANSA', url: 'https://www.ansa.it/x' }), 1);
  assert.equal(feedSourceCount({
    source: 'ANSA', url: 'https://www.ansa.it/x',
    sources: [{ title: 'ansa.it', url: 'https://ansa.it/x' }, { title: 'corriere.it', url: null }, { title: 'corriere.it', url: 'https://www.corriere.it/y' }]
  }), 2);
  assert.equal(feedSourceCount({}), 0);
});

test('titleWords / jaccard: parole ≥3 caratteri, senza accenti né parole vuote', () => {
  assert.deepEqual([...titleWords('La BCE alza i tassi dello 0,25% più del previsto')].sort(), ['alza', 'bce', 'previsto', 'tassi']);
  assert.deepEqual([...titleWords('Perché è già così')], ['perche', 'cosi']);
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
  assert.equal(jaccard(new Set(['a', 'b', 'c']), new Set(['a', 'd'])), 0.25);
  assert.equal(jaccard(new Set(), new Set(['a'])), 0);
});

test('mergeNearDuplicates: stesso fatto, stesso argomento → una card con le fonti unite', () => {
  const a = { ...card('a', 'eco', [3, 3, 3]), title: 'La BCE alza i tassi di interesse di 25 punti base', source: 'ANSA', url: 'https://www.ansa.it/bce' };
  const b = { ...card('b', 'eco', [4, 4, 5]), title: 'BCE alza i tassi di interesse: +25 punti base', source: 'Corriere', url: 'https://www.corriere.it/bce', sources: [{ title: 'ansa.it', url: 'https://ansa.it/bce' }] };
  const c = { ...card('c', 'eco', [4, 4, 4]), title: 'Borsa di Milano chiude in rialzo trainata dalle banche', source: 'Sole 24 Ore', url: 'https://www.ilsole24ore.com/x' };
  const d = { ...card('d', 'altro', [5, 5, 5]), title: 'La BCE alza i tassi di interesse di 25 punti base', source: 'Reuters', url: 'https://reuters.com/x' };
  const out = mergeNearDuplicates([a, b, c, d]);
  assert.deepEqual(out.map(x => x.id), ['b', 'c', 'd']); // tiene la più alta per qualità, nella posizione del gruppo
  const m = out[0];
  assert.notEqual(m, b);                                 // oggetto nuovo, l'originale non cambia
  assert.equal(b.mergedIds, undefined);
  assert.deepEqual(m.mergedIds, ['a']);
  assert.deepEqual(m.sources.map(s => s.title), ['corriere.it', 'ansa.it']); // ansa.it una volta sola
  assert.equal(feedSourceCount(m), 2);
  assert.equal(out[1], c);                               // card senza doppioni: stessa istanza
  assert.equal(out[2], d);                               // stesso titolo ma altro argomento: non unita
});

test('mergeNearDuplicates: titoli con metà delle parole diverse restano separati', () => {
  const a = { ...card('a', 't', [4, 4, 4]), title: 'Apple presenta il nuovo iPhone con chip M5' };
  const b = { ...card('b', 't', [4, 4, 4]), title: 'Apple multata dalla Commissione europea per il nuovo iPhone' };
  assert.ok(jaccard(titleWords(a.title), titleWords(b.title)) < FR.mergeJaccard);
  assert.equal(mergeNearDuplicates([a, b]).length, 2);
  assert.deepEqual(mergeNearDuplicates([]), []);
});

test('rankFeedItems: le regole di base restano con le nuove opzioni', () => {
  const items = [card('n1', 't', [5, 5, 5]), card('n2', 't', [5, 5, 4]), card('n3', 't', [5, 4, 4]), card('a1', 't', [2, 2, 2], 2, 'analisi')];
  const r = rankFeedItems(items, { t: 1 }, { now: NOW, moreSub: [], lessSub: [], blockedSources: [] });
  assert.deepEqual(r.map(c => c.type), ['notizia', 'notizia', 'analisi', 'notizia']);
});
