// ── PLAN ──────────────────────────────────────────────────
function renderPlan() {
  renderDateNavHeader(selectedDate, 'plan-date-nav');
  const day = getDay(selectedDate);
  renderTaskInputs(day, selectedDate); renderHPlanList(); checkPriBanner(day);
  renderImpegniSection(); renderWeeklyHabits();
  setSS('sd-plan', 'st-plan', 'ok', 'pronto');
  updateTopProgressBar(calcPct(selectedDate) || 0);
}
function renderTaskInputs(day, today) {
  ensureSlotArrays(day);
  const c = document.getElementById('task-inputs'); c.innerHTML = '';
  const n = day.attivitaDelGiorno.compiti.length;
  for (let i = 0; i < n; i++) {
    const row = document.createElement('div'); row.className = 'plan-task';
    const num = document.createElement('span'); num.className = 'plan-num'; num.textContent = p2(i + 1);
    const inp = document.createElement('input'); inp.type = 'text'; inp.placeholder = `Attività ${i + 1}…`; inp.value = day.attivitaDelGiorno.compiti[i] || ''; inp.dataset.i = i;
    inp.addEventListener('input', e => { const d = getDay(today); d.attivitaDelGiorno.compiti[+e.target.dataset.i] = e.target.value; scheduleSync(today, 'sd-plan', 'st-plan'); });
    const pb = document.createElement('button'); pb.className = 'pri-toggle' + (day.attivitaDelGiorno.altaPriorita[i] ? ' on' : ''); pb.dataset.i = i; pb.title = 'Alta priorità'; pb.textContent = '🔥';
    pb.onclick = e => { e.stopPropagation(); const d = getDay(today); const idx = +e.currentTarget.dataset.i; d.attivitaDelGiorno.altaPriorita[idx] = !d.attivitaDelGiorno.altaPriorita[idx]; checkPriBanner(d); e.currentTarget.classList.toggle('on'); scheduleSync(today, 'sd-plan', 'st-plan'); };
    const db = document.createElement('button'); db.className = 'slot-del'; db.dataset.i = i; db.title = 'Elimina slot'; db.textContent = '🗑';
    db.disabled = n <= 1;
    db.onclick = e => {
      e.stopPropagation();
      const d = getDay(today);
      if (d.attivitaDelGiorno.compiti.length <= 1) return;
      const idx = +e.currentTarget.dataset.i;
      d.attivitaDelGiorno.compiti.splice(idx, 1);
      d.attivitaDelGiorno.altaPriorita.splice(idx, 1);
      d.attivitaDelGiorno.completatiTask.splice(idx, 1);
      scheduleSync(today, 'sd-plan', 'st-plan');
      renderTaskInputs(d, today);
      checkPriBanner(d);
    };
    row.appendChild(num); row.appendChild(inp); row.appendChild(pb); row.appendChild(db); c.appendChild(row);
  }
  const addRow = document.createElement('button'); addRow.className = 'slot-add'; addRow.type = 'button';
  addRow.innerHTML = '<span>+</span> aggiungi slot';
  addRow.onclick = () => {
    const d = getDay(today);
    d.attivitaDelGiorno.compiti.push('');
    d.attivitaDelGiorno.altaPriorita.push(false);
    d.attivitaDelGiorno.completatiTask.push(false);
    scheduleSync(today, 'sd-plan', 'st-plan');
    renderTaskInputs(d, today);
  };
  c.appendChild(addRow);
  const impegni = getImpegniDelGiorno(today);
  if (impegni.length) {
    const sep = document.createElement('div');
    sep.className = 'plan-impegni-sep';
    sep.textContent = '— Impegni ricorrenti di oggi —';
    c.appendChild(sep);
    impegni.forEach(r => {
      const row = document.createElement('div');
      row.className = 'plan-task plan-impegno';
      const num = document.createElement('span'); num.className = 'plan-num'; num.textContent = '🔁';
      const lbl = document.createElement('div'); lbl.className = 'plan-impegno-lbl';
      lbl.textContent = r.titolo + (r.ora ? ` · ${r.ora}` : '');
      row.appendChild(num); row.appendChild(lbl);
      c.appendChild(row);
    });
  }
}
function checkPriBanner(day) { const has = day.attivitaDelGiorno.altaPriorita.some(v => v); document.getElementById('pri-banner').style.display = has ? 'flex' : 'none'; }
function renderHPlanList() {
  const c = document.getElementById('hplan-list'); c.innerHTML = ''; const habits = activeHabits();
  if (!habits.length) { c.innerHTML = '<div class="empty-state"><div class="empty-lbl">Nessuna abitudine — premi ⚙ per aggiungerne</div></div>'; return; }
  habits.forEach(h => { const row = document.createElement('div'); row.className = 'hplan-row'; const nm = document.createElement('span'); nm.className = 'hplan-name'; nm.textContent = h.nome; const fr = document.createElement('span'); fr.className = 'hplan-freq'; fr.textContent = h.frequenza === 'settimanale' ? `sett. ×${h.targetSettimanale}` : 'giorn.'; row.appendChild(nm); row.appendChild(fr); c.appendChild(row); });
}

function renderWeeklyHabits() {
  const c = document.getElementById('wh-section'); c.innerHTML = ''; const habits = activeHabits().filter(h => h.frequenza === 'settimanale');
  if (!habits.length) { c.innerHTML = '<div style="font-family:var(--mono);font-size:11px;color:var(--text3);letter-spacing:.1em">Nessuna abitudine settimanale.</div>'; return; }
  const week = weekDays();
  habits.forEach(h => { const row = document.createElement('div'); row.className = 'wh-row'; const nm = document.createElement('div'); nm.className = 'wh-name'; nm.textContent = h.nome; const track = document.createElement('div'); track.className = 'wh-track'; let cnt = 0; for (let i = 0; i < h.targetSettimanale; i++) { const dot = document.createElement('div'); const r = week[i] && S.days[week[i]] && S.days[week[i]].abitudini[h.id] || {}; dot.className = 'wh-dot' + (r.completato ? ' done' : ''); if (r.completato) cnt++; track.appendChild(dot); } const count = document.createElement('div'); count.className = 'wh-count'; count.textContent = `${cnt}/${h.targetSettimanale}`; row.appendChild(nm); row.appendChild(track); row.appendChild(count); c.appendChild(row); });
}

// ── MODAL ABITUDINI ───────────────────────────────────────
function openModal() { mMode = 'list'; renderModal(); }
function closeModal() { document.getElementById('modal-overlay').classList.remove('open'); }
function overlayClick(e) { if (e.target === document.getElementById('modal-overlay')) closeModal(); }
function renderModal() {
  document.getElementById('modal-overlay').classList.add('open');
  if (mMode === 'list') renderModalList(); else renderModalForm(mMode === 'edit' ? S.habits.find(h => h.id === editId) : null);
}
function renderModalList() {
  document.getElementById('modal-title').textContent = 'Gestione abitudini';
  const body = document.getElementById('modal-body'); body.innerHTML = ''; const habits = activeHabits();
  if (!habits.length) { const e = document.createElement('div'); e.className = 'empty-state'; e.innerHTML = '<div class="empty-lbl">Nessuna abitudine ancora</div>'; body.appendChild(e); }
  habits.forEach(h => {
    const row = document.createElement('div'); row.className = 'hmanage-row'; row.draggable = true;
    row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', h.id); row.classList.add('dragging'); });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    row.addEventListener('dragover', (e) => e.preventDefault());
    row.addEventListener('drop', (e) => {
      e.preventDefault(); const dId = e.dataTransfer.getData('text/plain');
      if (dId && dId !== h.id) {
        const arr = activeHabits(); const dIdx = arr.findIndex(x => x.id === dId); const tIdx = arr.findIndex(x => x.id === h.id);
        const dH = arr.splice(dIdx, 1)[0]; arr.splice(tIdx, 0, dH); arr.forEach((x, i) => x.ordine = i);
        persist(); sbSaveHabits(); renderModalList(); if (curScreen === 'plan') renderHPlanList();
      }
    });
    row.onclick = (e) => { if (e.target.closest('.arr-btn')) return; editId = h.id; mMode = 'edit'; renderModal(); };
    const handle = document.createElement('div'); handle.className = 'drag-handle'; handle.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>';
    const info = document.createElement('div'); info.className = 'hmanage-info';
    const nm = document.createElement('div'); nm.className = 'hmanage-name'; nm.textContent = h.nome;
    const meta = document.createElement('div'); meta.className = 'hmanage-meta'; meta.textContent = h.frequenza === 'settimanale' ? `settimanale × ${h.targetSettimanale}` : 'giornaliera';
    info.appendChild(nm); info.appendChild(meta);
    const arrows = document.createElement('div'); arrows.className = 'arrows';
    const up = document.createElement('button'); up.className = 'arr-btn'; up.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><polyline points="18 15 12 9 6 15"/></svg>'; up.onclick = e => { e.stopPropagation(); moveHabit(h.id, -1); };
    const dn = document.createElement('button'); dn.className = 'arr-btn'; dn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><polyline points="6 9 12 15 18 9"/></svg>'; dn.onclick = e => { e.stopPropagation(); moveHabit(h.id, 1); };
    arrows.appendChild(up); arrows.appendChild(dn);
    row.appendChild(handle); row.appendChild(info); row.appendChild(arrows); body.appendChild(row);
  });
  const addBtn = document.createElement('button'); addBtn.className = 'add-habit-btn'; addBtn.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>Aggiungi abitudine'; addBtn.onclick = () => { mMode = 'add'; renderModal(); }; body.appendChild(addBtn);
}
function moveHabit(id, dir) { const habits = activeHabits(); const idx = habits.findIndex(h => h.id === id); const nIdx = idx + dir; if (nIdx < 0 || nIdx >= habits.length) return; const tmp = habits[idx].ordine; habits[idx].ordine = habits[nIdx].ordine; habits[nIdx].ordine = tmp; persist(); sbSaveHabits(); renderModalList(); if (curScreen === 'plan') renderHPlanList(); }
function renderModalForm(habit) {
  document.getElementById('modal-title').textContent = habit ? 'Modifica abitudine' : 'Nuova abitudine';
  const body = document.getElementById('modal-body'); body.innerHTML = ''; const form = document.createElement('div'); form.className = 'modal-form'; const isSett = habit && habit.frequenza === 'settimanale';
  form.innerHTML = `<div class="form-row"><label class="form-label">Nome</label><input class="form-input" id="f-nome" type="text" placeholder="Es. Bere acqua"></div><div class="form-row"><label class="form-label">Frequenza</label><select class="form-select" id="f-freq" onchange="document.getElementById('f-trow').style.display=this.value==='settimanale'?'block':'none'"><option value="giornaliera"${!isSett ? ' selected' : ''}>Giornaliera</option><option value="settimanale"${isSett ? ' selected' : ''}>Settimanale</option></select></div><div class="form-row" id="f-trow" style="display:${isSett ? 'block' : 'none'}"><label class="form-label">Obiettivo settimanale (volte)</label><input class="form-input" id="f-target" type="number" min="1" max="7" value="${habit ? habit.targetSettimanale || 3 : 3}"></div>`;
  const btns = document.createElement('div'); btns.className = 'form-btns';
  const sv = document.createElement('button'); sv.className = 'btn-pri'; sv.textContent = habit ? 'Salva' : 'Aggiungi'; sv.onclick = () => submitForm(habit ? habit.id : null);
  const bk = document.createElement('button'); bk.className = 'btn-sec'; bk.textContent = 'Indietro'; bk.onclick = () => { mMode = 'list'; renderModal(); };
  btns.appendChild(sv); btns.appendChild(bk);
  if (habit) { const dl = document.createElement('button'); dl.className = 'btn-del'; dl.textContent = 'Elimina'; dl.onclick = () => deleteHabit(habit.id); btns.appendChild(dl); }
  form.appendChild(btns); body.appendChild(form);
  const nomeInput = document.getElementById('f-nome');
  if (habit) nomeInput.value = habit.nome;
  nomeInput.focus();
}
function submitForm(id) {
  const nome = document.getElementById('f-nome').value.trim(); if (!nome) return;
  const freq = document.getElementById('f-freq').value; const target = parseInt(document.getElementById('f-target')?.value) || 3;
  if (id) { const h = S.habits.find(h => h.id === id); if (h) { h.nome = nome; h.frequenza = freq; h.targetSettimanale = target; } }
  else { const maxOrd = S.habits.length ? Math.max(...S.habits.map(h => h.ordine)) : 0; S.habits.push({ id: uid(), nome, frequenza: freq, targetSettimanale: target, ordine: maxOrd + 1, attiva: true }); }
  persist(); sbSaveHabits(); mMode = 'list'; renderModal(); if (curScreen === 'plan') renderPlan(); if (curScreen === 'oggi') renderOggi();
}
function deleteHabit(id) { if (!confirm('Eliminare questa abitudine?')) return; S.habits = S.habits.filter(h => h.id !== id); persist(); sbSaveHabits(); mMode = 'list'; renderModal(); if (curScreen === 'plan') renderPlan(); if (curScreen === 'oggi') renderOggi(); }

// ── MODAL IMPEGNI RICORRENTI ──────────────────────────────
let impegniMode = 'list';
let editImpId = null;
const GIORNI_LBL = ['L', 'M', 'M', 'G', 'V', 'S', 'D'];
const GIORNI_FULL = ['lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom'];

function activeImpegni() {
  const arr = (S.impegniRicorrenti || []).filter(r => r.attivo !== false);
  return arr.slice().sort((a, b) => (a.ordine || 0) - (b.ordine || 0));
}

function openImpegniModal() { impegniMode = 'list'; renderImpegniModal(); }

function renderImpegniModal() {
  document.getElementById('modal-overlay').classList.add('open');
  if (impegniMode === 'list') renderImpegniList();
  else renderImpegniForm(impegniMode === 'edit' ? (S.impegniRicorrenti || []).find(r => r.id === editImpId) : null);
}

function renderImpegniList() {
  document.getElementById('modal-title').textContent = 'Gestione impegni ricorrenti';
  const body = document.getElementById('modal-body'); body.innerHTML = '';
  const list = activeImpegni();
  if (!list.length) { const e = document.createElement('div'); e.className = 'empty-state'; e.innerHTML = '<div class="empty-lbl">Nessun impegno ricorrente</div>'; body.appendChild(e); }
  list.forEach(r => {
    const row = document.createElement('div'); row.className = 'hmanage-row'; row.draggable = true;
    row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', r.id); row.classList.add('dragging'); });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    row.addEventListener('dragover', (e) => e.preventDefault());
    row.addEventListener('drop', (e) => {
      e.preventDefault(); const dId = e.dataTransfer.getData('text/plain');
      if (dId && dId !== r.id) {
        const arr = activeImpegni(); const dIdx = arr.findIndex(x => x.id === dId); const tIdx = arr.findIndex(x => x.id === r.id);
        const dR = arr.splice(dIdx, 1)[0]; arr.splice(tIdx, 0, dR); arr.forEach((x, i) => x.ordine = i);
        persist(); sbSaveHabits(); renderImpegniList(); renderImpegniSection();
      }
    });
    row.onclick = (e) => { if (e.target.closest('.arr-btn')) return; editImpId = r.id; impegniMode = 'edit'; renderImpegniModal(); };
    const handle = document.createElement('div'); handle.className = 'drag-handle'; handle.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>';
    const info = document.createElement('div'); info.className = 'hmanage-info';
    const nm = document.createElement('div'); nm.className = 'hmanage-name'; nm.textContent = r.titolo;
    const meta = document.createElement('div'); meta.className = 'hmanage-meta';
    const gg = (r.giorniSettimana || []).slice().sort((a, b) => a - b).map(g => GIORNI_FULL[g - 1]).join(' ');
    meta.textContent = (gg || 'nessun giorno') + (r.ora ? ` · ${r.ora}` : '');
    info.appendChild(nm); info.appendChild(meta);
    const arrows = document.createElement('div'); arrows.className = 'arrows';
    const up = document.createElement('button'); up.className = 'arr-btn'; up.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><polyline points="18 15 12 9 6 15"/></svg>'; up.onclick = e => { e.stopPropagation(); moveImpegno(r.id, -1); };
    const dn = document.createElement('button'); dn.className = 'arr-btn'; dn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><polyline points="6 9 12 15 18 9"/></svg>'; dn.onclick = e => { e.stopPropagation(); moveImpegno(r.id, 1); };
    arrows.appendChild(up); arrows.appendChild(dn);
    row.appendChild(handle); row.appendChild(info); row.appendChild(arrows); body.appendChild(row);
  });
  const addBtn = document.createElement('button'); addBtn.className = 'add-habit-btn';
  addBtn.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>Aggiungi impegno';
  addBtn.onclick = () => { impegniMode = 'add'; renderImpegniModal(); };
  body.appendChild(addBtn);
}

function moveImpegno(id, dir) {
  const arr = activeImpegni(); const idx = arr.findIndex(r => r.id === id); const nIdx = idx + dir;
  if (nIdx < 0 || nIdx >= arr.length) return;
  const tmp = arr[idx].ordine; arr[idx].ordine = arr[nIdx].ordine; arr[nIdx].ordine = tmp;
  persist(); sbSaveHabits(); renderImpegniList(); renderImpegniSection();
}

function renderImpegniForm(rec) {
  document.getElementById('modal-title').textContent = rec ? 'Modifica impegno' : 'Nuovo impegno';
  const body = document.getElementById('modal-body'); body.innerHTML = '';
  const form = document.createElement('div'); form.className = 'modal-form';
  const days = rec ? (rec.giorniSettimana || []) : [];
  const checks = GIORNI_LBL.map((lbl, i) => {
    const dNum = i + 1; const on = days.includes(dNum);
    return `<label class="day-pill${on ? ' on' : ''}"><input type="checkbox" data-d="${dNum}"${on ? ' checked' : ''}/>${lbl}</label>`;
  }).join('');
  form.innerHTML = `
    <div class="form-row"><label class="form-label">Nome</label><input class="form-input" id="if-nome" type="text" placeholder="Es. Palestra"></div>
    <div class="form-row"><label class="form-label">Ora (opzionale)</label><input class="form-input" id="if-ora" type="time" value="${rec && rec.ora ? rec.ora : ''}"></div>
    <div class="form-row"><label class="form-label">Giorni della settimana</label><div class="day-pills" id="if-days">${checks}</div></div>
  `;
  const btns = document.createElement('div'); btns.className = 'form-btns';
  const sv = document.createElement('button'); sv.className = 'btn-pri'; sv.textContent = rec ? 'Salva' : 'Aggiungi';
  sv.onclick = () => submitImpegnoForm(rec ? rec.id : null);
  const bk = document.createElement('button'); bk.className = 'btn-sec'; bk.textContent = 'Indietro';
  bk.onclick = () => { impegniMode = 'list'; renderImpegniModal(); };
  btns.appendChild(sv); btns.appendChild(bk);
  if (rec) { const dl = document.createElement('button'); dl.className = 'btn-del'; dl.textContent = 'Elimina'; dl.onclick = () => deleteImpegno(rec.id); btns.appendChild(dl); }
  form.appendChild(btns); body.appendChild(form);
  form.querySelectorAll('.day-pill input').forEach(inp => {
    inp.addEventListener('change', e => { e.currentTarget.parentElement.classList.toggle('on', e.currentTarget.checked); });
  });
  const ni = document.getElementById('if-nome');
  if (rec) ni.value = rec.titolo;
  ni.focus();
}

function submitImpegnoForm(id) {
  const titolo = document.getElementById('if-nome').value.trim(); if (!titolo) return;
  const ora = document.getElementById('if-ora').value || '';
  const days = Array.from(document.querySelectorAll('#if-days input:checked')).map(i => +i.dataset.d);
  if (!days.length) { alert('Seleziona almeno un giorno'); return; }
  if (!Array.isArray(S.impegniRicorrenti)) S.impegniRicorrenti = [];
  if (id) {
    const r = S.impegniRicorrenti.find(x => x.id === id);
    if (r) { r.titolo = titolo; r.ora = ora; r.giorniSettimana = days; r.attivo = r.attivo !== false; }
  } else {
    const maxOrd = S.impegniRicorrenti.length ? Math.max(...S.impegniRicorrenti.map(r => r.ordine || 0)) : -1;
    S.impegniRicorrenti.push({ id: uid(), titolo, ora, giorniSettimana: days, ordine: maxOrd + 1, attivo: true });
  }
  persist(); sbSaveHabits();
  impegniMode = 'list'; renderImpegniModal(); renderImpegniSection();
}

function deleteImpegno(id) {
  if (!confirm('Eliminare questo impegno ricorrente?')) return;
  S.impegniRicorrenti = (S.impegniRicorrenti || []).filter(r => r.id !== id);
  persist(); sbSaveHabits();
  impegniMode = 'list'; renderImpegniModal(); renderImpegniSection();
}

function renderImpegniSection() {
  const c = document.getElementById('impegni-section'); if (!c) return;
  c.innerHTML = ''; const list = activeImpegni();
  if (!list.length) { c.innerHTML = '<div class="empty-state"><div class="empty-lbl">Nessun impegno ricorrente — premi ⚙ per aggiungerne</div></div>'; return; }
  list.forEach(r => {
    const row = document.createElement('div'); row.className = 'wh-row';
    const nm = document.createElement('div'); nm.className = 'wh-name'; nm.textContent = r.titolo;
    const days = (r.giorniSettimana || []).slice().sort((a, b) => a - b);
    const track = document.createElement('div'); track.className = 'wh-days-mini';
    GIORNI_LBL.forEach((lbl, i) => {
      const dot = document.createElement('span');
      dot.className = 'day-mini' + (days.includes(i + 1) ? ' on' : '');
      dot.textContent = lbl;
      track.appendChild(dot);
    });
    const ora = document.createElement('div'); ora.className = 'wh-count'; ora.textContent = r.ora || '';
    row.appendChild(nm); row.appendChild(track); row.appendChild(ora); c.appendChild(row);
  });
}
