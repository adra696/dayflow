import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArticleText, articleFromBlocks, applyFeedSettingsOps, normalizeTopic } from '../js/discover.js';
import { feedSourceCount } from '../js/feedrank.js';

test('parseArticleText: 3 punti "In breve" dopo il titolo, poi le sezioni', () => {
  const r = parseArticleText('Titolo\n\n- Primo punto\n- Secondo punto\n- Terzo punto\n\n## Contesto\n\nPrimo paragrafo.\n\nSecondo paragrafo.', true);
  assert.equal(r.title, 'Titolo');
  assert.deepEqual(r.tldr, ['Primo punto', 'Secondo punto', 'Terzo punto']);
  assert.deepEqual(r.blocks, [{ tag: 'h3', text: 'Contesto' }, { tag: 'p', text: 'Primo paragrafo.' }, { tag: 'p', text: 'Secondo paragrafo.' }]);
});

test('parseArticleText: etichetta "In breve" saltata, punti in streaming, trattini dopo le sezioni = paragrafi', () => {
  const s = parseArticleText('Titolo\n\n**In breve:**\n- Uno\n- Du', false);
  assert.deepEqual(s.tldr, ['Uno', 'Du']); // l'ultima riga incompleta si vede già
  assert.deepEqual(s.blocks, []);
  const f = parseArticleText('Titolo\n\n## In breve\n- a\n- b\n- c\n\n## Sezione\n\n- non è un punto', true);
  assert.deepEqual(f.tldr, ['a', 'b', 'c']);
  assert.deepEqual(f.blocks, [{ tag: 'h3', text: 'Sezione' }, { tag: 'p', text: '- non è un punto' }]);
});

test('articleFromBlocks: tldr (max 3) solo se presente; articoli vecchi senza tldr', () => {
  const blocks = [{ tag: 'h3', text: 'S' }, { tag: 'p', text: 'P' }];
  assert.deepEqual(articleFromBlocks('T', blocks), { title: 'T', sections: [{ heading: 'S', paragraphs: ['P'] }] });
  assert.deepEqual(articleFromBlocks('T', blocks, ['a', 'b', 'c', 'd']).tldr, ['a', 'b', 'c']);
  assert.equal('tldr' in articleFromBlocks('T', blocks, []), false);
});

test('applyFeedSettingsOps: modifica senza perdere le altre chiavi', () => {
  const remote = { area: 'italia', profile: 'dal cloud', maxAgeDays: 3, prefs: { moreSub: ['tech:AI'], altro: 1 } };
  const out = applyFeedSettingsOps(remote, [
    { k: 'area', v: 'mondo' },
    { list: 'moreSub', add: 'tech:ai' },        // già presente (maiuscole diverse): una sola voce, l'ultima
    { list: 'lessSub', add: 'sport:calcio' },
    { list: 'blockedSources', add: 'blogx.com' },
    { list: 'blockedSources', del: 'BLOGX.com' }
  ]);
  assert.deepEqual(out, {
    area: 'mondo', profile: 'dal cloud', maxAgeDays: 3,
    prefs: { moreSub: ['tech:ai'], altro: 1, lessSub: ['sport:calcio'], blockedSources: [] }
  });
  assert.deepEqual(remote.prefs.moreSub, ['tech:AI']); // l'originale non cambia
  assert.deepEqual(applyFeedSettingsOps(null, []), { prefs: {} });
});

test('normalizeTopic: conserva focus, esclusioni, area e livello (fase 4)', () => {
  const t = normalizeTopic({ id: 'tech', label: 'Tech', emoji: '🔵', color: '#fff', focus: '  chip   e startup ', exclude: 'x'.repeat(400), area: 'europa', level: 'tecnico' });
  assert.equal(t.focus, 'chip e startup');
  assert.equal(t.exclude.length, 300);
  assert.equal(t.area, 'europa');
  assert.equal(t.level, 'tecnico');
  const d = normalizeTopic({ id: 'a', label: 'A', area: 'marte', level: '??' });
  assert.equal(d.area, null);           // null = area generale
  assert.equal(d.level, 'divulgativo');
  assert.equal(d.focus, '');
});

test('feedSourceCount: la fonte principale senza link non si conta se ci sono fonti della ricerca', () => {
  assert.equal(feedSourceCount({ source: 'Corriere della Sera', url: '', sources: [{ title: 'corriere.it', url: '' }] }), 1);
  assert.equal(feedSourceCount({ source: 'Corriere della Sera', url: '' }), 1);
});
