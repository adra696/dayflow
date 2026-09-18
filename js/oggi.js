import { renderDateNavHeader, setSS, shootConfetti } from './utils.js';
import { selectedDate, lastTopPct, setLastTopPct, focusMode, persist, getDay, calcPct, updateTopProgressBar, ensureSlotArrays, activeHabits, getImpegniDelGiorno, calcHabitStreak, atdDoneCount } from './state.js';
import { sbLoadDay, adoptRemoteDay, scheduleSync } from './sync.js';

// ── OGGI ──────────────────────────────────────────────────
async function renderOggi() {
  renderDateNavHeader(selectedDate, 'oggi-date-nav');
  setSS('sd-oggi', 'st-oggi-sync', 'syncing', 'aggiornamento...');
  const remote = await sbLoadDay(selectedDate);
  if (remote && adoptRemoteDay(selectedDate, remote)) persist();
  setSS('sd-oggi', 'st-oggi-sync', 'ok', 'sincronizzato');
  const day = getDay(selectedDate); persist();
  const pct = calcPct(selectedDate) || 0;
  updateTopProgressBar(pct);
  setLastTopPct(pct);
  renderHOggiList(day, selectedDate);
}
function setupRowGestures(row, onComplete, onSwipeLeft) {
  const HOLD_MS = 700, HOLD_DRIFT = 10, SWIPE_DIST = 60;
  let timer = null, startX = 0, startY = 0, swiping = false;
  function cancelHold() { clearTimeout(timer); timer = null; row.classList.remove('holding'); }
  row.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch') return;
    if (e.target.closest('.skip-btn')) return;
    startX = e.clientX; startY = e.clientY; swiping = false;
    row.classList.add('holding');
    timer = setTimeout(() => { if (swiping) return; row.classList.remove('holding'); if (navigator.vibrate) navigator.vibrate([40]); onComplete(); }, HOLD_MS);
  });
  row.addEventListener('pointermove', e => {
    if (!timer && !swiping) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    const adx = Math.abs(dx), ady = Math.abs(dy);
    if (!swiping && adx > HOLD_DRIFT) cancelHold();
    if (onSwipeLeft && adx > SWIPE_DIST && adx > ady * 1.5) { swiping = true; row.style.transform = `translateX(${Math.min(dx, 0)}px)`; }
  });
  row.addEventListener('pointerup', e => {
    const dx = e.clientX - startX;
    if (swiping && dx < -SWIPE_DIST) { row.style.transform = ''; if (onSwipeLeft) onSwipeLeft(); }
    else row.style.transform = '';
    cancelHold(); swiping = false;
  });
  row.addEventListener('pointercancel', () => { row.style.transform = ''; cancelHold(); swiping = false; });
}
function renderHOggiList(day, today) {
  const c = document.getElementById('hoggi-list'); c.innerHTML = '';
  ensureSlotArrays(day);
  const habits = activeHabits();
  const impegni = getImpegniDelGiorno(today);
  const doneHab = habits.filter(h => day.abitudini[h.id] && day.abitudini[h.id].completato).length;
  const doneImp = impegni.filter(r => day.impegniRicorrentiCompletati[r.id]).length;
  document.getElementById('habit-count-lbl').textContent = `Abitudini — ${doneHab + doneImp}/${habits.length + impegni.length}`;
  const focusBtn = document.getElementById('focus-toggle-btn');
  if (focusBtn) { focusBtn.classList.toggle('active', focusMode); focusBtn.textContent = focusMode ? '🎯 focus' : 'focus'; }
  habits.forEach(h => {
    const rec = day.abitudini[h.id] || {};
    const row = document.createElement('div'); row.className = 'habit-row' + (rec.saltato ? ' skipped' : '');
    if (focusMode && rec.completato && !rec.saltato) row.classList.add('done-hidden');
    row.onclick = e => {
      if (e.pointerType === 'touch') return;
      if (e.target.closest('.skip-btn')) return; addRipple(row, e);
      const d = getDay(today); if (!d.abitudini[h.id]) d.abitudini[h.id] = {};
      if (!d.abitudini[h.id].saltato) { d.abitudini[h.id].completato = !d.abitudini[h.id].completato; scheduleSync(today, 'sd-oggi', 'st-oggi-sync'); renderHOggiList(getDay(today), today); updateOggiStats(today); }
    };
    const fill = document.createElement('div'); fill.className = 'hold-fill'; row.prepend(fill);
    const onSwipeLeft = h.frequenza === 'settimanale' ? () => { const d = getDay(today); if (!d.abitudini[h.id]) d.abitudini[h.id] = {}; d.abitudini[h.id].saltato = !d.abitudini[h.id].saltato; if (d.abitudini[h.id].saltato) d.abitudini[h.id].completato = false; scheduleSync(today, 'sd-oggi', 'st-oggi-sync'); renderHOggiList(getDay(today), today); updateOggiStats(today); } : null;
    setupRowGestures(row, () => { const d = getDay(today); if (!d.abitudini[h.id]) d.abitudini[h.id] = {}; if (!d.abitudini[h.id].saltato) { d.abitudini[h.id].completato = !d.abitudini[h.id].completato; scheduleSync(today, 'sd-oggi', 'st-oggi-sync'); renderHOggiList(getDay(today), today); updateOggiStats(today); } }, onSwipeLeft);
    const chk = document.createElement('div'); chk.className = 'hcheck' + (rec.completato ? ' done' : ''); chk.innerHTML = '<svg viewBox="0 0 11 11" fill="none" stroke="#080808" stroke-width="2.5" stroke-linecap="round"><polyline points="1.5,5.5 4.5,8.5 9.5,2.5"/></svg>';
    const nm = document.createElement('span'); nm.className = 'hname' + (rec.completato ? ' done' : ''); nm.textContent = h.nome;
    row.appendChild(chk); row.appendChild(nm);
    const hStreak = calcHabitStreak(h.id);
    if (hStreak > 1) { const sb = document.createElement('span'); sb.className = 'habit-streak-badge'; sb.textContent = `🔥${hStreak}`; row.appendChild(sb); }
    if (h.frequenza === 'settimanale') {
      const fr = document.createElement('span'); fr.className = 'hfreq'; fr.textContent = `×${h.targetSettimanale}`;
      const sb2 = document.createElement('button'); sb2.className = 'skip-btn' + (rec.saltato ? ' active' : ''); sb2.title = rec.saltato ? 'Ripristina' : 'Salta oggi';
      sb2.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" fill="none"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
      sb2.onclick = e => { e.stopPropagation(); const d = getDay(today); if (!d.abitudini[h.id]) d.abitudini[h.id] = {}; d.abitudini[h.id].saltato = !d.abitudini[h.id].saltato; if (d.abitudini[h.id].saltato) d.abitudini[h.id].completato = false; scheduleSync(today, 'sd-oggi', 'st-oggi-sync'); renderHOggiList(getDay(today), today); updateOggiStats(today); };
      row.appendChild(fr); row.appendChild(sb2);
    }
    c.appendChild(row);
  });
  impegni.forEach(r => {
    const completato = !!day.impegniRicorrentiCompletati[r.id];
    const row = document.createElement('div');
    row.className = 'habit-row impegno-row' + (focusMode && completato ? ' done-hidden' : '');
    const toggle = () => {
      const d = getDay(today);
      d.impegniRicorrentiCompletati[r.id] = !d.impegniRicorrentiCompletati[r.id];
      if (!d.impegniRicorrentiCompletati[r.id]) delete d.impegniRicorrentiCompletati[r.id];
      scheduleSync(today, 'sd-oggi', 'st-oggi-sync');
      renderHOggiList(getDay(today), today);
      updateOggiStats(today);
    };
    row.onclick = e => {
      if (e.pointerType === 'touch') return;
      addRipple(row, e);
      toggle();
    };
    const fill = document.createElement('div'); fill.className = 'hold-fill'; row.prepend(fill);
    setupRowGestures(row, toggle, null);
    const chk = document.createElement('div'); chk.className = 'hcheck' + (completato ? ' done' : '');
    chk.innerHTML = '<svg viewBox="0 0 11 11" fill="none" stroke="#080808" stroke-width="2.5" stroke-linecap="round"><polyline points="1.5,5.5 4.5,8.5 9.5,2.5"/></svg>';
    const nm = document.createElement('span'); nm.className = 'hname' + (completato ? ' done' : '');
    nm.textContent = r.titolo;
    const badge = document.createElement('span'); badge.className = 'impegno-badge'; badge.textContent = '🔁';
    row.appendChild(chk); row.appendChild(nm); row.appendChild(badge);
    if (r.ora) {
      const ora = document.createElement('span'); ora.className = 'impegno-ora'; ora.textContent = r.ora;
      row.appendChild(ora);
    }
    c.appendChild(row);
  });
  const hasP = day.attivitaDelGiorno.altaPriorita.some(v => v);
  const atdNE = day.attivitaDelGiorno.compiti.filter(t => t.trim()).length;
  const atdCount = atdDoneCount(day);
  const atdDone = atdNE > 0 && atdCount >= atdNE;
  const tr = document.createElement('div'); tr.className = 'tasks-row' + (hasP ? ' priority-on' : '');
  const th = document.createElement('div'); th.className = 'tasks-head';
  const tc = document.createElement('div'); tc.className = 'hcheck' + (atdDone ? ' done' : ''); tc.innerHTML = '<svg viewBox="0 0 11 11" fill="none" stroke="#080808" stroke-width="2.5" stroke-linecap="round"><polyline points="1.5,5.5 4.5,8.5 9.5,2.5"/></svg>';
  const tl = document.createElement('span'); tl.className = 'hname' + (atdDone ? ' done' : ''); tl.textContent = 'Attività del giorno';
  th.appendChild(tc); th.appendChild(tl);
  if (atdCount > 0 && atdNE > 0 && !atdDone) { const cb = document.createElement('span'); cb.style.cssText = 'font-family:var(--mono);font-size:11px;color:var(--green);margin-left:auto;white-space:nowrap'; cb.textContent = `${atdCount}/${atdNE}`; th.appendChild(cb); }
  if (hasP) { const pb = document.createElement('span'); pb.style.cssText = 'font-family:var(--mono);font-size:11px;color:var(--red);white-space:nowrap;' + (atdCount > 0 && atdNE > 0 && !atdDone ? 'margin-left:4px' : 'margin-left:auto'); pb.textContent = '⚠ priorità'; th.appendChild(pb); }
  tr.appendChild(th);
  const tlist = document.createElement('div'); tlist.className = 'tasks-list';
  day.attivitaDelGiorno.compiti.forEach((t, i) => {
    if (!t.trim()) return;
    const it = document.createElement('div');
    it.className = 'task-item clickable' + (day.attivitaDelGiorno.altaPriorita[i] ? ' hi' : '') + (day.attivitaDelGiorno.completatiTask[i] ? ' done' : '');
    const chk = document.createElement('div'); chk.className = 'task-check' + (day.attivitaDelGiorno.completatiTask[i] ? ' done' : ''); chk.innerHTML = '<svg viewBox="0 0 11 11" fill="none" stroke="#080808" stroke-width="2.5" stroke-linecap="round"><polyline points="1.5,5.5 4.5,8.5 9.5,2.5"/></svg>';
    it.appendChild(chk);
    const lbl = document.createElement('span'); lbl.className = 'task-text'; lbl.textContent = t; it.appendChild(lbl);
    it.onclick = e => {
      e.stopPropagation();
      const d = getDay(today);
      d.attivitaDelGiorno.completatiTask[i] = !d.attivitaDelGiorno.completatiTask[i];
      scheduleSync(today, 'sd-oggi', 'st-oggi-sync');
      renderHOggiList(getDay(today), today);
      updateOggiStats(today);
    };
    tlist.appendChild(it);
  });
  tr.appendChild(tlist); c.appendChild(tr);
}
function updateOggiStats(today) { const pct = calcPct(today) || 0; updateTopProgressBar(pct); if (pct === 100 && lastTopPct < 100) shootConfetti(); setLastTopPct(pct); }
function addRipple(el, e) { const r = document.createElement('span'); r.className = 'ripple'; const rect = el.getBoundingClientRect(); const sz = Math.max(rect.width, rect.height) * 2; r.style.cssText = `width:${sz}px;height:${sz}px;left:${e.clientX - rect.left - sz / 2}px;top:${e.clientY - rect.top - sz / 2}px`; el.appendChild(r); setTimeout(() => r.remove(), 520); }

export { renderOggi, renderHOggiList, updateOggiStats };
