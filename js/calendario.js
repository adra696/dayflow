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

// Striscia settimana: track a 3 pagine (prec / corrente / succ), a riposo su -100%.
// CALS.shown = giorno selezionato della pagina centrale attualmente a schermo.
const CALS = { anim: false, to: null, seq: 0, timer: 0, shown: null, drag: null, raf: 0, noClick: false };
const calReduceMotion = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
function calStripTrack() { const w = document.getElementById('cal-strip-days'); return w ? w.firstElementChild : null; }

// Una settimana (7 bottoni) contenente weekDs; selDs riceve l'anello "sel"
function calStripPage(weekDs, selDs) {
  const page = document.createElement('div'); page.className = 'cal-strip-page';
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
    b.onclick = () => { if (!CALS.anim) calSetDate(ds); };
    page.appendChild(b);
  });
  return page;
}

// Ricostruisce il track centrato su centerDs (nuovo nodo → niente transition, niente flash).
// Nelle pagine laterali "sel" sta sullo stesso giorno della settimana: durante il drag si vede dove si atterra.
function calStripBuild(centerDs) {
  const wrap = document.getElementById('cal-strip-days');
  if (!wrap) return;
  const track = document.createElement('div'); track.className = 'cal-strip-track';
  [-7, 0, 7].forEach(off => { const d = offsetDate(centerDs, off); track.appendChild(calStripPage(d, d)); });
  wrap.innerHTML = '';
  wrap.appendChild(track);
  CALS.shown = centerDs;
}

function renderCalStrip() {
  if (CALS.anim) return; // a fine animazione la striscia si ricostruisce comunque
  calStripBuild(CAL.date);
}

// Anima il track verso pct (0 = prec, -100 = centro, -200 = succ); a fine corsa ricostruisce su CAL.date
function calStripAnimate(track, pct, to) {
  const seq = ++CALS.seq;
  CALS.anim = true; CALS.to = to;
  track.classList.add('anim');
  void track.offsetWidth;
  track.style.transform = `translateX(${pct}%)`;
  const done = () => {
    if (seq !== CALS.seq || !CALS.anim) return; // doppia chiamata o animazione già interrotta
    clearTimeout(CALS.timer);
    CALS.anim = false;
    calStripBuild(CAL.date);
  };
  track.addEventListener('transitionend', e => { if (e.target === track && e.propertyName === 'transform') done(); });
  clearTimeout(CALS.timer);
  CALS.timer = setTimeout(done, 450);
}

// Interrompe un'animazione in corso fermando la striscia sulla settimana di destinazione
function calStripStop() {
  if (!CALS.anim) return;
  CALS.seq++; clearTimeout(CALS.timer);
  CALS.anim = false;
  calStripBuild(CALS.to);
}

// Allinea la striscia a CAL.date: stessa settimana → solo "sel", altrimenti slide di una pagina
function calStripUpdate() {
  calStripStop();
  const from = CALS.shown;
  const track = calStripTrack();
  if (!track || !from || calWeekDays(from)[0] === calWeekDays(CAL.date)[0] || calReduceMotion()) { calStripBuild(CAL.date); return; }
  const sign = CAL.date > from ? 1 : -1;
  // pre-renderizza la settimana di destinazione nella pagina laterale (salti di più settimane inclusi)
  track.replaceChild(calStripPage(CAL.date, CAL.date), track.children[sign > 0 ? 2 : 0]);
  calStripAnimate(track, sign > 0 ? -200 : 0, CAL.date);
}

// Drag con Pointer Events (touch + mouse): la striscia segue il dito
function calInitStripDrag() {
  const strip = document.querySelector('.cal-strip');
  const wrap = document.getElementById('cal-strip-days');
  if (!strip || !wrap) return;
  const paint = () => {
    CALS.raf = 0;
    const d = CALS.drag, track = calStripTrack();
    if (!d || !track) return;
    track.style.transform = `translateX(calc(-100% + ${d.dx}px))`;
  };
  const end = (e, cancelled) => {
    const d = CALS.drag;
    if (!d || e.pointerId !== d.id) return;
    CALS.drag = null;
    if (CALS.raf) { cancelAnimationFrame(CALS.raf); CALS.raf = 0; }
    if (d.lock !== 'x') return;
    CALS.noClick = true; setTimeout(() => { CALS.noClick = false; }, 0);
    const track = calStripTrack();
    if (!track) return;
    track.style.transform = `translateX(calc(-100% + ${d.dx}px))`;
    const w = wrap.clientWidth || 1;
    const v = (performance.now() - d.lastT > 100) ? 0 : d.v;
    let step = 0;
    if (!cancelled) {
      if (d.dx < 0 && (-d.dx > w * .25 || v < -.4)) step = 1;
      else if (d.dx > 0 && (d.dx > w * .25 || v > .4)) step = -1;
    }
    if (step) { calSetDate(offsetDate(CAL.date, step * 7), step > 0 ? 'left' : 'right'); return; }
    if (calReduceMotion()) { calStripBuild(CAL.date); return; }
    calStripAnimate(track, -100, CAL.date); // ritorno alla settimana corrente
  };
  strip.addEventListener('pointerdown', e => {
    if (CALS.anim || CALS.drag || !e.isPrimary) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const t = performance.now();
    CALS.drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, lock: null, lastX: e.clientX, lastT: t, v: 0 };
  });
  strip.addEventListener('pointermove', e => {
    const d = CALS.drag;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    if (d.lock === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      d.lock = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (d.lock === 'x') {
        try { strip.setPointerCapture(e.pointerId); } catch (_) { }
        const track = calStripTrack(); if (track) track.classList.remove('anim');
      }
    }
    if (d.lock !== 'x') return;
    const w = wrap.clientWidth || 1;
    d.dx = Math.max(-w, Math.min(w, dx));
    const t = performance.now(), dt = t - d.lastT;
    if (dt > 0) { d.v = .8 * ((e.clientX - d.lastX) / dt) + .2 * d.v; d.lastX = e.clientX; d.lastT = t; }
    if (!CALS.raf) CALS.raf = requestAnimationFrame(paint);
  });
  strip.addEventListener('pointerup', e => end(e, false));
  strip.addEventListener('pointercancel', e => end(e, true));
  // niente tap sul giorno se c'è stato un drag
  strip.addEventListener('click', e => { if (CALS.noClick) { e.stopPropagation(); e.preventDefault(); CALS.noClick = false; } }, true);
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

function renderCalDay(dir) {
  const ds = CAL.date;
  const evs = eventiDelGiorno(ds);

  const ad = document.getElementById('cal-allday');
  if (ad) {
    ad.innerHTML = '';
    const allDay = evs.filter(e => e.tuttoIlGiorno);
    ad.classList.toggle('show', allDay.length > 0);
    allDay.forEach(e => {
      const c = document.createElement('button');
      c.className = 'cal-chip' + (e.tipo === 'scadenza' ? ' scadenza' : '') + (e.completato ? ' done' : '');
      c.textContent = e.titolo || '(senza titolo)';
      c.onclick = () => openEventoModal(ds, e.id);
      ad.appendChild(c);
    });
  }

  const canvas = document.getElementById('cal-canvas');
  if (!canvas) return;
  canvas.innerHTML = '';
  const timed = evs.filter(e => !e.tuttoIlGiorno).sort((a, b) => minutesOf(a.ora) - minutesOf(b.ora));
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

  if (dir) {
    const cls = dir === 'left' ? 'cal-anim-l' : 'cal-anim-r';
    [canvas, ad].forEach(node => {
      if (!node) return;
      node.classList.remove('cal-anim-l', 'cal-anim-r');
      void node.offsetWidth;
      node.classList.add(cls);
    });
  }
  updateCalNow();
}

function updateCalNow() {
  const el = document.getElementById('cal-now');
  if (!el) return;
  const isToday = CAL.date === todayStr();
  el.classList.toggle('show', isToday);
  if (!isToday) return;
  const n = new Date();
  el.style.top = ((n.getHours() * 60 + n.getMinutes()) / 60 * CAL_HOUR_H) + 'px';
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

function calSetDate(ds, dir) {
  if (!ds || ds === CAL.date) return;
  CAL.date = ds;
  renderCalHeader();
  calStripUpdate();
  renderCalDay(dir);
  if (dir) calScrollToRelevant();
}
function calShiftDay(delta) { calSetDate(offsetDate(CAL.date, delta), delta > 0 ? 'left' : 'right'); }
function calShiftWeek(delta) { calSetDate(offsetDate(CAL.date, delta * 7), delta > 0 ? 'left' : 'right'); }
function calGoToday() { calSetDate(todayStr()); calScrollToRelevant(); }

function calInitGestures() {
  calInitStripDrag();
  // swipe orizzontale sulla timeline: ±1 giorno
  [document.getElementById('cal-scroll')].forEach(el => {
    if (!el) return;
    const step = 1;
    let x0 = null, y0 = null, lock = null;
    el.addEventListener('touchstart', e => {
      if (e.touches.length !== 1) { x0 = null; return; }
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; lock = null;
    }, { passive: true });
    el.addEventListener('touchmove', e => {
      if (x0 === null || e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - x0, dy = e.touches[0].clientY - y0;
      if (lock === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) lock = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }, { passive: true });
    el.addEventListener('touchend', e => {
      if (x0 === null) return;
      const dx = e.changedTouches[0].clientX - x0;
      if (lock === 'x' && Math.abs(dx) > 45) calSetDate(offsetDate(CAL.date, dx < 0 ? step : -step), dx < 0 ? 'left' : 'right');
      x0 = null; lock = null;
    }, { passive: true });
  });
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
