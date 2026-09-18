import './setup.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { S, setStateHooks, getDay, calcPct, calcAvg } from '../js/state.js';
import { ensureEventi } from '../js/calendario.js';
import { todayStr, offsetDate } from '../js/utils.js';

setStateHooks({ ensureEventi });

// Date fisse nel passato (calcAvg scarta i giorni futuri) su un lunedì → isoDow noto per gli impegni
const MON = '2024-01-01', TUE = '2024-01-02', WED = '2024-01-03';

function habit(id, extra = {}) { return { id, nome: id, frequenza: 'giornaliera', targetSettimanale: 0, ordine: 0, attiva: true, ...extra }; }

beforeEach(() => { S.habits = []; S.days = {}; S.impegniRicorrenti = []; });

test('calcPct: giorno mai aperto → null', () => {
  assert.equal(calcPct(MON), null);
});

test('calcPct: giorno aperto senza abitudini, compiti né impegni → 0', () => {
  getDay(MON);
  assert.equal(calcPct(MON), 0);
});

test('calcPct: abitudini attive contano 1 ciascuna, le inattive no', () => {
  S.habits = [habit('a'), habit('b'), habit('c', { attiva: false })];
  const d = getDay(MON);
  d.abitudini.a = { completato: true };
  assert.equal(calcPct(MON), 50); // 1 su 2 (c inattiva è ignorata)
});

test('calcPct: abitudini saltate escluse dal totale', () => {
  S.habits = [habit('a'), habit('b', { frequenza: 'settimanale', targetSettimanale: 3 })];
  const d = getDay(MON);
  d.abitudini.a = { completato: true };
  d.abitudini.b = { completato: false, saltato: true };
  assert.equal(calcPct(MON), 100);
});

test('calcPct: abitudine saltata non conta come completata anche se completato=true', () => {
  S.habits = [habit('a'), habit('b')];
  const d = getDay(MON);
  d.abitudini.b = { completato: true, saltato: true };
  assert.equal(calcPct(MON), 0); // solo "a" nel totale, non completata
});

test('calcPct: ogni compito compilato pesa 1 (non un unico +1 per le attività del giorno)', () => {
  // NB: la spec (istruzioni.txt §6.1 e CLAUDE.md) descrive "+1 per le attività del giorno";
  // il codice attuale conta invece ogni compito non vuoto come voce a sé, completato per indice.
  S.habits = [habit('a')];
  const d = getDay(MON);
  d.abitudini.a = { completato: true };
  d.attivitaDelGiorno.compiti = ['x', 'y', ''];
  d.attivitaDelGiorno.completatiTask = [true, false, false];
  assert.equal(calcPct(MON), 67); // 2 fatte (a + x) su 3 voci (a, x, y)
});

test('calcPct: compiti vuoti non contano; compito vuoto flaggato non conta come fatto', () => {
  const d = getDay(MON);
  d.attivitaDelGiorno.compiti = ['solo', '', '   '];
  d.attivitaDelGiorno.completatiTask = [true, true, true];
  assert.equal(calcPct(MON), 100);
});

test('calcPct: tutte le attività del giorno completate contano quanto le abitudini', () => {
  S.habits = [habit('a')];
  const d = getDay(MON);
  d.attivitaDelGiorno.compiti = ['x', 'y', 'z'];
  d.attivitaDelGiorno.completatiTask = [true, true, true];
  assert.equal(calcPct(MON), 75); // 3 su 4
});

test('calcPct: impegni ricorrenti del giorno entrano nel calcolo (per giorno ISO della settimana)', () => {
  S.impegniRicorrenti = [
    { id: 'i1', nome: 'palestra', giorniSettimana: [1], attivo: true },   // lunedì
    { id: 'i2', nome: 'corso', giorniSettimana: [2], attivo: true },      // martedì: non conta lunedì
    { id: 'i3', nome: 'off', giorniSettimana: [1], attivo: false },       // disattivato
  ];
  const d = getDay(MON);
  assert.equal(calcPct(MON), 0);
  d.impegniRicorrentiCompletati.i1 = true;
  assert.equal(calcPct(MON), 100);
  getDay(TUE);
  assert.equal(calcPct(TUE), 0); // i2 presente, non completato
});

test('calcPct: mix abitudine + compito + impegno, arrotondato', () => {
  S.habits = [habit('a')];
  S.impegniRicorrenti = [{ id: 'i1', nome: 'p', giorniSettimana: [1, 2, 3, 4, 5, 6, 7] }]; // attivo se attivo !== false
  const d = getDay(MON);
  d.abitudini.a = { completato: true };
  d.attivitaDelGiorno.compiti = ['x', '', ''];
  assert.equal(calcPct(MON), 33); // 1 su 3
});

test('calcAvg: media solo sui giorni aperti; i giorni mai aperti non contano', () => {
  S.habits = [habit('a')];
  getDay(MON).abitudini.a = { completato: true };   // 100
  getDay(WED).abitudini.a = { completato: false };  // 0
  assert.equal(calcAvg([MON, TUE, WED]), 50);       // TUE mai aperto → ignorato
});

test('calcAvg: nessun giorno con dati → null', () => {
  assert.equal(calcAvg([MON, TUE]), null);
  assert.equal(calcAvg([]), null);
});

test('calcAvg: i giorni futuri sono esclusi anche se aperti', () => {
  S.habits = [habit('a')];
  const tomorrow = offsetDate(todayStr(), 1);
  getDay(tomorrow).abitudini.a = { completato: true };
  getDay(MON).abitudini.a = { completato: false };
  assert.equal(calcAvg([MON, tomorrow]), 0);
});

test('calcAvg: arrotonda la media all\'intero', () => {
  S.habits = [habit('a'), habit('b'), habit('c')];
  getDay(MON).abitudini.a = { completato: true };   // 33
  getDay(TUE).abitudini.a = { completato: true };   // 33
  getDay(WED);                                       // 0
  assert.equal(calcAvg([MON, TUE, WED]), 22);       // (33+33+0)/3 = 22
});
