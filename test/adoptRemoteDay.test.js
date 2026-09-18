import './setup.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { S, setStateHooks, getDay } from '../js/state.js';
import { adoptRemoteDay, pendingSync, restoredPending } from '../js/sync.js';
import { ensureEventi } from '../js/calendario.js';

setStateHooks({ ensureEventi });

const DS = '2024-01-01';
function remoteDay(timestamp, extra = {}) {
  return { data: DS, abitudini: { h: { completato: true } }, attivitaDelGiorno: { compiti: ['r', '', ''], altaPriorita: [false, false, false], completato: false }, impegniRicorrentiCompletati: {}, eventi: [], note: 'remote', timestamp, ...extra };
}

beforeEach(() => { S.days = {}; pendingSync.clear(); restoredPending.clear(); });

test('adoptRemoteDay: remoto nullo → false, nessun cambiamento', () => {
  assert.equal(adoptRemoteDay(DS, null), false);
  assert.equal(S.days[DS], undefined);
});

test('adoptRemoteDay: nessun giorno locale → il remoto viene adottato', () => {
  const r = remoteDay(100);
  assert.equal(adoptRemoteDay(DS, r), true);
  assert.equal(S.days[DS], r);
});

test('adoptRemoteDay: remoto più recente sostituisce il locale', () => {
  const local = getDay(DS); local.timestamp = 100; local.note = 'local';
  const r = remoteDay(200);
  assert.equal(adoptRemoteDay(DS, r), true);
  assert.equal(S.days[DS], r);
  assert.equal(S.days[DS].note, 'remote');
});

test('adoptRemoteDay: timestamp uguale → locale tenuto (è il nostro stesso salvataggio)', () => {
  const local = getDay(DS); local.timestamp = 100; local.note = 'local';
  assert.equal(adoptRemoteDay(DS, remoteDay(100)), false);
  assert.equal(S.days[DS], local);
});

test('adoptRemoteDay: remoto più vecchio → locale tenuto', () => {
  const local = getDay(DS); local.timestamp = 300;
  assert.equal(adoptRemoteDay(DS, remoteDay(200)), false);
  assert.equal(S.days[DS], local);
});

test('adoptRemoteDay: locale con timestamp 0 (mai modificato) → remoto vince', () => {
  const local = getDay(DS);
  assert.equal(local.timestamp, 0);
  const r = remoteDay(1);
  assert.equal(adoptRemoteDay(DS, r), true);
  assert.equal(S.days[DS], r);
});

test('adoptRemoteDay: timestamp mancanti trattati come 0 (remoto senza timestamp non batte il locale a 0)', () => {
  const local = getDay(DS);
  assert.equal(adoptRemoteDay(DS, remoteDay(undefined)), false);
  assert.equal(S.days[DS], local);
});

test('adoptRemoteDay: giorno in pendingSync (modificato in sessione) → mai sovrascritto, anche se il remoto è più nuovo', () => {
  const local = getDay(DS); local.timestamp = 100;
  pendingSync.add(DS);
  assert.equal(adoptRemoteDay(DS, remoteDay(999)), false);
  assert.equal(S.days[DS], local);
  assert.ok(pendingSync.has(DS)); // resta in coda
});

test('adoptRemoteDay: giorno restored con remoto più recente → adottato e tolto dalla coda', () => {
  const local = getDay(DS); local.timestamp = 100;
  pendingSync.add(DS); restoredPending.add(DS);
  const r = remoteDay(200);
  assert.equal(adoptRemoteDay(DS, r), true);
  assert.equal(S.days[DS], r);
  assert.equal(pendingSync.has(DS), false);
  assert.equal(restoredPending.has(DS), false);
});

test('adoptRemoteDay: giorno restored con remoto uguale o più vecchio → locale tenuto e ancora in coda', () => {
  const local = getDay(DS); local.timestamp = 200;
  pendingSync.add(DS); restoredPending.add(DS);
  assert.equal(adoptRemoteDay(DS, remoteDay(200)), false);
  assert.equal(adoptRemoteDay(DS, remoteDay(150)), false);
  assert.equal(S.days[DS], local);
  assert.ok(pendingSync.has(DS));
  assert.ok(restoredPending.has(DS));
});

test('adoptRemoteDay: remoto senza eventi non cancella gli eventi locali', () => {
  const local = getDay(DS); local.timestamp = 100;
  local.eventi = [{ id: 'e1', titolo: 'Dentista', tipo: 'impegno', tuttoIlGiorno: false, ora: '09:00', durata: 60, completato: false }];
  const r = remoteDay(200, { eventi: undefined });
  assert.equal(adoptRemoteDay(DS, r), true);
  assert.equal(S.days[DS], r);
  assert.equal(S.days[DS].eventi, local.eventi);
  assert.equal(S.days[DS].eventi[0].id, 'e1');
});

test('adoptRemoteDay: remoto senza eventi e nessun locale → eventi = []', () => {
  const r = remoteDay(100, { eventi: undefined });
  adoptRemoteDay(DS, r);
  assert.deepEqual(S.days[DS].eventi, []);
});

test('adoptRemoteDay: remoto con eventi propri li mantiene', () => {
  const local = getDay(DS); local.timestamp = 100;
  local.eventi = [{ id: 'loc' }];
  const r = remoteDay(200, { eventi: [{ id: 'rem' }] });
  adoptRemoteDay(DS, r);
  assert.deepEqual(S.days[DS].eventi, [{ id: 'rem' }]);
});

test('adoptRemoteDay: non tocca il timestamp del remoto adottato', () => {
  getDay(DS);
  const r = remoteDay(500);
  adoptRemoteDay(DS, r);
  assert.equal(S.days[DS].timestamp, 500);
});
