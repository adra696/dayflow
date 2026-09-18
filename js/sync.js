let syncDebounce = null;
let pendingSync = new Set(); // giorni con modifiche non ancora confermate da Supabase (in coda o falliti)
const dirtyGen = new Map();  // ds → contatore modifiche: un save concluso rimuove ds da pendingSync solo se nel frattempo non è cambiato
let habitsDirty = false, habitsGen = 0; // profilo (abitudini + impegni ricorrenti) non ancora salvato
const PENDING_LS = 'dayflow_pending_sync';    // coda persistita: { uid, days: [ds], habits: bool }
const restoredPending = new Set();            // giorni in coda ripristinati da una sessione precedente (da riconciliare col remoto prima dell'upload)
const RETRY = { until: 0, delay: 0, running: false }; // backoff dei retry automatici (online / app visibile)
// Epoca di sessione: incrementata al logout. Ogni operazione di sync/load la cattura all'avvio e,
// dopo ogni await, se è cambiata esce senza toccare stato (coda, S, indicatori): una risposta
// della sessione precedente non può mai agire sulla sessione nuova.
let syncEpoch = 0;
let genSeq = 0; // contatore monotono per dirtyGen: mai riusato, nemmeno dopo il logout
const SYNC_INFO = { status: 'offline', msg: 'non ancora sincronizzato' }; // ultimo esito, mostrato in Impostazioni

// Merge giorno locale ↔ remoto (last-write-wins sul timestamp del client che ha scritto):
// - timestamp = Date.now() dell'ultima modifica locale, impostato SOLO da scheduleSync() (unico punto
//   di passaggio delle mutazioni di un giorno). Un giorno appena creato da getDay() vale 0 (mai modificato):
//   qualunque remoto lo sostituisce. Normalizzazioni in lettura (ensureSlotArrays/ensureEventi) non lo toccano.
// - il remoto vince solo se strettamente più recente; a parità (è il nostro stesso salvataggio) resta il locale.
// - un giorno in pendingSync modificato in QUESTA sessione non viene mai sovrascritto;
//   un giorno in coda RIPRISTINATO da una sessione precedente (restoredPending) segue last-write-wins:
//   se il remoto è strettamente più nuovo vince il remoto e il giorno esce dalla coda, altrimenti resta in coda.
// Orologi sfasati tra dispositivi possono far perdere la scrittura del dispositivo "indietro": accettato.
function adoptRemoteDay(ds, remote) {
  if (!remote) return false;
  const local = S.days[ds];
  if (local && pendingSync.has(ds)) {
    if (!restoredPending.has(ds) || (remote.timestamp || 0) <= (local.timestamp || 0)) return false;
    dropPendingDay(ds);
  }
  if (!Array.isArray(remote.eventi)) remote.eventi = (local && Array.isArray(local.eventi)) ? local.eventi : [];
  if (!local || ((remote.timestamp || 0) > (local.timestamp || 0))) { S.days[ds] = remote; return true; }
  return false;
}

// ── SUPABASE SYNC ─────────────────────────────────────────
// Ritorna (Promise) true se il profilo è stato salvato. habitsDirty resta true finché un salvataggio
// (non superato da uno più recente) va a buon fine: flushAllSync() lo ritenta.
// Un solo upload del profilo in volo alla volta: una chiamata durante l'upload segna la modifica
// (habitsGen++) e si aggancia alla promise in corso, che al termine riparte coi dati aggiornati se
// la generazione è cambiata. Su errore niente rerun immediato: restano le regole di retry/backoff.
let habitsInflight = null;
function sbSaveHabits() {
  if (!curUser || !sb) return Promise.resolve(false);
  habitsGen++;
  habitsDirty = true; savePendingQueue();
  if (habitsInflight) return habitsInflight;
  const epoch = syncEpoch;
  let p;
  p = (async () => {
    let ok;
    try {
      do {
        ok = await sbSaveHabitsOnce(epoch);
        if (epoch !== syncEpoch) return false; // sessione chiusa nel frattempo: nessun rerun
      } while (ok && habitsDirty && curUser);
    } finally { if (habitsInflight === p) habitsInflight = null; }
    return ok;
  })();
  habitsInflight = p;
  return p;
}
async function sbSaveHabitsOnce(epoch) {
  if (!curUser || !sb || epoch !== syncEpoch) return false;
  const gen = habitsGen;
  const uid = curUser.id;
  try {
    const payload = { id: uid, habits: S.habits, updated_at: new Date().toISOString() };
    if (Array.isArray(S.impegniRicorrenti) && S.impegniRicorrenti.length) {
      payload.impegni_ricorrenti = S.impegniRicorrenti;
    }
    const habitsOnly = { id: uid, habits: S.habits, updated_at: payload.updated_at };
    let { error } = await sb.from('profiles').upsert(payload);
    if (epoch !== syncEpoch) return false;
    if (error) {
      // Se la colonna impegni_ricorrenti non esiste nella tabella profiles, salva solo habits
      ({ error } = await sb.from('profiles').upsert(habitsOnly));
      if (epoch !== syncEpoch) return false;
    }
    if (error) throw error;
    if (gen === habitsGen) { habitsDirty = false; savePendingQueue(); }
    noteSync('ok');
    return true;
  } catch (e) {
    if (epoch !== syncEpoch) return false;
    console.error('sbSaveHabits', e);
    noteSync('err');
    return false;
  }
}
async function sbLoadHabits() {
  if (!curUser || !sb) return;
  const epoch = syncEpoch, uid = curUser.id;
  try {
    let res = await sb.from('profiles').select('habits, impegni_ricorrenti').eq('id', uid).maybeSingle();
    if (epoch !== syncEpoch) return;
    if (res.error) {
      // Fallback resiliente: se la colonna impegni_ricorrenti non esiste, carica solo le abitudini
      res = await sb.from('profiles').select('habits').eq('id', uid).maybeSingle();
      if (epoch !== syncEpoch) return;
    }
    const data = res?.data;
    // Profilo locale non ancora caricato (coda, anche ripristinata): il profilo non ha un timestamp
    // per record, quindi vince il locale e verrà caricato dalla sync; il remoto non lo sovrascrive.
    if (data && habitsDirty) return;
    if (data) {
      if (Array.isArray(data.habits) && data.habits.length) {
        S.habits = data.habits;
      }
      if (Array.isArray(data.impegni_ricorrenti) && data.impegni_ricorrenti.length) {
        S.impegniRicorrenti = data.impegni_ricorrenti;
      }
      persist();
      // Aggiorna subito la schermata attiva per mostrare le abitudini senza ritardi
      if (curScreen === 'oggi') {
        renderHOggiList(getDay(selectedDate), selectedDate);
        updateOggiStats(selectedDate);
      } else if (curScreen === 'plan') {
        renderPlan();
      } else if (curScreen === 'recap') {
        renderDiscover();
      }
    }
  } catch (e) { console.error('sbLoadHabits', e); }
}
let eventiColumnOk = true;
// Ritorna (Promise) true se il giorno è stato salvato su Supabase.
// Lock per giorno: al massimo un upsert di ds in volo. Una chiamata mentre ds è in volo si aggancia
// alla promise in corso; al termine, se il giorno è stato modificato nel frattempo (dirtyGen cambiato →
// ds ancora in pendingSync) l'upload riparte coi dati aggiornati, così l'ultimo payload arrivato al
// server è sempre il più recente. Su errore niente rerun immediato: ds resta in coda (retry/backoff).
const dayInflight = new Map(); // ds → Promise<boolean>
function sbSaveDay(ds, dotId, txtId) {
  if (dayInflight.has(ds)) return dayInflight.get(ds);
  const epoch = syncEpoch;
  let p;
  p = (async () => {
    let ok;
    try {
      do {
        ok = await sbSaveDayOnce(ds, dotId, txtId, epoch);
        if (epoch !== syncEpoch) return false; // sessione chiusa nel frattempo: nessun rerun
      } while (ok && pendingSync.has(ds) && curUser);
    } finally { if (dayInflight.get(ds) === p) dayInflight.delete(ds); } // mai il lock di un'altra sessione
    return ok;
  })();
  dayInflight.set(ds, p);
  return p;
}
async function sbSaveDayOnce(ds, dotId, txtId, epoch) {
  if (!curUser || !sb || epoch !== syncEpoch) return false;
  const day = S.days[ds]; if (!day) { pendingSync.delete(ds); restoredPending.delete(ds); savePendingQueue(); return true; }
  const gen = dirtyGen.get(ds) || 0;
  setSS(dotId, txtId, 'syncing', 'sincronizzazione...');
  const base = {
    user_id: curUser.id,
    data: ds,
    abitudini: day.abitudini,
    attivita_del_giorno: day.attivitaDelGiorno,
    impegni_ricorrenti_completati: day.impegniRicorrentiCompletati || {},
    note: day.note || '',
    timestamp: day.timestamp || Date.now()
  };
  try {
    const payload = eventiColumnOk ? Object.assign({ eventi: ensureEventi(day) }, base) : base;
    let { error } = await sb.from('days').upsert(payload, { onConflict: 'user_id,data' });
    if (epoch !== syncEpoch) return false;
    if (error && eventiColumnOk && /eventi/i.test(error.message || '')) {
      eventiColumnOk = false;
      console.warn('Colonna "eventi" assente su Supabase: gli eventi restano solo in locale.');
      ({ error } = await sb.from('days').upsert(base, { onConflict: 'user_id,data' }));
      if (epoch !== syncEpoch) return false;
    }
    if (error) throw error;
    if ((dirtyGen.get(ds) || 0) === gen) { pendingSync.delete(ds); restoredPending.delete(ds); savePendingQueue(); }
    setSS(dotId, txtId, 'ok', 'sincronizzato · ' + new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }));
    noteSync('ok');
    return true;
  } catch (e) {
    if (epoch !== syncEpoch) return false;
    console.error('sbSaveDay', e);
    pendingSync.add(ds); savePendingQueue();
    setSS(dotId, txtId, 'err', 'errore — salvato in locale');
    noteSync('err');
    return false;
  }
}
async function sbLoadDay(ds) {
  if (!curUser || !sb) return null;
  try {
    const epoch = syncEpoch;
    const { data } = await sb.from('days').select('*').eq('user_id', curUser.id).eq('data', ds).single();
    if (epoch !== syncEpoch || !data) return null; // risposta di una sessione chiusa: ignorata
    return { data: ds, abitudini: data.abitudini || {}, attivitaDelGiorno: data.attivita_del_giorno || { compiti: ['', '', ''], altaPriorita: [false, false, false], completato: false }, impegniRicorrentiCompletati: data.impegni_ricorrenti_completati || {}, eventi: Array.isArray(data.eventi) ? data.eventi : undefined, note: data.note || '', timestamp: data.timestamp || Date.now() };
  } catch (e) { return null; }
}
async function sbLoadAllDays() {
  if (!curUser || !sb) return null;
  try {
    const epoch = syncEpoch;
    const { data } = await sb.from('days').select('*').eq('user_id', curUser.id);
    if (epoch !== syncEpoch || !data) return null;
    const result = {};
    for (const row of data) {
      result[row.data] = { data: row.data, abitudini: row.abitudini || {}, attivitaDelGiorno: row.attivita_del_giorno || { compiti: ['', '', ''], altaPriorita: [false, false, false], completato: false }, impegniRicorrentiCompletati: row.impegni_ricorrenti_completati || {}, eventi: Array.isArray(row.eventi) ? row.eventi : undefined, note: row.note || '', timestamp: row.timestamp || Date.now() };
    }
    return result;
  } catch (e) { console.error('sbLoadAllDays', e); return null; }
}
async function sbLoadDaysRange(startDate, endDate) {
  if (!curUser || !sb) return null;
  try {
    const epoch = syncEpoch;
    const { data } = await sb.from('days').select('*').eq('user_id', curUser.id).gte('data', startDate).lte('data', endDate);
    if (epoch !== syncEpoch || !data) return null;
    const result = {};
    for (const row of data) {
      result[row.data] = { data: row.data, abitudini: row.abitudini || {}, attivitaDelGiorno: row.attivita_del_giorno || { compiti: ['', '', ''], altaPriorita: [false, false, false], completato: false }, impegniRicorrentiCompletati: row.impegni_ricorrenti_completati || {}, eventi: Array.isArray(row.eventi) ? row.eventi : undefined, note: row.note || '', timestamp: row.timestamp || Date.now() };
    }
    return result;
  } catch (e) { console.error('sbLoadDaysRange', e); return null; }
}
async function loadWindowForDate(ds) {
  if (!curUser || !sb) return;
  const startD = offsetDate(ds, -4);
  const endD = offsetDate(ds, 4);
  const windowDays = await sbLoadDaysRange(startD, endD);
  if (windowDays) {
    let changed = false;
    // stessa regola di merge del resto dell'app (prima questo punto la bypassava: niente
    // protezione di pendingSync e un remoto senza "eventi" cancellava gli eventi locali)
    for (const [dateStr, remote] of Object.entries(windowDays)) {
      if (adoptRemoteDay(dateStr, remote)) changed = true;
    }
    if (changed) {
      persist();
      if (curScreen === 'plan') renderPlan();
      else if (curScreen === 'oggi') renderOggi();
      else if (curScreen === 'recap') renderDiscover();
    }
  }
}
function sbLoadAllDaysInBackground() {
  if (!curUser || !sb) return;
  (async () => {
    try {
      const allDays = await sbLoadAllDays();
      if (allDays) {
        let changed = false;
        for (const [ds, remote] of Object.entries(allDays)) {
          if (adoptRemoteDay(ds, remote)) changed = true;
        }
        allDaysLoaded = true;
        persist();
        if (curScreen === 'oggi') renderOggi();
        else if (curScreen === 'calendario') renderCalendario();
      }
    } catch (e) {
      console.error('sbLoadAllDaysInBackground error', e);
    }
  })();
}
// Salva subito in locale e mette il giorno in coda; dopo 1,2 s di quiete salva su Supabase
// TUTTI i giorni in coda (prima veniva salvato solo l'ultimo giorno toccato).
function scheduleSync(ds, dotId, txtId) {
  if (S.days[ds]) S.days[ds].timestamp = Date.now(); // ultima modifica locale (vedi adoptRemoteDay)
  persist();
  pendingSync.add(ds);
  restoredPending.delete(ds); // modificato in questa sessione: è la scrittura più recente
  dirtyGen.set(ds, ++genSeq);
  savePendingQueue();
  clearTimeout(syncDebounce);
  syncDebounce = setTimeout(() => { syncDebounce = null; syncPendingDays(dotId, txtId); }, 1200);
}
async function syncPendingDays(dotId, txtId) {
  const epoch = syncEpoch;
  let ok = true;
  for (const ds of [...pendingSync]) {
    if (!(await reconcileRestoredDay(ds))) continue; // remoto più nuovo adottato: niente upload
    if (epoch !== syncEpoch) return false; // sessione chiusa: la coda ora è di un'altra sessione
    if (!pendingSync.has(ds)) continue;
    if (!(await sbSaveDay(ds, dotId, txtId))) ok = false;
    if (epoch !== syncEpoch) return false;
  }
  return ok;
}

// ── Coda di sync persistita ──
// La coda (giorni in pendingSync + habitsDirty) è scritta in localStorage a ogni cambiamento,
// legata all'utente: sopravvive a reload / chiusura della PWA entro il debounce / modifiche offline.
function savePendingQueue() {
  if (!curUser) return;
  try {
    if (!pendingSync.size && !habitsDirty) localStorage.removeItem(PENDING_LS);
    else localStorage.setItem(PENDING_LS, JSON.stringify({ uid: curUser.id, days: [...pendingSync], habits: habitsDirty }));
  } catch (e) { }
}
// Da chiamare in initApp dopo load() e PRIMA dei load remoti: così adoptRemoteDay/sbLoadHabits
// vedono già i giorni/profilo in coda. Una coda di un altro utente viene ignorata.
function restorePendingQueue() {
  let q = null;
  try { q = JSON.parse(localStorage.getItem(PENDING_LS) || 'null'); } catch (e) { }
  if (!q || !curUser || q.uid !== curUser.id) return;
  (Array.isArray(q.days) ? q.days : []).forEach(ds => {
    if (typeof ds === 'string' && S.days[ds] && !pendingSync.has(ds)) { pendingSync.add(ds); restoredPending.add(ds); }
  });
  // Profilo in coda solo se i dati locali ci sono davvero: mai caricare un profilo vuoto sopra quello remoto
  if (q.habits && ((S.habits && S.habits.length) || (S.impegniRicorrenti && S.impegniRicorrenti.length))) habitsDirty = true;
  savePendingQueue();
}
// Giorno ripristinato dalla coda: last-write-wins col remoto PRIMA dell'upload.
// remoto più nuovo → lo adotto e tolgo il giorno dalla coda (false = non caricare);
// remoto più vecchio/uguale, assente o non leggibile (offline) → si carica il locale (true).
// Il flag "ripristinato" resta finché l'upload riesce, così ogni retry ricontrolla il remoto.
async function reconcileRestoredDay(ds) {
  if (!restoredPending.has(ds)) return true;
  const epoch = syncEpoch;
  const remote = await sbLoadDay(ds);
  if (epoch !== syncEpoch) return false; // sessione chiusa: non tocco coda né S.days
  if (!restoredPending.has(ds)) return true; // modificato nel frattempo: ora vince il locale
  const local = S.days[ds];
  if (remote && local && (remote.timestamp || 0) > (local.timestamp || 0)) {
    adoptRemoteDay(ds, remote);
    persist();
    refreshDayViews(ds);
    return false;
  }
  return true;
}
function dropPendingDay(ds) {
  pendingSync.delete(ds); restoredPending.delete(ds);
  dirtyGen.set(ds, ++genSeq);
  savePendingQueue();
}
// Ridisegna la schermata attiva se mostra il giorno cambiato dal remoto
function refreshDayViews(ds) {
  if (curScreen === 'calendario') { renderCalStrip(); renderCalDay(); }
  else if (ds !== selectedDate) return;
  else if (curScreen === 'plan') renderPlan();
  else if (curScreen === 'oggi') { renderHOggiList(getDay(ds), ds); updateOggiStats(ds); }
}
// Retry automatico (online / app di nuovo visibile), solo su evento: niente timer, quindi niente loop.
// Backoff dopo un fallimento: 5 s, 10 s, 20 s… max 5 min; force (evento online) lo ignora.
async function retryPendingSync(force = false) {
  if (!curUser || !sb || RETRY.running) return;
  if (!pendingSync.size && !habitsDirty) return;
  if (!force && Date.now() < RETRY.until) return;
  RETRY.running = true;
  const epoch = syncEpoch;
  try {
    const ok = await flushAllSync(15000);
    if (epoch !== syncEpoch) return; // RETRY già azzerato dal logout
    if (ok) { RETRY.delay = 0; RETRY.until = 0; }
    else { RETRY.delay = Math.min(Math.max(RETRY.delay * 2, 5000), 300000); RETRY.until = Date.now() + RETRY.delay; }
  } finally { if (epoch === syncEpoch) RETRY.running = false; }
}
function hasUnsyncedChanges() { return pendingSync.size > 0 || habitsDirty || !!syncDebounce; }
// Svuota subito la coda (timer annullato): profilo + tutti i giorni pendenti.
// true solo se alla fine non resta nulla da sincronizzare. Timeout = fallimento (rete appesa).
async function flushAllSync(timeoutMs = 10000) {
  clearTimeout(syncDebounce); syncDebounce = null;
  if (!curUser || !sb) return !pendingSync.size && !habitsDirty;
  const ids = SYNC_IDS[curScreen] || SYNC_IDS.oggi;
  const epoch = syncEpoch;
  const run = (async () => {
    if (habitsDirty) await sbSaveHabits(); else if (habitsInflight) await habitsInflight;
    if (epoch !== syncEpoch) return false;
    await syncPendingDays(ids[0], ids[1]);
    // attende anche gli upload già in volo (e i loro rerun) partiti fuori da questo flush;
    // le mappe contengono solo upload dell'epoca corrente (il logout le svuota)
    while (epoch === syncEpoch && (dayInflight.size || habitsInflight)) {
      await Promise.all([...dayInflight.values(), habitsInflight].filter(Boolean));
    }
    if (epoch !== syncEpoch) return false;
    return !pendingSync.size && !habitsDirty;
  })();
  let timer;
  const timeout = new Promise(res => { timer = setTimeout(() => res(false), timeoutMs); });
  try { return await Promise.race([run, timeout]); }
  catch (e) { console.error('flushAllSync', e); return false; }
  finally { clearTimeout(timer); }
}
const SYNC_IDS = { plan: ['sd-plan', 'st-plan'], oggi: ['sd-oggi', 'st-oggi-sync'], recap: ['sd-recap', 'st-recap-sync'], calendario: ['sd-an', 'st-an-sync'] };
// Ultimo esito di sync per il pannello Impostazioni (aggiornato dal vivo se aperto)
function noteSync(status, msg) {
  SYNC_INFO.status = status;
  SYNC_INFO.msg = msg || (status === 'ok' ? 'sincronizzato · ' + new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : status === 'err' ? 'errore di sincronizzazione — dati salvati in locale' : status === 'syncing' ? 'sincronizzazione…' : 'non sincronizzato');
  renderSettingsSync();
}
// Argomenti Discover su profiles.feed_topics — colonna opzionale: se manca, resta solo localStorage
async function sbSaveFeedTopics() {
  if (!curUser || !sb) return;
  try {
    const { error } = await sb.from('profiles').upsert({ id: curUser.id, habits: S.habits, feed_topics: FEED.topics, updated_at: new Date().toISOString() });
    if (error) console.info('feed_topics non salvati su Supabase (colonna assente?)');
  } catch (e) { }
}
async function sbLoadFeedTopics() {
  if (!curUser || !sb) return;
  try {
    const res = await sb.from('profiles').select('feed_topics').eq('id', curUser.id).maybeSingle();
    const t = res?.data?.feed_topics;
    if (!res.error && Array.isArray(t) && t.length) {
      FEED.topics = t.filter(x => x && x.id && x.label).map(normalizeTopic);
      try { localStorage.setItem(FEED_TOPICS_LS, JSON.stringify(FEED.topics)); } catch (e) { }
      if (curScreen === 'recap') renderDiscover();
    }
  } catch (e) { }
}

// Sync pendenti quando torna online (ignora il backoff: la rete è appena cambiata)
window.addEventListener('online', () => { retryPendingSync(true); });
// App di nuovo visibile → retry (con backoff). App nascosta / pagina chiusa: la coda è già
// in localStorage (scritta sincrona a ogni cambiamento); se c'è un debounce in corso provo subito l'upload.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') retryPendingSync();
  else if (curUser) { persist(); savePendingQueue(); if (syncDebounce) retryPendingSync(true); }
});
window.addEventListener('pagehide', () => { if (curUser) { persist(); savePendingQueue(); } });

// ── INIT ──────────────────────────────────────────────────
