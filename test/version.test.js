import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_VERSION } from '../js/state.js';

test('APP_VERSION coincide con la CACHE del service worker', () => {
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  const m = /const CACHE = 'dayflow-(v\d+)'/.exec(sw);
  assert.ok(m, 'CACHE non trovata in sw.js');
  assert.equal(APP_VERSION, m[1]);
});
