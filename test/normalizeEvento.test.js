import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvento } from '../js/calendario.js';

test('normalizeEvento: input non oggetto → null', () => {
  assert.equal(normalizeEvento(null), null);
  assert.equal(normalizeEvento('x'), null);
  assert.equal(normalizeEvento(42), null);
});

test('normalizeEvento: evento completo resta invariato nei campi', () => {
  const o = normalizeEvento({ id: 'e1', titolo: 'Call', tipo: 'scadenza', tuttoIlGiorno: false, ora: '14:00', durata: 45, completato: true });
  assert.deepEqual(o, { id: 'e1', titolo: 'Call', tipo: 'scadenza', tuttoIlGiorno: false, ora: '14:00', durata: 45, completato: true });
});

test('normalizeEvento: genera id se manca, titolo null → "", tipo sconosciuto → impegno', () => {
  const o = normalizeEvento({ ora: '08:00', tipo: 'altro' });
  assert.equal(typeof o.id, 'string');
  assert.ok(o.id.length > 0);
  assert.equal(o.titolo, '');
  assert.equal(o.tipo, 'impegno');
  assert.equal(o.completato, false);
});

test('normalizeEvento: durata mancante o non valida → 60 min', () => {
  assert.equal(normalizeEvento({ ora: '08:00' }).durata, 60);
  assert.equal(normalizeEvento({ ora: '08:00', durata: 'abc' }).durata, 60);
  assert.equal(normalizeEvento({ ora: '08:00', durata: 0 }).durata, 60);
  assert.equal(normalizeEvento({ ora: '08:00', durata: -5 }).durata, 60);
});

test('normalizeEvento: durata stringa numerica accettata, cap a 1440', () => {
  assert.equal(normalizeEvento({ ora: '08:00', durata: '90' }).durata, 90);
  assert.equal(normalizeEvento({ ora: '08:00', durata: 5000 }).durata, 1440);
});

test('normalizeEvento: ora mancante o malformata → tutto il giorno (ora "", durata 0)', () => {
  for (const ora of [undefined, '', '9', '25h', 123, '9-30']) {
    const o = normalizeEvento({ ora, durata: 30 });
    assert.equal(o.tuttoIlGiorno, true, `ora=${String(ora)}`);
    assert.equal(o.ora, '');
    assert.equal(o.durata, 0);
  }
});

test('normalizeEvento: ora con una cifra ("9:30") è accettata', () => {
  const o = normalizeEvento({ ora: '9:30' });
  assert.equal(o.tuttoIlGiorno, false);
  assert.equal(o.ora, '9:30');
});

test('normalizeEvento: tuttoIlGiorno esplicito azzera ora e durata', () => {
  const o = normalizeEvento({ tuttoIlGiorno: true, ora: '10:00', durata: 120 });
  assert.equal(o.tuttoIlGiorno, true);
  assert.equal(o.ora, '');
  assert.equal(o.durata, 0);
});
