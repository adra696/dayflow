import { todayStr, p2, uid, setSS, heatColor, fmtDate, offsetDate, showToast } from './utils.js';
import { S, selectedDate, curScreen, getDay, setAllDaysLoaded, persist, updateTopProgressBar, calcPct } from './state.js';
import { sbLoadAllDays, adoptRemoteDay, scheduleSync } from './sync.js';
import { closeModal } from './plan.js';

// ── ANALYTICS ─────────────────────────────────────────────
// ── CALENDARIO — settimana + timeline ─────────────────────
const CAL_HOUR_H = 56;          // px per ora
const CAL_MIN_EV = 26;          // altezza minima di un blocco
const CAL = { date: todayStr(), inited: false };

function calWeekDays(ds) {
  const d = new Date(ds + 'T12:00:00');
  const dow = d.getDay(); const diff = dow === 0 ? 6 : dow - 1;
  const mon = new Date(d); mon.setDate(d.getDate() - diff);
  return Array.from({ length: 7 }, (_, i) => { const x = new Date(mon); x.setDate(mon.getDate() + i); return `${x.getFullYear()}-${p2(x.getMonth() + 1)}-${p2(x.getDate())}`; });
}
function minutesOf(ora) { const m = /^(\d{1,2}):(\d{2})$/.exec(ora || ''); if (!m) return 0; return Math.max(0, Math.min(1439, (+m[1]) * 60 + (+m[2]))); }
function fmtMin(min) { min = Math.max(0, Math.min(1440, Math.round(min))); return p2(Math.floor(min / 60)) + ':' + p2(min % 60); }
function fmtDur(min) {
  min = Math.max(0, Math.round(min));
  const h = Math.floor(min / 60), m = min % 60;
  if (!h) return m + ' min';
  return h + ' h' + (m ? ' ' + p2(m) : '');
}
function normalizeEvento(e) {
  if (!e || typeof e !== 'object') return null;
  const o = {
    id: e.id || uid(),
    titolo: String(e.titolo == null ? '' : e.titolo),
    tipo: e.tipo === 'scadenza' ? 'scadenza' : 'impegno',
    tuttoIlGiorno: !!e.tuttoIlGiorno,
    ora: typeof e.ora === 'string' ? e.ora : '',
    durata: 60,
    completato: !!e.completato
  };
  if (!/^\d{1,2}:\d{2}$/.test(o.ora)) { o.ora = ''; o.tuttoIlGiorno = true; }
  if (o.tuttoIlGiorno) { o.ora = ''; o.durata = 0; }
  else { const d = parseInt(e.durata, 10); o.durata = (Number.isFinite(d) && d > 0) ? Math.min(d, 1440) : 60; }
  return o;
}
function ensureEventi(day) {
  if (!day) return [];
  if (!Array.isArray(day.eventi)) day.eventi = [];
  else day.eventi = day.eventi.map(normalizeEvento).filter(Boolean);
  return day.eventi;
}
function eventiDelGiorno(ds) { const day = S.days[ds]; return day ? ensureEventi(day) : []; }

async function renderCalendario() {
  if (!CAL.inited) { calBuildGrid(); calInitGestures(); CAL.inited = true; }
  renderCalHeader(); renderCalStrip(); renderCalDay();
  calScrollToRelevant();
  setSS('sd-an', 'st-an-sync', 'syncing', 'caricamento storico...');
  const allDays = await sbLoadAllDays();
  if (allDays) {
    for (const [ds, nd] of Object.entries(allDays)) adoptRemoteDay(ds, nd);
    setAllDaysLoaded(true);
    persist();
  }
  setSS('sd-an', 'st-an-sync', 'ok', 'sincronizzato');
  updateTopProgressBar(calcPct(selectedDate) || 0);
  renderCalStrip(); renderCalDay();
}

function calBuildGrid() {
  const body = document.getElementById('cal-body');
  if (!body) return;
  body.style.height = (CAL_HOUR_H * 24 + 24) + 'px';
  const frag = document.createDocumentFragment();
  for (let h = 0; h <= 24; h++) {
    const line = document.createElement('div'); line.className = 'cal-line'; line.style.top = (h * CAL_HOUR_H) + 'px';
    frag.appendChild(line);
    if (h < 24) {
      const lbl = document.createElement('div'); lbl.className = 'cal-hlbl'; lbl.style.top = (h * CAL_HOUR_H) + 'px';
      lbl.textContent = p2(h);
      frag.appendChild(lbl);
    }
  }
  body.insertBefore(frag, body.firstChild);
  const canvas = document.getElementById('cal-canvas');
  if (canvas) canvas.addEventListener('click', ev => {
    if (ev.target !== canvas) return;
    const rect = canvas.getBoundingClientRect();
    const min = Math.round(((ev.clientY - rect.top) / CAL_HOUR_H * 60) / 30) * 30;
    openEventoModal(CAL.date, null, Math.max(0, Math.min(1410, min)));
  });
}

function renderCalHeader() {
  const lbl = document.getElementById('cal-month');
  if (lbl) {
    const d = new Date(CAL.date + 'T12:00:00');
    const long = d.toLocaleDateString('it-IT', { month: 'long' });
    lbl.innerHTML = '';
    const l = document.createElement('span'); l.className = 'dn-long'; l.textContent = long;
    const s = document.createElement('span'); s.className = 'dn-short'; s.textContent = long.slice(0, 3);
    const y = document.createElement('span'); y.textContent = ' ' + d.getFullYear();
    lbl.appendChild(l); lbl.appendChild(s); lbl.appendChild(y);
  }
  const btn = document.getElementById('cal-today-btn');
  if (btn) btn.hidden = (CAL.date === todayStr());
}

// ── PAGER ORIZZONTALE (striscia settimana ±7 giorni, timeline ±1 giorno) ──
// Track a 3 pagine (prec / corrente / succ): la corrente sta nel flusso, le laterali sono absolute a ∓100%,
// a riposo il track non ha transform. Durante il gesto il track segue il dito (translate3d in px, rAF,
// larghezza letta una volta a inizio gesto); al rilascio un'animazione WAAPI (compositor) parte dalla
// posizione attuale, con durata proporzionale alla distanza rimasta e velocità iniziale ≈ quella del dito.
// A fine corsa settle() ridisegna le pagine attorno al nuovo giorno e azzera il transform nello stesso task
// (fill: 'forwards' tiene la posizione finale fino a lì → niente flash). Un tocco durante l'animazione la
// "afferra" nel punto in cui si trova (come iOS).
const CAL_SW = {
  slop: 6,            // px prima di decidere orizzontale / verticale
  commit: .25,        // frazione di larghezza oltre cui il rilascio cambia pagina
  vel: .4,            // px/ms: flick che cambia pagina anche sotto soglia
  minMs: 180, maxMs: 320,
  pageMs: 400,        // durata "teorica" per una pagina intera (poi clamp)
  ease: 'cubic-bezier(.2, .75, .3, 1)',
  slope: 3.75         // pendenza iniziale di ease (.75/.2): durata = slope·distanza/velocità → nessuno scatto al rilascio
};
const calReduceMotion = () => !!(typeof window !== 'undefined' && window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
function calPager(o) { return Object.assign({ off: 0, w: 1, to: 0, dest: null, anims: null, timer: 0, g: null, raf: 0, noClickT: 0 }, o); }
function pgTf(x) { return `translate3d(${x}px,0,0)`; }
function pgSet(P, x) { P.off = x; P.tracks().forEach(t => { t.style.transform = x ? pgTf(x) : ''; }); }

// Fine (o interruzione) dell'animazione: contenuto ricentrato su ds, track a riposo
function pgSettle(P, ds) {
  const anims = P.anims;
  P.anims = null; clearTimeout(P.timer);
  P.off = 0;
  P.settle(ds || CAL.date);
  P.tracks().forEach(t => { t.style.transform = ''; t.classList.remove('moving'); });
  if (anims) anims.forEach(a => { try { a.cancel(); } catch (_) { } }); // dopo il ridisegno: stesso frame
}
function pgStop(P) { if (P.anims) pgSettle(P, P.dest); }
// Annulla gesto e animazione all'istante (schermo lasciato a metà drag, app in background): track a riposo su CAL.date
function pgCancel(P) {
  const g = P.g;
  P.g = null;
  if (g && g.cleanup) g.cleanup();
  if (P.raf) { cancelAnimationFrame(P.raf); P.raf = 0; }
  if (g || P.anims || P.off) pgSettle(P);
}

function pgCurX(t) {
  const m = /matrix(3d)?\(([^)]*)\)/.exec(getComputedStyle(t).transform || '');
  if (!m) return 0;
  const v = m[2].split(',').map(parseFloat);
  return (m[1] ? v[12] : v[4]) || 0;
}
// Tocco durante un'animazione: la ferma dov'è. Il contenuto si ricentra sulla destinazione
// e il track riparte dallo stesso punto visivo (offset = posizione attuale − arrivo).
function pgCatch(P) {
  if (!P.anims) return false;
  const t = P.tracks()[0];
  const x = t ? pgCurX(t) : P.to;
  // destinazione cambiata durante lo slide (es. evento salvato su un altro giorno): niente continuità, solo stop
  const off = P.dest === P.animDest ? Math.round(x - P.to) : 0;
  pgSettle(P, P.dest);
  pgSet(P, Math.abs(off) < 1 ? 0 : off);
  return true;
}

function pgAnimate(P, to, v) {
  const from = P.off;
  P.to = to; P.dest = P.animDest = CAL.date;
  const tracks = P.tracks();
  if (from === to || calReduceMotion() || !tracks.length || typeof tracks[0].animate !== 'function') { pgSettle(P); return; }
  const dist = Math.abs(to - from);
  let ms = dist / Math.max(1, P.w) * CAL_SW.pageMs;
  const sp = Math.abs(v || 0);
  if (sp > .1 && (to - from) * v > 0) ms = Math.min(ms, CAL_SW.slope * dist / sp);
  ms = Math.round(Math.max(CAL_SW.minMs, Math.min(CAL_SW.maxMs, ms)));
  const kf = [{ transform: pgTf(from) }, { transform: pgTf(to) }];
  tracks.forEach(t => t.classList.add('moving'));
  const anims = tracks.map(t => t.animate(kf, { duration: ms, easing: CAL_SW.ease, fill: 'forwards' }));
  P.anims = anims;
  const done = () => { if (P.anims === anims) pgSettle(P); };
  anims[0].onfinish = done;
  clearTimeout(P.timer); P.timer = setTimeout(done, ms + 150); // rete di sicurezza (tab in background ecc.)
}

// Gesto: Touch Events per il dito (touchmove non passivo → preventDefault dopo il lock orizzontale, così iOS
// non avvia pan/rimbalzi nativi che annullerebbero il drag), Pointer Events solo per il mouse (opts.mouse).
// I listener di move/end vanno anche sul target del touchstart: se il nodo viene ricreato durante il gesto
// (render da sync, settle dopo un "catch") gli eventi touch restano sul nodo staccato e non risalirebbero.
// opts: { commit(step), mouse, preventAll (dopo la soglia blocca ogni gesto nativo a un dito, anche verticale: per la striscia) }
function pgBind(P, els, opts) {
  const paint = () => { P.raf = 0; if (P.g && P.g.lock === 'x') pgSet(P, P.g.off); };
  const begin = (x, y, src, id) => {
    if (P.g) finish(true);
    const caught = pgCatch(P);
    P.noClickT = caught ? Infinity : 0;
    P.w = P.width() || 1;
    P.g = { src, id, x0: x, y0: y, base: P.off, off: P.off, lock: null, s: [{ x, t: performance.now() }], caught, last: null, cleanup: null };
  };
  const move = (x, y, e) => {
    const g = P.g;
    const dx = x - g.x0, dy = y - g.y0;
    if (!g.lock) {
      // sotto la soglia nessun preventDefault: un tap un po' tremolante resta un tap (click intatto)
      if (dx * dx + dy * dy < CAL_SW.slop * CAL_SW.slop) return;
      g.lock = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (g.lock === 'x') P.tracks().forEach(t => t.classList.add('moving'));
      else if (P.off && !P.anims) pgAnimate(P, 0, 0); // afferrato a metà e poi scroll verticale: torna a riposo
    }
    if (g.lock !== 'x') { if (opts.preventAll && e && e.cancelable) e.preventDefault(); return; }
    if (e && e.cancelable) e.preventDefault();
    g.off = Math.max(-P.w, Math.min(P.w, g.base + dx));
    g.s.push({ x, t: performance.now() });
    if (g.s.length > 24) g.s.shift();
    if (!P.raf) P.raf = requestAnimationFrame(paint);
  };
  const finish = cancelled => {
    const g = P.g;
    if (!g) return;
    P.g = null;
    if (g.cleanup) g.cleanup();
    if (P.raf) { cancelAnimationFrame(P.raf); P.raf = 0; }
    if (g.lock !== 'x') {
      P.noClickT = g.caught ? performance.now() + 400 : 0; // tocco che ha fermato un'animazione: niente click
      if (P.off && !P.anims) pgAnimate(P, 0, 0);
      return;
    }
    P.noClickT = performance.now() + 400; // niente tap su giorno/evento/slot dopo un drag
    pgSet(P, g.off);
    // velocità sugli ultimi ~100 ms (0 se il dito era fermo prima del rilascio)
    const now = performance.now(), s = g.s, last = s[s.length - 1];
    let v = 0;
    if (last && now - last.t < 80) {
      let first = last;
      for (let i = s.length - 1; i >= 0 && last.t - s[i].t <= 100; i--) first = s[i];
      if (last.t - first.t >= 8) v = (last.x - first.x) / (last.t - first.t);
    }
    const o = g.off, w = P.w, c = CAL_SW;
    let step = 0;
    if (!cancelled) {
      if (o < 0 && v < c.vel && (-o > w * c.commit || v < -c.vel)) step = 1;
      else if (o > 0 && v > -c.vel && (o > w * c.commit || v > c.vel)) step = -1;
    }
    if (step) opts.commit(step); // aggiorna CAL.date (le pagine si ridisegnano a fine corsa)
    pgAnimate(P, -step * w, v);
  };
  const findTouch = (list, id) => { for (let i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i]; return null; };
  const onMove = e => {
    const g = P.g;
    if (!g || g.src !== 'touch' || g.last === e) return;
    g.last = e;
    if (e.touches.length > 1) { finish(true); return; } // secondo dito: lascia il pinch al browser
    const t = findTouch(e.touches, g.id);
    if (t) move(t.clientX, t.clientY, e);
  };
  const onEnd = e => {
    const g = P.g;
    if (!g || g.src !== 'touch' || g.last === e) return;
    g.last = e;
    if (findTouch(e.changedTouches, g.id)) finish(e.type === 'touchcancel');
  };
  els.forEach(el => {
    el.addEventListener('touchstart', e => {
      if (e.touches.length !== 1) { if (P.g && P.g.src === 'touch') finish(true); return; }
      const t = e.touches[0];
      begin(t.clientX, t.clientY, 'touch', t.identifier);
      const tgt = e.target;
      if (tgt && tgt.addEventListener && els.indexOf(tgt) < 0) {
        tgt.addEventListener('touchmove', onMove, { passive: false });
        tgt.addEventListener('touchend', onEnd);
        tgt.addEventListener('touchcancel', onEnd);
        P.g.cleanup = () => {
          tgt.removeEventListener('touchmove', onMove, { passive: false });
          tgt.removeEventListener('touchend', onEnd);
          tgt.removeEventListener('touchcancel', onEnd);
        };
      }
    }, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    el.addEventListener('click', e => {
      if (performance.now() < P.noClickT) { e.stopPropagation(); e.preventDefault(); P.noClickT = 0; }
    }, true);
    if (!opts.mouse) return;
    el.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      begin(e.clientX, e.clientY, 'mouse', e.pointerId);
    });
    el.addEventListener('pointermove', e => {
      const g = P.g;
      if (!g || g.src !== 'mouse' || e.pointerId !== g.id) return;
      if (e.buttons === 0) { finish(true); return; } // pointerup perso (rilasciato fuori prima del lock)
      const was = g.lock;
      move(e.clientX, e.clientY, null);
      // cattura solo dopo il lock: catturando sul pointerdown il click finirebbe sul contenitore, non sul giorno
      if (!was && g.lock === 'x') { try { el.setPointerCapture(e.pointerId); } catch (_) { } }
    });
    const up = cancelled => e => { const g = P.g; if (g && g.src === 'mouse' && e.pointerId === g.id) finish(cancelled); };
    el.addEventListener('pointerup', up(false));
    el.addEventListener('pointercancel', up(true));
  });
}

// ── Striscia settimana ──
// CALS.shown = giorno selezionato della pagina centrale attualmente a schermo.
const CALS = { shown: null };
function calStripTrack() { const w = document.getElementById('cal-strip-days'); return w ? w.firstElementChild : null; }
const SP = calPager({
  tracks: () => { const t = calStripTrack(); return t ? [t] : []; },
  width: () => { const w = document.getElementById('cal-strip-days'); return w ? w.clientWidth : 0; },
  settle: ds => calStripBuild(ds)
});

// Una settimana (7 bottoni) contenente weekDs; selDs riceve l'anello "sel"; side = 'prev' | 'next' | ''
function calStripPage(weekDs, selDs, side) {
  const page = document.createElement('div'); page.className = 'cal-strip-page' + (side ? ' ' + side : '');
  if (side) page.setAttribute('inert', ''); // fuori schermo: niente focus da tastiera
  const today = todayStr();
  calWeekDays(weekDs).forEach(ds => {
    const b = document.createElement('button'); b.className = 'cal-day';
    if (ds === today) b.classList.add('today');
    if (ds === selDs) b.classList.add('sel');
    if (eventiDelGiorno(ds).length) b.classList.add('has-ev');
    const n = document.createElement('div'); n.className = 'cal-day-num';
    n.textContent = String(parseInt(ds.slice(8), 10));
    const hc = heatColor(calcPct(ds));
    if (hc) n.style.background = hc;
    const dot = document.createElement('div'); dot.className = 'cal-day-dot';
    b.appendChild(n); b.appendChild(dot);
    b.setAttribute('aria-label', fmtDate(ds));
    b.onclick = () => { if (!SP.anims) calSetDate(ds); };
    page.appendChild(b);
  });
  return page;
}

// Ricostruisce il track centrato su centerDs (nuovo nodo, senza transform → nessuna animazione residua).
// Nelle pagine laterali "sel" sta sullo stesso giorno della settimana: durante il drag si vede dove si atterra.
function calStripBuild(centerDs) {
  const wrap = document.getElementById('cal-strip-days');
  if (!wrap) return;
  const track = document.createElement('div'); track.className = 'cal-strip-track';
  const prev = offsetDate(centerDs, -7), next = offsetDate(centerDs, 7);
  track.appendChild(calStripPage(prev, prev, 'prev'));
  track.appendChild(calStripPage(centerDs, centerDs, ''));
  track.appendChild(calStripPage(next, next, 'next'));
  if (SP.off) track.style.transform = pgTf(SP.off); // ricostruita durante un drag: resta sotto il dito
  wrap.innerHTML = '';
  wrap.appendChild(track);
  CALS.shown = centerDs;
}

function renderCalStrip() {
  // a fine animazione la striscia si ricostruisce su CAL.date; se nel frattempo CAL.date è cambiato
  // (saveEvento su un altro giorno) anche uno stop/catch deve ricostruire lì, non sulla vecchia destinazione
  if (SP.anims) { SP.dest = CAL.date; return; }
  calStripBuild(CAL.date);
}

// Allinea la striscia a CAL.date: stessa settimana → solo "sel", altrimenti slide di una pagina
function calStripUpdate() {
  pgStop(SP);
  const from = CALS.shown;
  const track = calStripTrack();
  if (!track || !from || SP.g || calWeekDays(from)[0] === calWeekDays(CAL.date)[0] || calReduceMotion()) { calStripBuild(CAL.date); return; }
  const sign = CAL.date > from ? 1 : -1;
  // pre-renderizza la settimana di destinazione nella pagina laterale (salti di più settimane inclusi)
  const side = sign > 0 ? 'next' : 'prev';
  track.replaceChild(calStripPage(CAL.date, CAL.date, side), track.children[sign > 0 ? 2 : 0]);
  SP.w = SP.width() || 1;
  pgAnimate(SP, -sign * SP.w, 0);
}

function calLayoutEventi(list) {
  const out = []; let cluster = []; let clusterEnd = -1;
  const flush = () => {
    if (!cluster.length) return;
    const cols = [];
    cluster.forEach(ev => {
      const s = minutesOf(ev.ora);
      let ci = cols.findIndex(end => end <= s);
      if (ci < 0) { cols.push(0); ci = cols.length - 1; }
      cols[ci] = s + Math.max(ev.durata, 15);
      out.push({ ev, col: ci, cols: 0 });
    });
    const n = cols.length;
    out.slice(out.length - cluster.length).forEach(o => o.cols = n);
    cluster = []; clusterEnd = -1;
  };
  list.forEach(ev => {
    const s = minutesOf(ev.ora), e = s + Math.max(ev.durata, 15);
    if (cluster.length && s >= clusterEnd) flush();
    cluster.push(ev); clusterEnd = Math.max(clusterEnd, e);
  });
  flush();
  return out;
}

// ── Vista giorno: pager a 3 pagine (giorno prec / corrente / succ) ──
// #cal-track (dentro .cal-pager, nella timeline: canvas eventi + linea "ora" per pagina) e #cal-ad-track
// (fascia tutto il giorno) si muovono insieme; griglia oraria ed etichette restano ferme.
const DP = calPager({
  tracks: () => ['cal-track', 'cal-ad-track'].map(id => document.getElementById(id)).filter(Boolean),
  width: () => { const p = document.querySelector('.cal-pager'); return p ? p.clientWidth : 0; },
  settle: () => calRenderPages()
});

function calRenderAllDay(page, ds) {
  page.innerHTML = '';
  eventiDelGiorno(ds).filter(e => e.tuttoIlGiorno).forEach(e => {
    const c = document.createElement('button');
    c.className = 'cal-chip' + (e.tipo === 'scadenza' ? ' scadenza' : '') + (e.completato ? ' done' : '');
    c.textContent = e.titolo || '(senza titolo)';
    c.onclick = () => openEventoModal(ds, e.id);
    page.appendChild(c);
  });
}

function calRenderCanvas(page, ds) {
  page.dataset.ds = ds;
  const canvas = page.querySelector('.cal-canvas');
  if (!canvas) return;
  canvas.innerHTML = '';
  const timed = eventiDelGiorno(ds).filter(e => !e.tuttoIlGiorno).sort((a, b) => minutesOf(a.ora) - minutesOf(b.ora));
  calLayoutEventi(timed).forEach(({ ev, col, cols }) => {
    const s = minutesOf(ev.ora);
    const el = document.createElement('button');
    el.className = 'cal-ev' + (ev.tipo === 'scadenza' ? ' scadenza' : '') + (ev.completato ? ' done' : '');
    el.style.top = (s / 60 * CAL_HOUR_H) + 'px';
    el.style.height = Math.max(CAL_MIN_EV, ev.durata / 60 * CAL_HOUR_H - 2) + 'px';
    el.style.width = `calc(${100 / cols}% - 3px)`;
    el.style.left = (col * 100 / cols) + '%';
    const t = document.createElement('div'); t.className = 'cal-ev-t'; t.textContent = ev.titolo || '(senza titolo)';
    const h = document.createElement('div'); h.className = 'cal-ev-h';
    h.textContent = ev.ora + ' – ' + fmtMin(s + ev.durata);
    el.appendChild(t);
    if (ev.durata >= 45) el.appendChild(h);
    el.onclick = e => { e.stopPropagation(); openEventoModal(ds, ev.id); };
    canvas.appendChild(el);
  });
}

// Ridisegna le 3 pagine attorno a CAL.date (i nodi pagina restano: un drag in corso non si interrompe)
function calRenderPages() {
  const pages = document.querySelectorAll('#cal-track > .cal-page');
  const adPages = document.querySelectorAll('#cal-ad-track > .cal-ad-page');
  [-1, 0, 1].forEach((o, i) => {
    const ds = offsetDate(CAL.date, o);
    if (pages[i]) calRenderCanvas(pages[i], ds);
    if (adPages[i]) calRenderAllDay(adPages[i], ds);
  });
  const ad = document.getElementById('cal-allday');
  // visibile se uno dei 3 giorni ne ha: durante lo swipe i chip del vicino si vedono e al settle non salta niente
  if (ad) ad.classList.toggle('show', [-1, 0, 1].some(o => eventiDelGiorno(offsetDate(CAL.date, o)).some(e => e.tuttoIlGiorno)));
  updateCalNow();
}

function renderCalDay(dir) {
  // durante lo slide verso CAL.date il ridisegno avviene a fine corsa (con i dati più recenti)
  if (DP.anims && DP.dest === CAL.date) return;
  if (DP.anims) pgSettle(DP); else calRenderPages();
  if (dir) {
    const cls = dir === 'left' ? 'cal-anim-l' : 'cal-anim-r';
    ['cal-page-cur', 'cal-ad-cur'].forEach(id => {
      const node = document.getElementById(id);
      if (!node) return;
      node.classList.remove('cal-anim-l', 'cal-anim-r');
      void node.offsetWidth;
      node.classList.add(cls);
    });
  }
}

function updateCalNow() {
  const today = todayStr();
  const n = new Date();
  const top = ((n.getHours() * 60 + n.getMinutes()) / 60 * CAL_HOUR_H) + 'px';
  document.querySelectorAll('#cal-track > .cal-page').forEach(p => {
    const el = p.querySelector('.cal-now');
    if (!el) return;
    const on = p.dataset.ds === today;
    el.classList.toggle('show', on);
    if (on) el.style.top = top;
  });
}

function calScrollToRelevant() {
  const sc = document.getElementById('cal-scroll');
  if (!sc) return;
  const timed = eventiDelGiorno(CAL.date).filter(e => !e.tuttoIlGiorno);
  const n = new Date();
  let min = CAL.date === todayStr() ? n.getHours() * 60 + n.getMinutes() : 8 * 60;
  if (timed.length) min = Math.min(min, Math.min.apply(null, timed.map(e => minutesOf(e.ora))));
  sc.scrollTop = Math.max(0, min / 60 * CAL_HOUR_H - Math.max(60, sc.clientHeight / 3));
}

// src: 'strip' = drag della striscia (la striscia si anima da sé), 'day' = swipe della timeline
// (le pagine giorno si ridisegnano a fine corsa, lo scroll verticale resta dov'è)
function calSetDate(ds, dir, src) {
  if (!ds || ds === CAL.date) return;
  CAL.date = ds;
  renderCalHeader();
  if (src !== 'strip') calStripUpdate();
  if (src !== 'day') {
    renderCalDay(dir);
    if (dir) calScrollToRelevant();
  }
}
function calShiftDay(delta) { calSetDate(offsetDate(CAL.date, delta), delta > 0 ? 'left' : 'right'); }
function calShiftWeek(delta) { calSetDate(offsetDate(CAL.date, delta * 7), delta > 0 ? 'left' : 'right'); }
function calGoToday() { calSetDate(todayStr()); calScrollToRelevant(); }

function calInitGestures() {
  // striscia: ±7 giorni, anche col mouse; nessun gesto nativo a un dito (non c'è niente da scrollare)
  const strip = document.querySelector('.cal-strip');
  if (strip) pgBind(SP, [strip], {
    mouse: true, preventAll: true,
    commit: step => calSetDate(offsetDate(CAL.date, step * 7), step > 0 ? 'left' : 'right', 'strip')
  });
  // timeline + fascia tutto il giorno: ±1 giorno, solo touch; lo scroll verticale resta nativo
  const day = ['cal-scroll', 'cal-allday'].map(id => document.getElementById(id)).filter(Boolean);
  if (day.length) pgBind(DP, day, { commit: step => calSetDate(offsetDate(CAL.date, step), null, 'day') });
  // gesto interrotto senza touchend (cambio schermo a metà drag, app in background): track a riposo
  const cancelAll = () => { pgCancel(DP); pgCancel(SP); };
  const scr = document.getElementById('screen-calendario');
  if (scr && typeof IntersectionObserver === 'function') {
    new IntersectionObserver(en => { if (en.some(x => x.intersectionRatio < .5)) cancelAll(); }, { threshold: [.5] }).observe(scr);
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelAll(); });
  setInterval(() => { if (curScreen === 'calendario') updateCalNow(); }, 30000);
}

// ── EDITOR EVENTO ─────────────────────────────────────────
const EV_DURATE = [15, 30, 45, 60, 90, 120, 180, 240, 360, 480];
let evDraft = null;

function openEventoModal(ds, id, prefillMin) {
  const day = getDay(ds);
  const eventi = ensureEventi(day);
  const src = id ? eventi.find(e => e.id === id) : null;
  const now = new Date();
  const startMin = typeof prefillMin === 'number' ? prefillMin
    : (ds === todayStr() ? Math.min(1410, Math.round((now.getHours() * 60 + now.getMinutes()) / 30) * 30) : 9 * 60);
  evDraft = src
    ? { ds, id: src.id, titolo: src.titolo, tipo: src.tipo, tuttoIlGiorno: src.tuttoIlGiorno, ora: src.ora || fmtMin(startMin), durata: src.durata || 60, completato: src.completato }
    : { ds, id: null, titolo: '', tipo: 'impegno', tuttoIlGiorno: false, ora: fmtMin(startMin), durata: 60, completato: false };
  document.getElementById('modal-overlay').classList.add('open');
  renderEventoModal();
}

function renderEventoModal() {
  if (!evDraft) return;
  document.getElementById('modal-title').textContent = evDraft.id ? 'Modifica evento' : 'Nuovo evento';
  const body = document.getElementById('modal-body');
  body.innerHTML = '';
  const form = document.createElement('div'); form.className = 'modal-form';

  const rTit = document.createElement('div'); rTit.className = 'form-row';
  const lTit = document.createElement('label'); lTit.className = 'form-label'; lTit.textContent = 'Titolo';
  const iTit = document.createElement('input'); iTit.className = 'form-input'; iTit.type = 'text';
  iTit.placeholder = 'Es. Lezione di analisi'; iTit.value = evDraft.titolo;
  iTit.addEventListener('input', e => { evDraft.titolo = e.target.value; });
  iTit.addEventListener('keydown', e => { if (e.key === 'Enter') saveEvento(); });
  rTit.appendChild(lTit); rTit.appendChild(iTit); form.appendChild(rTit);

  const rTipo = document.createElement('div'); rTipo.className = 'form-row';
  const lTipo = document.createElement('label'); lTipo.className = 'form-label'; lTipo.textContent = 'Tipo';
  const seg = document.createElement('div'); seg.className = 'ev-seg';
  [['impegno', 'Impegno'], ['scadenza', 'Scadenza']].forEach(([val, lab]) => {
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'ev-seg-btn' + (evDraft.tipo === val ? ' on' : ''); b.textContent = lab;
    b.onclick = () => { evDraft.tipo = val; renderEventoModal(); };
    seg.appendChild(b);
  });
  rTipo.appendChild(lTipo); rTipo.appendChild(seg); form.appendChild(rTipo);

  const rTog = document.createElement('div'); rTog.className = 'ev-toggle-row';
  const lTog = document.createElement('label'); lTog.className = 'form-label'; lTog.textContent = 'Tutto il giorno';
  lTog.style.marginBottom = '0';
  const tog = document.createElement('div'); tog.className = 'ev-toggle' + (evDraft.tuttoIlGiorno ? ' on' : '');
  tog.setAttribute('role', 'switch'); tog.setAttribute('tabindex', '0');
  tog.setAttribute('aria-checked', evDraft.tuttoIlGiorno ? 'true' : 'false');
  tog.onclick = () => { evDraft.tuttoIlGiorno = !evDraft.tuttoIlGiorno; renderEventoModal(); };
  rTog.appendChild(lTog); rTog.appendChild(tog); form.appendChild(rTog);

  if (!evDraft.tuttoIlGiorno) {
    const rTime = document.createElement('div'); rTime.className = 'form-row ev-time-row';
    const cOra = document.createElement('div');
    const lOra = document.createElement('label'); lOra.className = 'form-label'; lOra.textContent = 'Inizio';
    const iOra = document.createElement('input'); iOra.className = 'form-input'; iOra.type = 'time'; iOra.value = evDraft.ora;
    iOra.addEventListener('change', e => { evDraft.ora = e.target.value || evDraft.ora; });
    cOra.appendChild(lOra); cOra.appendChild(iOra);
    const cDur = document.createElement('div');
    const lDur = document.createElement('label'); lDur.className = 'form-label'; lDur.textContent = 'Durata';
    const sDur = document.createElement('select'); sDur.className = 'form-select';
    const opts = EV_DURATE.slice();
    if (opts.indexOf(evDraft.durata) < 0) { opts.push(evDraft.durata); opts.sort((a, b) => a - b); }
    opts.forEach(m => { const o = document.createElement('option'); o.value = String(m); o.textContent = fmtDur(m); if (m === evDraft.durata) o.selected = true; sDur.appendChild(o); });
    sDur.addEventListener('change', e => { evDraft.durata = parseInt(e.target.value, 10) || 60; });
    cDur.appendChild(lDur); cDur.appendChild(sDur);
    rTime.appendChild(cOra); rTime.appendChild(cDur); form.appendChild(rTime);
  }

  const rDone = document.createElement('div'); rDone.className = 'ev-toggle-row';
  const lDone = document.createElement('label'); lDone.className = 'form-label'; lDone.textContent = 'Fatto';
  lDone.style.marginBottom = '0';
  const tDone = document.createElement('div'); tDone.className = 'ev-toggle' + (evDraft.completato ? ' on' : '');
  tDone.setAttribute('role', 'switch'); tDone.setAttribute('tabindex', '0');
  tDone.setAttribute('aria-checked', evDraft.completato ? 'true' : 'false');
  tDone.onclick = () => { evDraft.completato = !evDraft.completato; renderEventoModal(); };
  rDone.appendChild(lDone); rDone.appendChild(tDone); form.appendChild(rDone);

  const btns = document.createElement('div'); btns.className = 'form-btns';
  const sv = document.createElement('button'); sv.className = 'btn-pri'; sv.textContent = evDraft.id ? 'Salva' : 'Aggiungi';
  sv.onclick = () => saveEvento();
  const bk = document.createElement('button'); bk.className = 'btn-sec'; bk.textContent = 'Annulla';
  bk.onclick = () => { evDraft = null; closeModal(); };
  btns.appendChild(sv); btns.appendChild(bk);
  if (evDraft.id) {
    const dl = document.createElement('button'); dl.className = 'btn-del'; dl.textContent = 'Elimina';
    dl.onclick = () => deleteEvento();
    btns.appendChild(dl);
  }
  form.appendChild(btns);
  body.appendChild(form);
  if (!evDraft.id) iTit.focus();
}

function saveEvento() {
  if (!evDraft) return;
  const titolo = (evDraft.titolo || '').trim();
  if (!titolo) { showToast('Serve un titolo'); return; }
  const ds = evDraft.ds;
  const day = getDay(ds);
  const eventi = ensureEventi(day);
  const payload = normalizeEvento({
    id: evDraft.id || uid(), titolo, tipo: evDraft.tipo,
    tuttoIlGiorno: evDraft.tuttoIlGiorno, ora: evDraft.ora, durata: evDraft.durata, completato: evDraft.completato
  });
  const idx = evDraft.id ? eventi.findIndex(e => e.id === evDraft.id) : -1;
  if (idx >= 0) eventi[idx] = payload; else eventi.push(payload);
  evDraft = null;
  closeModal();
  scheduleSync(ds, 'sd-an', 'st-an-sync');
  if (CAL.date !== ds) CAL.date = ds;
  renderCalHeader(); renderCalStrip(); renderCalDay();
}

function deleteEvento() {
  if (!evDraft || !evDraft.id) return;
  const ds = evDraft.ds;
  const day = getDay(ds);
  day.eventi = ensureEventi(day).filter(e => e.id !== evDraft.id);
  evDraft = null;
  closeModal();
  scheduleSync(ds, 'sd-an', 'st-an-sync');
  renderCalStrip(); renderCalDay();
}

export { CAL, normalizeEvento, ensureEventi, renderCalendario, renderCalStrip, renderCalDay, calShiftWeek, calGoToday, openEventoModal };
