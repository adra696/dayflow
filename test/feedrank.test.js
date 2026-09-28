import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FR, feedQuality, feedFreshness, topicWeights, rankFeedItems } from '../js/feedrank.js';

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
