import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArticleText, articleFromBlocks, applyFeedSettingsOps, normalizeTopic, ttsSplit, ttsChunks, ttsArticleParts } from '../js/discover.js';
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

test('ttsSplit: testo corto intero, spazi compattati, vuoto = nessun pezzo', () => {
  assert.deepEqual(ttsSplit('  Ciao   mondo. '), ['Ciao mondo.']);
  assert.deepEqual(ttsSplit('   '), []);
});

test('ttsSplit: testo lungo diviso ai confini di frase, pezzi <= max', () => {
  const s = 'Prima frase abbastanza lunga. Seconda frase! Terza frase? Quarta.';
  const out = ttsSplit(s, 30);
  assert.deepEqual(out, ['Prima frase abbastanza lunga.', 'Seconda frase! Terza frase?', 'Quarta.']);
  assert.equal(out.join(' '), s);
});

test('ttsSplit: frase più lunga del massimo tagliata a una virgola o a uno spazio', () => {
  const s = 'uno due tre quattro, cinque sei sette otto nove dieci undici dodici';
  const out = ttsSplit(s, 30);
  assert.ok(out.every(x => x.length <= 30), JSON.stringify(out));
  assert.equal(out[0], 'uno due tre quattro,');
  assert.equal(out.join(' '), s);
  const long = 'a'.repeat(3200);
  const hard = ttsSplit(long, 1500);
  assert.deepEqual(hard.map(x => x.length), [1500, 1500, 200]);
});

test('ttsSplit: default 1500 caratteri; ttsChunks tiene l\'indice della parte', () => {
  const para = Array.from({ length: 60 }, (_, i) => 'Questa è la frase numero ' + i + ' del paragrafo di prova.').join(' ');
  const out = ttsSplit(para);
  assert.ok(out.length >= 2 && out.every(x => x.length <= 1500));
  assert.equal(out.join(' '), para);
  const ch = ttsChunks(['Titolo', para]);
  assert.deepEqual(ch[0], { text: 'Titolo', part: 0 });
  assert.ok(ch.slice(1).every(c => c.part === 1));
  assert.equal(ch.length, 1 + out.length);
});

test('ttsArticleParts: parte dal corpo, senza titolo, in breve né riassunto', () => {
  const card = { title: 'Everest pulito', summary: 'Nuove regole per i rifiuti sull\'Everest.' };
  const a = {
    title: 'Everest pulito', tldr: ['uno', 'due', 'tre'],
    sections: [
      { heading: 'In breve', paragraphs: ['- uno', '- due'] },
      { heading: '', paragraphs: ['Everest pulito', '1. punto', 'Nuove regole per i rifiuti sull’Everest.', 'Il primo paragrafo vero.'] },
      { heading: 'Le sanzioni', paragraphs: ['Multe agli alpinisti.'] },
    ],
  };
  assert.deepEqual(ttsArticleParts(a, card), ['Il primo paragrafo vero.', 'Le sanzioni', 'Multe agli alpinisti.']);
  assert.deepEqual(ttsArticleParts({ title: 'T', tldr: ['a', 'b'], sections: [] }), ['a', 'b']);
  assert.deepEqual(ttsArticleParts({ title: 'T', sections: [{ heading: 'Contesto', paragraphs: ['- non è un elenco iniziale ora'] }] }), ['Contesto', '- non è un elenco iniziale ora']);
});
