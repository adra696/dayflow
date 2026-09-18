// ── UTILS ──────────────────────────────────────────────────
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` }

function offsetDate(ds, giorni) {
  const d = new Date(ds + 'T12:00:00');
  d.setDate(d.getDate() + giorni);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
// Data di testata: niente anno (è nel day picker e in Calendario); giorno della settimana
// abbreviato sotto i 768px (.dn-short) per stare in una riga con sync + ingranaggio a 375px.
function fmtHeaderDate(ds) {
  const d = new Date(ds + 'T12:00:00');
  const dayMonth = d.toLocaleDateString('it-IT', { day: 'numeric', month: 'long' }).toLowerCase();
  const wdLong = d.toLocaleDateString('it-IT', { weekday: 'long' }).toLowerCase();
  const wdShort = d.toLocaleDateString('it-IT', { weekday: 'short' }).toLowerCase().replace('.', '');
  return `<span class="dn-long">${wdLong}</span><span class="dn-short">${wdShort}</span> ${dayMonth}`;
}
function renderDateNavHeader(ds, containerId) {
  const c = document.getElementById(containerId);
  if (!c) return;
  const today = todayStr();
  c.innerHTML = `
    <div class="date-nav">
      <button class="date-nav-arrow" onclick="setSelectedDate(offsetDate('${ds}', -1))" aria-label="Giorno precedente">
        <svg viewBox="0 0 24 24"><polyline points="15,18 9,12 15,6" /></svg>
      </button>
      <div class="date-nav-label">
        <span class="date-nav-txt">${fmtHeaderDate(ds)}</span>
        ${ds === today ? '<span class="today-badge">Oggi</span>' : ''}
      </div>
      <button class="date-nav-arrow" onclick="setSelectedDate(offsetDate('${ds}', 1))" aria-label="Giorno successivo">
        <svg viewBox="0 0 24 24"><polyline points="9,18 15,12 9,6" /></svg>
      </button>
    </div>
  `;
}
function p2(n) { return String(n).padStart(2, '0') }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2) }

function pctColor(p) { return p <= 25 ? '#f87171' : p <= 50 ? '#fb923c' : p <= 75 ? '#facc15' : '#4ade80' }

function heatColor(p) { if (p === null) return null; if (p === 0) return '#181818'; if (p <= 25) return '#3d1515'; if (p <= 50) return '#3d2510'; if (p <= 75) return '#352e08'; return '#163316'; }
function fmtDate(ds) { const d = new Date(ds + 'T12:00:00'); return d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).toLowerCase() }
function fmtShort(ds) { const d = new Date(ds + 'T12:00:00'); return d.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' }).toLowerCase() }
function weekDays() { const now = new Date(); const dow = now.getDay(); const diff = dow === 0 ? 6 : dow - 1; const mon = new Date(now); mon.setDate(now.getDate() - diff); return Array.from({ length: 7 }, (_, i) => { const d = new Date(mon); d.setDate(mon.getDate() + i); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` }); }
function monthDays(y, m) { const tot = new Date(y, m + 1, 0).getDate(); return Array.from({ length: tot }, (_, i) => `${y}-${p2(m + 1)}-${p2(i + 1)}`); }

function setBar(fId, pId, pct) { document.getElementById(fId).style.width = pct + '%'; document.getElementById(fId).style.background = pctColor(pct); const el = document.getElementById(pId); el.textContent = pct + '%'; el.style.color = pctColor(pct); }
function setRing(ringId, pctId, pct) { const el = document.getElementById(ringId); el.style.strokeDashoffset = 213.6 * (1 - pct / 100); el.style.stroke = pctColor(pct); const p = document.getElementById(pctId); p.textContent = pct + '%'; p.style.color = pctColor(pct); }

function setSS(dotId, txtId, status, msg) { const d = document.getElementById(dotId); const t = document.getElementById(txtId); if (!d || !t) return; d.className = 'sync-dot ' + status; t.textContent = msg; d.title = msg; d.setAttribute('aria-label', msg); }
function shootConfetti() {
  const colors = ['#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#a855f7'];
  for (let i = 0; i < 40; i++) {
    const el = document.createElement('div');
    el.className = 'confetti';
    el.style.left = (Math.random() * 100) + 'vw';
    el.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
    el.style.animationDuration = (Math.random() * 1 + 1) + 's';
    el.style.animationDelay = (Math.random() * 0.2) + 's';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  }
}

function showToast(msg, type = 'warn', duration = 3500) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 350); }, duration);
}
function withTimeout(promise, ms) {
  let timedOut = false;
  return Promise.race([
    promise,
    new Promise(res => setTimeout(() => { timedOut = true; res(); }, ms))
  ]).then(result => {
    if (timedOut) showToast('Sync fallito, riprovo…', 'warn');
    return result;
  });
}

function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

export {
  todayStr, offsetDate, fmtHeaderDate, renderDateNavHeader, p2, uid, pctColor, heatColor, fmtDate, weekDays,
  setSS, shootConfetti, showToast, withTimeout, plural
};
