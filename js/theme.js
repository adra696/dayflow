import { settingsGroupHTML } from './utils.js';

// ── ASPETTO (tema + colore d'accento) ─────────────────────
// Scelta solo locale (per dispositivo) in localStorage THEME_LS = { theme, accent }. Le variabili CSS di
// ogni tema/accento stanno in css/tokens.css (:root[data-theme] / :root[data-accent]); qui solo gli id,
// le etichette e i colori per le anteprime e per <meta name="theme-color">. Lo script inline in <head>
// di index.html applica gli attributi prima del primo paint (stessa chiave, stessi nomi di attributo).
const THEME_LS = 'dayflow_theme';
const THEMES = [
  { id: 'grafite', label: 'Grafite', bg: '#0a0a0b', s1: '#111113', s2: '#18181b', text: '#f4f4f5' },
  { id: 'mezzanotte', label: 'Mezzanotte', bg: '#0a0e1a', s1: '#10162a', s2: '#161d35', text: '#eef1fb' },
  { id: 'nero', label: 'Nero', bg: '#000000', s1: '#0b0b0c', s2: '#131315', text: '#f4f4f5' },
  { id: 'moka', label: 'Moka', bg: '#0e0c0a', s1: '#161310', s2: '#1e1a16', text: '#f6f1ea' }
];
const ACCENTS = [
  { id: 'viola', label: 'Viola', color: '#8b8cf8' },
  { id: 'blu', label: 'Blu', color: '#60a5fa' },
  { id: 'turchese', label: 'Turchese', color: '#2dd4bf' },
  { id: 'rosa', label: 'Rosa', color: '#f472b6' },
  { id: 'ambra', label: 'Ambra', color: '#fbbf24' }
];

// Valori sconosciuti o mancanti → default (primo elemento della lista)
function normalizeThemePrefs(p) {
  const o = p && typeof p === 'object' ? p : {};
  return {
    theme: THEMES.some(t => t.id === o.theme) ? o.theme : THEMES[0].id,
    accent: ACCENTS.some(a => a.id === o.accent) ? o.accent : ACCENTS[0].id
  };
}
function loadThemePrefs() {
  try { return normalizeThemePrefs(JSON.parse(localStorage.getItem(THEME_LS) || 'null')); }
  catch (e) { return normalizeThemePrefs(null); }
}
function themeById(id) { return THEMES.find(t => t.id === id) || THEMES[0]; }
function accentById(id) { return ACCENTS.find(a => a.id === id) || ACCENTS[0]; }

// I default non mettono l'attributo: :root resta la fonte unica di Grafite/Viola
function applyTheme(p = loadThemePrefs()) {
  const root = document.documentElement;
  if (p.theme === THEMES[0].id) delete root.dataset.theme; else root.dataset.theme = p.theme;
  if (p.accent === ACCENTS[0].id) delete root.dataset.accent; else root.dataset.accent = p.accent;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', themeById(p.theme).bg);
}
function saveThemePrefs(p) {
  p = normalizeThemePrefs(p);
  try { localStorage.setItem(THEME_LS, JSON.stringify(p)); } catch (e) { }
  applyTheme(p);
  renderThemeSettings();
}
function setTheme(id) { saveThemePrefs({ ...loadThemePrefs(), theme: id }); }
function setAccent(id) { saveThemePrefs({ ...loadThemePrefs(), accent: id }); }

// Valore breve della riga nel menu delle impostazioni
function themeShortLabel() {
  const p = loadThemePrefs();
  return `${themeById(p.theme).label} · ${accentById(p.accent).label}`;
}

// Pagina Impostazioni → Aspetto (contenitore #settings-theme-body, ri-renderizzata a ogni scelta)
// Il bottone toccato viene sostituito: il focus passa all'opzione ora attiva dello stesso gruppo.
function renderThemeSettings(el = document.getElementById('settings-theme-body')) {
  if (!el) return;
  const a = document.activeElement;
  const cls = a && el.contains(a) ? a.className : '';
  el.innerHTML = themeSettingsHTML();
  if (cls) { const b = el.querySelector(`.${cls}[aria-pressed="true"]`); if (b) b.focus({ preventScroll: true }); }
}
function themeSettingsHTML() {
  const p = loadThemePrefs();
  const acc = accentById(p.accent).color;
  const themes = THEMES.map(t => `<button class="theme-opt" type="button" aria-pressed="${t.id === p.theme}" onclick="setTheme('${t.id}')">
      <span class="theme-prev" aria-hidden="true" style="background:${t.bg}">
        <span class="theme-prev-card" style="background:${t.s2}"><i style="background:${t.text}"></i><i style="background:${acc}"></i></span>
        <span class="theme-prev-bar" style="background:${t.s1}"></span>
      </span>
      <span class="theme-opt-lbl">${t.label}</span>
    </button>`).join('');
  const accents = ACCENTS.map(a => `<button class="accent-opt" type="button" aria-pressed="${a.id === p.accent}" aria-label="${a.label}" title="${a.label}" style="--sw:${a.color}" onclick="setAccent('${a.id}')"></button>`).join('');
  return settingsGroupHTML('Tema', `<div class="theme-grid">${themes}</div>`, 'Cambia sfondi e superfici. Vale solo su questo dispositivo.')
    + settingsGroupHTML('Colore d\'accento', `<div class="accent-row">${accents}</div>`,
      `${accentById(p.accent).label}: pulsanti attivi, selezioni e interruttori.`);
}

export {
  THEME_LS, THEMES, ACCENTS, normalizeThemePrefs, loadThemePrefs, applyTheme,
  setTheme, setAccent, themeShortLabel, renderThemeSettings
};
