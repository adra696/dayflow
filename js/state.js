import { todayStr, p2, pctColor, showToast } from './utils.js';

// Dipendenze "verso l'alto" (schermate e sync) usate da setSelectedDate / toggleFocusMode / ensureSlotArrays:
// state.js importa solo utils.js, quindi non le importa; app.js le registra con setStateHooks() all'avvio.
let ensureEventi, loadWindowForDate, renderPlan, renderOggi, renderDiscover, renderHOggiList;
function setStateHooks(h) { ({ ensureEventi, loadWindowForDate, renderPlan, renderOggi, renderDiscover, renderHOggiList } = h); }

// ── SUPABASE ──────────────────────────────────────────────
const SUPA_URL = 'https://iqlxjazrshqzqrltkjoz.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlxbHhqYXpyc2hxenFybHRram96Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MTUzMzUsImV4cCI6MjA5NDE5MTMzNX0.N5F7RW3ueIHFtwwZFBXkbeTxZMam_lh8hPshy7uX1MI';
let sb = null;
try {
  if (typeof supabase !== 'undefined' && supabase && supabase.createClient) {
    sb = supabase.createClient(SUPA_URL, SUPA_KEY);
  }
} catch (e) {
  console.error('Supabase init error', e);
}

const SK = 'dayflow_v3';
let S = { habits: [], days: {}, impegniRicorrenti: [] };
let curUser = null;
let curScreen = 'oggi';
let isProgrammaticScroll = false;
let selectedDate = todayStr();
let mMode = 'list', editId = null;

const APP_VERSION = '1.0';
const SETTINGS = { open: false, trigger: null };             // pannello Impostazioni globale
const DLG = { open: false, resolve: null, busy: false, keepOpen: false, trigger: null }; // dialog di conferma
let allDaysLoaded = false;

// Setter minimali per le riassegnazioni fatte da altri file: con gli ES module un binding
// importato è di sola lettura, quindi chi sta in un altro modulo scrive solo tramite questi.
function setS(v) { S = v; }
function setCurUser(v) { curUser = v; }
function setCurScreen(v) { curScreen = v; }
function setIsProgrammaticScroll(v) { isProgrammaticScroll = v; }
function setSelectedDateOnly(v) { selectedDate = v; } // sola assegnazione: setSelectedDate() ridisegna e carica anche la finestra remota
function setMMode(v) { mMode = v; }
function setEditId(v) { editId = v; }
function setAllDaysLoaded(v) { allDaysLoaded = v; }

function setSelectedDate(ds) {
  selectedDate = ds;
  if (curScreen === 'plan') renderPlan();
  else if (curScreen === 'oggi') renderOggi();
  else if (curScreen === 'recap') renderDiscover();

  // Caricamento incrementale in background della nuova finestra temporale
  loadWindowForDate(ds);
}

function load() {
  try {
    let r = localStorage.getItem(SK);
    if (!r) {
      r = localStorage.getItem('dayflow_v2') || localStorage.getItem('dayflow_v1') || localStorage.getItem('dayflow');
    }
    if (r) {
      const parsed = JSON.parse(r);
      if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.habits)) S.habits = parsed.habits;
        if (parsed.days && typeof parsed.days === 'object') S.days = parsed.days;
        if (Array.isArray(parsed.impegniRicorrenti)) S.impegniRicorrenti = parsed.impegniRicorrenti;
      }
    }
  } catch (e) { }
  if (!Array.isArray(S.habits)) S.habits = [];
  if (!S.days || typeof S.days !== 'object') S.days = {};
  if (!Array.isArray(S.impegniRicorrenti)) S.impegniRicorrenti = [];
}
function persist() { try { localStorage.setItem(SK, JSON.stringify(S)) } catch (e) { } }
function getDay(ds) { if (!S.days[ds]) S.days[ds] = { data: ds, abitudini: {}, attivitaDelGiorno: { compiti: ['', '', ''], altaPriorita: [false, false, false], completatiTask: [false, false, false], completato: false, completatiCount: 0 }, note: '', timestamp: 0, eventi: [], impegniRicorrentiCompletati: {} }; ensureSlotArrays(S.days[ds]); return S.days[ds]; }

function ensureSlotArrays(day) {
  ensureEventi(day);
  if (!day.impegniRicorrentiCompletati || typeof day.impegniRicorrentiCompletati !== 'object') {
    day.impegniRicorrentiCompletati = {};
  }
  const atd = day.attivitaDelGiorno;
  if (!Array.isArray(atd.compiti)) atd.compiti = ['', '', ''];
  if (!Array.isArray(atd.altaPriorita)) atd.altaPriorita = [];
  while (atd.altaPriorita.length < atd.compiti.length) atd.altaPriorita.push(false);
  atd.altaPriorita.length = atd.compiti.length;
  if (!Array.isArray(atd.completatiTask)) {
    // Migration: derive from legacy completatiCount / completato
    const cnt = atd.completatiCount || (atd.completato ? atd.compiti.filter(t => t.trim()).length : 0);
    atd.completatiTask = atd.compiti.map(() => false);
    let marked = 0;
    for (let i = 0; i < atd.compiti.length && marked < cnt; i++) {
      if (atd.compiti[i] && atd.compiti[i].trim()) { atd.completatiTask[i] = true; marked++; }
    }
  }
  while (atd.completatiTask.length < atd.compiti.length) atd.completatiTask.push(false);
  atd.completatiTask.length = atd.compiti.length;
}
function atdDoneCount(day) {
  const atd = day.attivitaDelGiorno;
  let n = 0;
  for (let i = 0; i < atd.compiti.length; i++) {
    if (atd.compiti[i] && atd.compiti[i].trim() && atd.completatiTask[i]) n++;
  }
  return n;
}
function activeHabits() { return S.habits.filter(h => h.attiva).sort((a, b) => a.ordine - b.ordine) }
function isoDow(ds) {
  const d = new Date(ds + 'T12:00:00');
  const js = d.getDay();
  return js === 0 ? 7 : js;
}
function getImpegniDelGiorno(ds) {
  const dow = isoDow(ds);
  return (S.impegniRicorrenti || [])
    .filter(r => r.attivo !== false && Array.isArray(r.giorniSettimana) && r.giorniSettimana.includes(dow))
    .slice()
    .sort((a, b) => (a.ordine || 0) - (b.ordine || 0));
}
function calcPct(ds) {
  const day = S.days[ds];
  if (!day) return null;
  ensureSlotArrays(day);
  let total = 0, done = 0;

  // Abitudini attive (non saltate)
  const habits = activeHabits();
  habits.forEach(h => {
    const r = day.abitudini[h.id] || {};
    if (!r.saltato) {
      total++;
      if (r.completato) done++;
    }
  });

  // Attività del giorno: ogni compito compilato ha lo stesso peso (1) di un'abitudine
  const atd = day.attivitaDelGiorno;
  if (atd && Array.isArray(atd.compiti)) {
    const nonEmpty = atd.compiti.filter(t => t.trim()).length;
    total += nonEmpty;
    done += atdDoneCount(day);
  }

  // Impegni ricorrenti del giorno
  const imp = getImpegniDelGiorno(ds);
  total += imp.length;
  imp.forEach(r => {
    if (day.impegniRicorrentiCompletati && day.impegniRicorrentiCompletati[r.id]) done++;
  });

  if (total === 0) return 0;
  return Math.round((done / total) * 100);
}

let lastTopPct = 0;
function setLastTopPct(v) { lastTopPct = v; }

function updateTopProgressBar(pct) {
  const bar = document.getElementById('top-progress-bar');
  if (!bar) return;
  const p = Math.max(0, Math.min(100, Math.round(pct || 0)));
  const col = pctColor(p);
  bar.style.width = p + '%';
  bar.style.backgroundColor = col;
  bar.style.boxShadow = p > 0 ? `0 0 10px ${col}, 0 0 4px ${col}` : 'none';
}

function calcAvg(dates) { const today = todayStr(); const vals = dates.filter(d => d <= today).map(d => calcPct(d)).filter(v => v !== null); if (!vals.length) return null; return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length); }

let focusMode = localStorage.getItem('dayflow_focusMode') === 'true';
function toggleFocusMode() { focusMode = !focusMode; localStorage.setItem('dayflow_focusMode', focusMode); const btn = document.getElementById('focus-toggle-btn'); if (btn) { btn.classList.toggle('active', focusMode); btn.textContent = focusMode ? '🎯 focus' : 'focus'; } const sw = document.getElementById('set-focus'); if (sw) sw.setAttribute('aria-checked', String(focusMode)); /* ridisegna la data mostrata da Oggi (renderOggi usa selectedDate), anche se Oggi non è la schermata attiva */ if (document.getElementById('hoggi-list')) renderHOggiList(getDay(selectedDate), selectedDate); }

// ── STREAK ────────────────────────────────────────────────
function calcStreak() {
  let streak = 0;
  const d = new Date();
  // start from yesterday (today is still in progress)
  d.setDate(d.getDate() - 1);
  while (true) {
    const ds = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    const pct = calcPct(ds);
    if (pct !== null && pct >= 1) { streak++; d.setDate(d.getDate() - 1); }
    else break;
  }
  // Check if today also qualifies
  const todayPct = calcPct(todayStr());
  if (todayPct !== null && todayPct >= 1) streak++;
  return streak;
}
function calcHabitStreak(habitId) {
  const today = todayStr();
  const dates = Object.keys(S.days).filter(d => d <= today).sort().reverse();
  let streak = 0;
  for (const ds of dates) {
    const rec = (S.days[ds].abitudini || {})[habitId] || {};
    if (rec.saltato) { streak++; continue; }
    if (!rec.completato) break;
    streak++;
  }
  return streak;
}
function toggleSidebar() {
  const nav = document.getElementById('nav');
  nav.classList.toggle('expanded');
  localStorage.setItem('sidebarExpanded', nav.classList.contains('expanded'));
}

function exportBackup() {
  try {
    const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `dayflow-backup-${todayStr()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    showToast('Backup esportato', 'info', 2200);
  } catch (e) {
    console.error('exportBackup', e);
    showToast('Esportazione non riuscita', 'error');
  }
}

export {
  sb, SK, S, curUser, curScreen, isProgrammaticScroll, selectedDate, mMode, editId, APP_VERSION, SETTINGS, DLG,
  lastTopPct, focusMode,
  setS, setCurUser, setCurScreen, setIsProgrammaticScroll, setSelectedDateOnly, setMMode, setEditId, setAllDaysLoaded, setLastTopPct,
  setStateHooks, setSelectedDate, load, persist, getDay, ensureSlotArrays, atdDoneCount, activeHabits, getImpegniDelGiorno,
  calcPct, updateTopProgressBar, toggleFocusMode, calcHabitStreak, toggleSidebar, exportBackup
};
