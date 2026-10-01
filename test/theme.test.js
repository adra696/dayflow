import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { THEMES, ACCENTS, normalizeThemePrefs, loadThemePrefs, THEME_LS } from '../js/theme.js';

test('normalizeThemePrefs: valori validi restano, sconosciuti o mancanti → default', () => {
  assert.deepEqual(normalizeThemePrefs({ theme: 'nero', accent: 'rosa' }), { theme: 'nero', accent: 'rosa' });
  assert.deepEqual(normalizeThemePrefs({ theme: 'boh', accent: 42 }), { theme: 'grafite', accent: 'viola' });
  assert.deepEqual(normalizeThemePrefs(null), { theme: 'grafite', accent: 'viola' });
});

test('loadThemePrefs: JSON rotto in localStorage → default', () => {
  localStorage.setItem(THEME_LS, '{rotto');
  assert.deepEqual(loadThemePrefs(), { theme: 'grafite', accent: 'viola' });
  localStorage.setItem(THEME_LS, JSON.stringify({ theme: 'moka' }));
  assert.deepEqual(loadThemePrefs(), { theme: 'moka', accent: 'viola' });
  localStorage.removeItem(THEME_LS);
});

test('ogni tema e accento non di default ha il suo blocco in tokens.css, e i default sono quelli di :root', () => {
  const css = readFileSync(new URL('../css/tokens.css', import.meta.url), 'utf8');
  THEMES.slice(1).forEach(t => {
    const m = new RegExp(`:root\\[data-theme="${t.id}"\\] \\{([^}]*)\\}`).exec(css);
    assert.ok(m, `manca il tema ${t.id}`);
    assert.match(m[1], new RegExp(`--bg: ${t.bg};`), `--bg di ${t.id} diverso da THEMES`);
  });
  ACCENTS.slice(1).forEach(a => assert.match(css, new RegExp(`:root\\[data-accent="${a.id}"\\] \\{ --accent: ${a.color};`), `manca l'accento ${a.id}`));
  assert.match(css, new RegExp(`--bg: ${THEMES[0].bg};`));
  assert.match(css, new RegExp(`--accent: ${ACCENTS[0].color};`));
});
