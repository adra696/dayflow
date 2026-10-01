import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_VERSION, SUPA_URL } from '../js/state.js';

test('APP_VERSION coincide con la CACHE del service worker', () => {
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  const m = /const CACHE = 'dayflow-(v\d+)'/.exec(sw);
  assert.ok(m, 'CACHE non trovata in sw.js');
  assert.equal(APP_VERSION, m[1]);
});

// Lo script inline di index.html riconosce una sessione salvata dalla chiave di default di supabase-js v2
// (sb-<ref del progetto>-auth-token): se cambia il progetto Supabase va cambiata anche lì.
test('index.html cerca la sessione Supabase sotto la chiave del progetto in SUPA_URL', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const ref = new URL(SUPA_URL).hostname.split('.')[0];
  assert.ok(html.includes(`localStorage.getItem('sb-${ref}-auth-token')`), `chiave sb-${ref}-auth-token non trovata in index.html`);
});
