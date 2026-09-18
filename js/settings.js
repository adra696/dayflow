import { plural, showToast } from './utils.js';
import { S, sb, curUser, SETTINGS, APP_VERSION, focusMode, activeHabits } from './state.js';
import { pendingSync, habitsDirty, SYNC_INFO, hasUnsyncedChanges, noteSync, flushAllSync } from './sync.js';
import { escFeed, renderFeedSettings } from './discover.js';

// ── IMPOSTAZIONI (pannello globale) ───────────────────────
// Schermo pieno su mobile, sheet centrato da 768px. Chiusura: X, tap fuori, Esc.
// Focus sul primo controllo all'apertura, ritorno al trigger alla chiusura.
function settingsPanelEl() { return document.getElementById('settings-panel'); }
function openSettings(section) {
  const ov = settingsPanelEl(); if (!ov) return;
  if (!SETTINGS.open) SETTINGS.trigger = document.activeElement;
  SETTINGS.open = true;
  ov.classList.add('open');
  renderSettings();
  const body = document.getElementById('settings-body');
  const sec = section ? document.getElementById('settings-sec-' + section) : null;
  if (body) body.scrollTop = sec ? Math.max(0, sec.offsetTop - 8) : 0;
  const first = ov.querySelector('.modal-close');
  if (first) first.focus({ preventScroll: true });
}
// restoreFocus=false quando subito dopo si apre un altro pannello (modal abitudini, argomenti…)
function closeSettings(restoreFocus = true) {
  if (!SETTINGS.open) return;
  SETTINGS.open = false;
  settingsPanelEl().classList.remove('open');
  const t = SETTINGS.trigger; SETTINGS.trigger = null;
  if (restoreFocus && t && typeof t.focus === 'function' && document.contains(t)) t.focus({ preventScroll: true });
}
function settingsOverlayClick(e) { if (e.target === settingsPanelEl()) closeSettings(); }
function settingsGo(fn) { closeSettings(false); fn(); }

function renderSettings() {
  const b = document.getElementById('settings-body'); if (!b) return;
  const hab = activeHabits();
  const nWeekly = hab.filter(h => h.frequenza === 'settimanale').length;
  const nDaily = hab.length - nWeekly;
  const nImp = (S.impegniRicorrenti || []).filter(r => r.attivo !== false).length;
  const email = curUser && curUser.email ? curUser.email : '—';
  b.innerHTML = `
    <section class="settings-sec" id="settings-sec-account" aria-labelledby="st-h-account">
      <h2 class="settings-sec-title" id="st-h-account">Account</h2>
      <div class="settings-row">
        <div class="settings-lbl">Email</div>
        <div class="settings-val">${escFeed(email)}</div>
      </div>
      <div class="settings-row">
        <div class="settings-lbl">Sincronizzazione</div>
        <div class="settings-val" id="settings-sync" role="status"></div>
        <div class="form-btns" style="margin-top:0">
          <button class="btn-sec" id="settings-sync-btn" onclick="settingsSyncNow()">Sincronizza ora</button>
          <button class="btn-del" onclick="requestLogout()">Esci</button>
        </div>
      </div>
    </section>
    <section class="settings-sec" id="settings-sec-abitudini" aria-labelledby="st-h-abitudini">
      <h2 class="settings-sec-title" id="st-h-abitudini">Abitudini</h2>
      <div class="settings-row">
        <div class="settings-val">${hab.length ? `Attive: ${plural(nDaily, 'giornaliera', 'giornaliere')} · ${plural(nWeekly, 'settimanale', 'settimanali')}` : 'Nessuna abitudine attiva'}</div>
        <div class="form-btns" style="margin-top:0"><button class="btn-sec" onclick="settingsGo(openModal)">Gestisci abitudini</button></div>
      </div>
    </section>
    <section class="settings-sec" id="settings-sec-impegni" aria-labelledby="st-h-impegni">
      <h2 class="settings-sec-title" id="st-h-impegni">Impegni ricorrenti</h2>
      <div class="settings-row">
        <div class="settings-val">${nImp ? plural(nImp, 'impegno attivo', 'impegni attivi') : 'Nessun impegno ricorrente'}</div>
        <div class="form-btns" style="margin-top:0"><button class="btn-sec" onclick="settingsGo(openImpegniModal)">Gestisci impegni</button></div>
      </div>
    </section>
    <section class="settings-sec" id="settings-sec-oggi" aria-labelledby="st-h-oggi">
      <h2 class="settings-sec-title" id="st-h-oggi">Oggi</h2>
      <div class="settings-row">
        <div class="settings-inline">
          <span class="settings-inline-txt" id="set-focus-lbl">Mostra solo le abitudini da fare</span>
          <button class="set-switch" id="set-focus" type="button" role="switch" aria-checked="${focusMode}" aria-labelledby="set-focus-lbl" onclick="toggleFocusMode()"></button>
        </div>
        <div class="feed-hint" style="margin-top:6px">Nasconde le voci già completate nella schermata Oggi (come il bottone "focus").</div>
      </div>
    </section>
    <section class="settings-sec" id="settings-sec-discover" aria-labelledby="st-h-discover">
      <h2 class="settings-sec-title" id="st-h-discover">Discover</h2>
      <div id="settings-discover-body"></div>
    </section>
    <section class="settings-sec" id="settings-sec-dati" aria-labelledby="st-h-dati">
      <h2 class="settings-sec-title" id="st-h-dati">Dati</h2>
      <div class="settings-row">
        <div class="settings-val">Scarica un file JSON con abitudini, giornate, eventi e impegni.</div>
        <div class="form-btns" style="margin-top:0"><button class="btn-sec" onclick="exportBackup()">Esporta backup</button></div>
      </div>
    </section>
    <section class="settings-sec" id="settings-sec-info" aria-labelledby="st-h-info">
      <h2 class="settings-sec-title" id="st-h-info">Info</h2>
      <div class="settings-row">
        <div class="settings-val">DayFlow ${escFeed(APP_VERSION)}</div>
      </div>
    </section>`;
  renderFeedSettings(document.getElementById('settings-discover-body'));
  renderSettingsSync();
}
function renderSettingsSync() {
  if (!SETTINGS.open) return;
  const el = document.getElementById('settings-sync'); if (!el) return;
  const pend = pendingSync.size + (habitsDirty ? 1 : 0);
  const st = SYNC_INFO.status === 'ok' && pend ? 'syncing' : SYNC_INFO.status;
  el.innerHTML = `<span class="sync-dot ${st}" aria-hidden="true"></span>${escFeed(SYNC_INFO.msg)}${pend ? ` · ${pend} in coda` : ''}`;
}
async function settingsSyncNow() {
  const btnSet = (dis, txt) => { const b = document.getElementById('settings-sync-btn'); if (b) { b.disabled = dis; b.textContent = txt; } };
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

export { openSettings, closeSettings, settingsOverlayClick, settingsGo, renderSettingsSync, settingsSyncNow };
