import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setStateHooks, ensureSlotArrays, getDay, S } from '../js/state.js';
import { ensureEventi } from '../js/calendario.js';

setStateHooks({ ensureEventi });

function rawDay(atd = {}) {
  return { data: '2024-01-01', abitudini: {}, attivitaDelGiorno: { compiti: ['', '', ''], ...atd }, note: '', timestamp: 0 };
}

test('ensureSlotArrays: aggiunge impegniRicorrentiCompletati ed eventi se mancanti', () => {
  const d = rawDay();
  ensureSlotArrays(d);
  assert.deepEqual(d.impegniRicorrentiCompletati, {});
  assert.deepEqual(d.eventi, []);
  assert.deepEqual(d.attivitaDelGiorno.altaPriorita, [false, false, false]);
  assert.deepEqual(d.attivitaDelGiorno.completatiTask, [false, false, false]);
});

test('ensureSlotArrays: impegniRicorrentiCompletati non-oggetto viene resettato', () => {
  const d = rawDay(); d.impegniRicorrentiCompletati = 'x';
  ensureSlotArrays(d);
  assert.deepEqual(d.impegniRicorrentiCompletati, {});
});

test('ensureSlotArrays: compiti non-array → 3 slot vuoti', () => {
  const d = rawDay({ compiti: 'no' });
  ensureSlotArrays(d);
  assert.deepEqual(d.attivitaDelGiorno.compiti, ['', '', '']);
});

test('ensureSlotArrays: altaPriorita e completatiTask allineati alla lunghezza di compiti (pad e taglio)', () => {
  const d = rawDay({ compiti: ['a', 'b'], altaPriorita: [true], completatiTask: [true, false, true, true] });
  ensureSlotArrays(d);
  assert.deepEqual(d.attivitaDelGiorno.altaPriorita, [true, false]);
  assert.deepEqual(d.attivitaDelGiorno.completatiTask, [true, false]);
});

test('ensureSlotArrays: migrazione legacy completatiCount → completatiTask sui compiti non vuoti', () => {
  const d = rawDay({ compiti: ['', 'a', 'b'], completatiCount: 1 });
  ensureSlotArrays(d);
  assert.deepEqual(d.attivitaDelGiorno.completatiTask, [false, true, false]);
});

test('ensureSlotArrays: migrazione legacy completato=true → tutti i compiti non vuoti fatti', () => {
  const d = rawDay({ compiti: ['a', '', 'b'], completato: true });
  ensureSlotArrays(d);
  assert.deepEqual(d.attivitaDelGiorno.completatiTask, [true, false, true]);
});

test('ensureSlotArrays: non tocca il timestamp', () => {
  const d = rawDay(); d.timestamp = 42;
  ensureSlotArrays(d);
  assert.equal(d.timestamp, 42);
});

test('ensureSlotArrays → ensureEventi: eventi non-array → [], eventi legacy normalizzati, voci non valide scartate', () => {
  const d = rawDay(); d.eventi = 'x';
  ensureSlotArrays(d);
  assert.deepEqual(d.eventi, []);

  const d2 = rawDay(); d2.eventi = [{ id: 'e1', titolo: 'Dentista', ora: '09:30' }, null, 'junk'];
  ensureSlotArrays(d2);
  assert.equal(d2.eventi.length, 1);
  assert.equal(d2.eventi[0].durata, 60);
  assert.equal(d2.eventi[0].tuttoIlGiorno, false);
});

test('getDay: un giorno nuovo ha timestamp 0 e le strutture complete', () => {
  S.days = {};
  const d = getDay('2024-01-01');
  assert.equal(d.timestamp, 0);
  assert.deepEqual(d.eventi, []);
  assert.deepEqual(d.impegniRicorrentiCompletati, {});
  assert.equal(S.days['2024-01-01'], d);
  assert.equal(getDay('2024-01-01'), d); // stesso oggetto alla seconda lettura
});
