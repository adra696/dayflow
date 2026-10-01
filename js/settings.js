import { plural, showToast, settingsGroupHTML } from './utils.js';
import { S, sb, curUser, SETTINGS, APP_VERSION, focusMode, activeHabits } from './state.js';
import { pendingSync, habitsDirty, SYNC_INFO, hasUnsyncedChanges, noteSync, flushAllSync } from './sync.js';
import { FEED, escFeed, cloudOn, loadFeedTopics } from './discover-state.js';
import { ttsSupported, ttsEngine } from './discover-tts.js';
import { renderFeedSettings, renderTtsSettings } from './discover-settings.js';

// ── IMPOSTAZIONI (pannello globale) ───────────────────────
// Schermo pieno su mobile, sheet centrato da 768px. Struttura iOS: pagina radice (#settings-root) con un
// menu a gruppi; ogni riga apre una sotto-pagina (#settings-sub) che entra da destra. La pagina nascosta è
// inert + aria-hidden. Chiusura: X, tap fuori, Esc (Esc su una sotto-pagina = torna al menu).
// Focus: all'apertura sulla X (radice) o su "‹ Impostazioni" (sotto-pagina); tornando indietro sulla riga
// da cui si era partiti; alla chiusura sul trigger.
// Stato: SETTINGS.page = id della sotto-pagina visibile (null = menu), SETTINGS.rootScroll.
const SETTINGS_PAGES = {
  account: { title: 'Account', icon: '👤' },
  abitudini: { title: 'Abitudini e impegni', icon: '✅' },
  oggi: { title: 'Oggi', icon: '☀️' },
  discover: { title: 'Discover', icon: '📰' },
  ascolta: { title: 'Ascolta', icon: '🔊' },
  dati: { title: 'Dati', icon: '💾' },
  info: { title: 'Info', icon: 'ℹ️' }
};
const SETTINGS_GROUPS = [['account', 'abitudini', 'oggi'], ['discover', 'ascolta'], ['dati', 'info']];
// id storici delle sezioni (prima del menu) → pagina
const SETTINGS_ALIAS = { impegni: 'abitudini', tts: 'ascolta' };
let settingsUid = null; // utente per cui sono state costruite le sotto-pagine (bozze come il profilo dei gusti)

const $id = id => document.getElementById(id);
function settingsPanelEl() { return $id('settings-panel'); }
function settingsPageId(section) {
  const id = section ? (SETTINGS_ALIAS[section] || section) : null;
  return id && SETTINGS_PAGES[id] ? id : null;
}

function openSettings(section) {
  const ov = settingsPanelEl(); if (!ov) return;
  if (!SETTINGS.open) SETTINGS.trigger = document.activeElement;
  SETTINGS.open = true;
  ov.classList.add('open');
  ensureSettingsPages();
  renderSettingsRoot();
  const page = settingsPageId(section);
  if (page) { SETTINGS.rootScroll = 0; showSettingsPage(page, false); return; }
  SETTINGS.page = null;
  settingsSetSub(false, false);
  const body = $id('settings-body'); if (body) body.scrollTop = 0;
  const x = ov.querySelector('#settings-root .modal-close');
  if (x) x.focus({ preventScroll: true });
}
// restoreFocus=false quando subito dopo si apre un altro pannello (modal abitudini, argomenti…)
function closeSettings(restoreFocus = true) {
  if (!SETTINGS.open) return;
  SETTINGS.open = false;
  SETTINGS.page = null;
  settingsPanelEl().classList.remove('open');
  settingsSetSub(false, false);
  const t = SETTINGS.trigger; SETTINGS.trigger = null;
  if (restoreFocus && t && typeof t.focus === 'function' && document.contains(t)) t.focus({ preventScroll: true });
}
function settingsOverlayClick(e) { if (e.target === settingsPanelEl()) closeSettings(); }
function settingsGo(fn) { closeSettings(false); fn(); }

// Una riga del menu → sotto-pagina (con animazione)
function settingsOpenPage(id) {
  id = settingsPageId(id);
  if (!id || !SETTINGS.open) return;
  const body = $id('settings-body');
  if (!SETTINGS.page) SETTINGS.rootScroll = body ? body.scrollTop : 0;
  showSettingsPage(id, true);
}
function showSettingsPage(id, anim) {
  SETTINGS.page = id;
  const t = $id('settings-sub-title'); if (t) t.textContent = SETTINGS_PAGES[id].title;
  document.querySelectorAll('#settings-pg-wrap > .settings-pg').forEach(el => { el.hidden = el.id !== 'settings-pg-' + id; });
  renderSettingsPage(id);
  const sb2 = $id('settings-sub-body'); if (sb2) sb2.scrollTop = 0;
  settingsSetSub(true, anim);
  const back = $id('settings-back'); if (back) back.focus({ preventScroll: true });
}
// "‹ Impostazioni", Esc, swipe dal bordo sinistro: torna al menu, sulla riga di partenza
function settingsBack() {
  if (!SETTINGS.open || !SETTINGS.page) return;
  const from = SETTINGS.page;
  SETTINGS.page = null;
  renderSettingsRoot(); // valori a destra delle righe (focus, motore voce…) aggiornati
  settingsSetSub(false, true);
  const body = $id('settings-body');
  if (body) body.scrollTop = SETTINGS.rootScroll || 0;
  const row = document.querySelector(`#settings-root-list [data-page="${from}"]`);
  if (row) row.focus({ preventScroll: true });
}
// Mostra la sotto-pagina (sub=true) o il menu; la pagina nascosta diventa inert + aria-hidden
function settingsSetSub(sub, anim) {
  const pages = $id('settings-pages'), root = $id('settings-root'), subEl = $id('settings-sub');
  if (!pages || !root || !subEl) return;
  if (!anim) pages.classList.add('no-anim');
  pages.classList.toggle('sub-open', sub);
  root.toggleAttribute('inert', sub);
  subEl.toggleAttribute('inert', !sub);
  if (sub) { root.setAttribute('aria-hidden', 'true'); subEl.removeAttribute('aria-hidden'); }
  else { subEl.setAttribute('aria-hidden', 'true'); root.removeAttribute('aria-hidden'); }
  if (!anim) { void pages.offsetWidth; pages.classList.remove('no-anim'); }
}

// Contenitori delle sotto-pagine: costruiti una volta (per utente), così una bozza (profilo dei gusti)
// sopravvive a chiusura/riapertura come prima; ricostruiti se cambia l'utente.
function ensureSettingsPages() {
  const wrap = $id('settings-pg-wrap'); if (!wrap) return;
  const uid = curUser ? curUser.id : null;
  if (wrap.childElementCount && settingsUid === uid) return;
  settingsUid = uid;
  wrap.innerHTML = Object.keys(SETTINGS_PAGES).map(id => `<div class="settings-pg" id="settings-pg-${id}" hidden>${id === 'discover' ? '<div id="settings-discover-body"></div>'
    : id === 'ascolta' ? '<div id="settings-tts-body"></div>' : ''}</div>`).join('');
  settingsInitEdgeSwipe();
}
// Swipe dal bordo sinistro della sotto-pagina (touch) = indietro. Niente trascinamento animato:
// basta un gesto orizzontale deciso che parte entro 24px dal bordo.
function settingsInitEdgeSwipe() {
  const subEl = $id('settings-sub');
  if (!subEl || subEl.dataset.swipe) return;
  subEl.dataset.swipe = '1';
  let st = null;
  subEl.addEventListener('touchstart', e => {
    st = null;
    if (e.touches.length !== 1 || !SETTINGS.page) return;
    const x = e.touches[0].clientX - subEl.getBoundingClientRect().left;
    if (x <= 24) st = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
  }, { passive: true });
  subEl.addEventListener('touchend', e => {
    if (!st) return;
    const p = e.changedTouches[0];
    const dx = p.clientX - st.x, dy = Math.abs(p.clientY - st.y);
    st = null;
    if (dx > 70 && dy < dx * 0.6) settingsBack();
  }, { passive: true });
  subEl.addEventListener('touchcancel', () => { st = null; }, { passive: true });
}

// ── Menu (pagina radice) ──
function settingsRootVal(id) {
  if (id === 'account') return settingsSyncShort();
  if (id === 'abitudini') {
    const nHab = activeHabits().length;
    const nImp = settingsImpCount();
    return `<span aria-hidden="true">${nHab} · ${nImp}</span><span class="settings-sr">${plural(nHab, 'abitudine', 'abitudini')}, ${plural(nImp, 'impegno', 'impegni')}</span>`;
  }
  if (id === 'oggi') return focusMode ? 'Focus attivo' : 'Focus spento';
  if (id === 'discover') {
    if (!FEED.topics.length) loadFeedTopics(); // come renderDiscover(): solo lettura di localStorage/default
    return plural(FEED.topics.length, 'argomento', 'argomenti');
  }
  if (id === 'ascolta') return ttsEngine() === 'cloud' && cloudOn() ? 'Google Cloud' : ttsSupported() ? 'Dispositivo' : 'Non disponibile';
  if (id === 'info') return escFeed(APP_VERSION);
  return '';
}
function settingsImpCount() { return (S.impegniRicorrenti || []).filter(r => r.attivo !== false).length; }
function renderSettingsRoot() {
  const list = $id('settings-root-list'); if (!list) return;
  const email = curUser && curUser.email ? curUser.email : '';
  const row = id => {
    const p = SETTINGS_PAGES[id];
    const sub = id === 'account' && email ? `<span class="settings-nav-sub">${escFeed(email)}</span>` : '';
    return `<button class="settings-nav" type="button" data-page="${id}" onclick="settingsOpenPage('${id}')">
        <span class="settings-nav-ico" aria-hidden="true">${p.icon}</span>
        <span class="settings-nav-lbl"><span class="settings-nav-name">${escFeed(p.title)}</span>${sub}</span>
        <span class="settings-nav-val"${id === 'account' ? ' id="settings-root-sync"' : ''}>${settingsRootVal(id)}</span>
        <span class="settings-nav-chev" aria-hidden="true">›</span>
      </button>`;
  };
  list.innerHTML = SETTINGS_GROUPS.map(g => `<div class="settings-card">${g.map(row).join('')}</div>`).join('')
    + `<div class="settings-card"><button class="settings-nav danger" type="button" onclick="requestLogout()">Esci</button></div>`;
}

// ── Sotto-pagine ──
function renderSettingsPage(id) {
  if (id === 'discover') { renderFeedSettings($id('settings-discover-body')); return; }
  if (id === 'ascolta') { renderTtsSettings($id('settings-tts-body')); return; }
  const el = $id('settings-pg-' + id); if (!el) return;
  if (id === 'account') {
    const email = curUser && curUser.email ? curUser.email : '—';
    el.innerHTML = settingsGroupHTML('', `
      <div class="settings-row">
        <div class="settings-lbl">Email</div>
        <div class="settings-val">${escFeed(email)}</div>
      </div>`)
      + settingsGroupHTML('Sincronizzazione', `
      <div class="settings-row">
        <div class="settings-val" id="settings-sync" role="status"></div>
        <div class="form-btns" style="margin-top:0"><button class="btn-sec" id="settings-sync-btn" onclick="settingsSyncNow()">Sincronizza ora</button></div>
      </div>`, 'Ogni modifica si salva subito su questo dispositivo e va nel cloud da sola. "Sincronizza ora" invia subito quello che è in coda.')
      + settingsGroupHTML('', `<button class="settings-nav danger" type="button" onclick="requestLogout()">Esci</button>`,
        'Prima di uscire DayFlow prova a sincronizzare le modifiche in sospeso.');
    renderSettingsSync();
  } else if (id === 'abitudini') {
    const hab = activeHabits();
    const nWeekly = hab.filter(h => h.frequenza === 'settimanale').length;
    const nDaily = hab.length - nWeekly;
    const nImp = settingsImpCount();
    el.innerHTML = settingsGroupHTML('Abitudini', `
      <div class="settings-row">
        <div class="settings-val">${hab.length ? `Attive: ${plural(nDaily, 'giornaliera', 'giornaliere')} · ${plural(nWeekly, 'settimanale', 'settimanali')}` : 'Nessuna abitudine attiva'}</div>
        <div class="form-btns" style="margin-top:0"><button class="btn-sec" onclick="settingsGo(openModal)">Gestisci abitudini</button></div>
      </div>`)
      + settingsGroupHTML('Impegni ricorrenti', `
      <div class="settings-row">
        <div class="settings-val">${nImp ? plural(nImp, 'impegno attivo', 'impegni attivi') : 'Nessun impegno ricorrente'}</div>
        <div class="form-btns" style="margin-top:0"><button class="btn-sec" onclick="settingsGo(openImpegniModal)">Gestisci impegni</button></div>
      </div>`, 'Gli impegni ricorrenti compaiono in Pianifica e Oggi nei giorni della settimana scelti.');
  } else if (id === 'oggi') {
    el.innerHTML = settingsGroupHTML('Schermata Oggi', `
      <div class="settings-row">
        <div class="settings-inline">
          <span class="settings-inline-txt" id="set-focus-lbl">Mostra solo le abitudini da fare</span>
          <button class="set-switch" id="set-focus" type="button" role="switch" aria-checked="${focusMode}" aria-labelledby="set-focus-lbl" onclick="toggleFocusMode()"></button>
        </div>
      </div>`, 'Nasconde le voci già completate nella schermata Oggi (come il bottone "focus").');
  } else if (id === 'dati') {
    el.innerHTML = settingsGroupHTML('Backup', `
      <div class="settings-row">
        <div class="settings-val">Scarica un file JSON con abitudini, giornate, eventi e impegni.</div>
        <div class="form-btns" style="margin-top:0"><button class="btn-sec" onclick="exportBackup()">Esporta backup</button></div>
      </div>`);
  } else if (id === 'info') {
    el.innerHTML = settingsGroupHTML('Versione', `
      <div class="settings-row">
        <div class="settings-val">DayFlow ${escFeed(APP_VERSION)}</div>
        <div class="feed-hint" id="settings-version-note"></div>
      </div>`);
    renderVersionNote();
  }
}
// Il service worker scarica la versione nuova mentre gira quella vecchia (cache dayflow-vNN):
// se c'è una cache più recente del codice in esecuzione, basta chiudere e riaprire l'app.
async function renderVersionNote() {
  const el = $id('settings-version-note');
  if (!el) return;
  const cur = parseInt(APP_VERSION.replace(/\D/g, ''), 10);
  let newest = 0;
  try {
    if (typeof caches !== 'undefined') (await caches.keys()).forEach(k => { const m = /^dayflow-v(\d+)$/.exec(k); if (m) newest = Math.max(newest, +m[1]); });
  } catch (e) { }
  el.textContent = newest > cur ? `Versione v${newest} già scaricata: chiudi e riapri l'app per usarla.` : 'Versione aggiornata.';
}
function settingsSyncState() {
  const pend = pendingSync.size + (habitsDirty ? 1 : 0);
  return { pend, st: SYNC_INFO.status === 'ok' && pend ? 'syncing' : SYNC_INFO.status };
}
function settingsSyncShort() {
  const { pend, st } = settingsSyncState();
  const txt = pend ? `${pend} in coda` : st === 'ok' ? 'Sincronizzato' : st === 'syncing' ? 'In corso…' : st === 'err' ? 'Errore' : 'Non sincronizzato';
  return `<span class="sync-dot ${st}" aria-hidden="true"></span>${txt}`;
}
// Esito dell'ultima sincronizzazione: pagina Account (se costruita) + valore della riga Account nel menu
function renderSettingsSync() {
  if (!SETTINGS.open) return;
  const root = $id('settings-root-sync');
  if (root) root.innerHTML = settingsSyncShort();
  const el = $id('settings-sync'); if (!el) return;
  const { pend, st } = settingsSyncState();
  el.innerHTML = `<span class="sync-dot ${st}" aria-hidden="true"></span>${escFeed(SYNC_INFO.msg)}${pend ? ` · ${pend} in coda` : ''}`;
}
async function settingsSyncNow() {
  const btnSet = (dis, txt) => { const b = $id('settings-sync-btn'); if (b) { b.disabled = dis; b.textContent = txt; } };
  btnSet(true, 'Sincronizzazione…');
  const had = hasUnsyncedChanges();
  noteSync('syncing');
  let ok = await flushAllSync();
  // Nulla in coda: verifico comunque che Supabase risponda, per non mostrare un "ok" falso da offline
  if (ok && !had && curUser && sb) {
    ok = await Promise.race([
      sb.from('profiles').select('id').eq('id', curUser.id).maybeSingle().then(r => !r.error, () => false),
      new Promise(res => setTimeout(() => res(false), 8000))
    ]);
  }
  noteSync(ok ? 'ok' : 'err');
  showToast(ok ? (had ? 'Modifiche sincronizzate' : 'Tutto sincronizzato') : 'Sincronizzazione non riuscita: le modifiche restano in locale', ok ? 'info' : 'error');
  btnSet(false, 'Sincronizza ora');
}

export { openSettings, closeSettings, settingsOverlayClick, settingsGo, settingsOpenPage, settingsBack, renderSettingsSync, settingsSyncNow };
