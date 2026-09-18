import { todayStr, offsetDate, setSS, withTimeout } from './utils.js';
import {
  S, sb, SK, curUser, curScreen, selectedDate, isProgrammaticScroll, SETTINGS, DLG,
  setCurUser, setCurScreen, setSelectedDateOnly, setIsProgrammaticScroll, setStateHooks,
  load, persist, setSelectedDate, toggleFocusMode, toggleSidebar, exportBackup
} from './state.js';
import {
  PENDING_LS, RETRY, dayInflight, eventiColumnOk, bumpSyncEpoch, setHabitsInflight, setSyncHooks,
  adoptRemoteDay, flushAllSync, noteSync, restorePendingQueue, retryPendingSync, loadWindowForDate,
  sbLoadAllDaysInBackground, sbLoadDaysRange, sbLoadFeedTopics, sbLoadHabits
} from './sync.js';
import { setAuthHooks, switchTab, doLogin, doSignup, doLogout, doResetPwd } from './auth.js';
import { renderPlan, openModal, closeModal, overlayClick, openImpegniModal } from './plan.js';
import { renderOggi, renderHOggiList, updateOggiStats } from './oggi.js';
import { CAL, ensureEventi, renderCalendario, renderCalStrip, renderCalDay, calShiftWeek, calGoToday, openEventoModal } from './calendario.js';
import {
  FEED, FEED_TOPICS_LS, setDiscoverHooks, normalizeTopic, renderDiscover,
  addFeedTopic, clearFeedCache, clearFeedPrefs, clearFeedSeen, closeFeedSheet, expandArticle, feedSheetOverlayClick, fetchGeminiModels,
  generateFeed, loadMoreFeed, openFeedChat, openFeedSheet, regenerateFeed, removeFeedKey, removeFeedTopic, saveFeedKey, sendFeedChat,
  setFeedModel, setFeedModelFromInput, setFeedTopic, shareFeedCard, switchFeedSheet, toggleFeedKeyVis, toggleFeedSaved
} from './discover.js';
import { openSettings, closeSettings, settingsOverlayClick, settingsGo, renderSettingsSync, settingsSyncNow } from './settings.js';

// ── HOOK (dipendenze verso l'alto) ─────────────────────────
// state.js, sync.js, auth.js e discover.js chiamano funzioni di moduli che non possono importare
// (ciclo). Le registriamo qui, prima di qualunque bootstrap: i moduli sono già tutti valutati.
setStateHooks({ ensureEventi, loadWindowForDate, renderPlan, renderOggi, renderDiscover, renderHOggiList });
setSyncHooks({ FEED, FEED_TOPICS_LS, ensureEventi, normalizeTopic, renderCalDay, renderCalStrip, renderCalendario, renderDiscover, renderHOggiList, renderOggi, renderPlan, renderSettingsSync, updateOggiStats });
setAuthHooks({ initApp, closeAppDialog });
setDiscoverHooks({ openSettings });

async function initApp(user) {
  if (curUser && curUser.id === user.id) return;
  setCurUser(user);
  load();
  // Coda di sync della sessione precedente: ripristinata PRIMA di qualunque load remoto
  // (renderOggi/sbLoadHabits/finestra iniziale), così adoptRemoteDay e sbLoadHabits la rispettano.
  restorePendingQueue();
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('shell').style.display = 'flex';
  if (window.innerWidth >= 768) {
    const saved = localStorage.getItem('sidebarExpanded');
    if (saved === 'true') document.getElementById('nav').classList.add('expanded');
  }
  goScreen('oggi', true, false);
  setSS('sd-oggi', 'st-oggi-sync', 'syncing', 'sincronizzazione...');
  await withTimeout(sbLoadHabits(), 8000);
  
  // Carica solo la finestra temporale iniziale di 9 giorni [selectedDate-4, selectedDate+4]
  const startD = offsetDate(selectedDate, -4);
  const endD = offsetDate(selectedDate, 4);
  const windowDays = await withTimeout(sbLoadDaysRange(startD, endD), 8000);
  if (windowDays) {
    for (const [ds, remote] of Object.entries(windowDays)) adoptRemoteDay(ds, remote);
    persist();
  }
  if (curScreen === 'oggi') renderOggi();
  else if (curScreen === 'plan') renderPlan();
  else if (curScreen === 'recap') renderDiscover();
  else if (curScreen === 'calendario') renderCalendario();

  setSS('sd-oggi', 'st-oggi-sync', windowDays ? 'ok' : 'err', windowDays ? 'sincronizzato' : 'locale — nessuna rete');
  noteSync(windowDays ? 'ok' : 'err', windowDays ? undefined : 'dati locali — nessuna rete');

  // Upload della coda ripristinata (non bloccante; i giorni ripristinati vengono prima riconciliati col remoto)
  retryPendingSync(true);
  // Carica il resto dei dati storici in background per Streak e Calendario
  sbLoadAllDaysInBackground();
  // Argomenti Discover dal profilo (non bloccante, fallback localStorage)
  sbLoadFeedTopics();
}

// ── AUTH LISTENER ─────────────────────────────────────────
sb.auth.onAuthStateChange(async (event, session) => {
  if (session && session.user) {
    if (!curUser || curUser.id !== session.user.id) {
      await initApp(session.user);
    }
  } else if (event === 'SIGNED_OUT') {
    setCurUser(null);
    document.getElementById('shell').style.display = 'none';
    document.getElementById('auth-screen').classList.remove('hidden');
  }
});

// Controlla sessione esistente al caricamento (evita login ogni volta)
(async () => {
  load();
  try {
    const { data: { session }, error } = await sb.auth.getSession();
    if (error) {
      // Sessione corrotta: pulisci e mostra login
      bumpSyncEpoch(); dayInflight.clear(); setHabitsInflight(null); RETRY.running = false;
      await sb.auth.signOut();
      localStorage.removeItem(SK);
      localStorage.removeItem(PENDING_LS);
      return;
    }
    if (session && session.user) {
      await initApp(session.user);
    }
  } catch (e) {
    console.error('getSession error', e);
  }
})();

// ── NAVIGATION ────────────────────────────────────────────
function goScreen(name, keepDate = true, smooth = true) {
  const screenArea = document.getElementById('screen-area');

  setCurScreen(name);
  if (!keepDate) setSelectedDateOnly(todayStr());

  const screens = ['plan', 'oggi', 'recap', 'calendario'];
  const index = screens.indexOf(name);

  const doScroll = () => {
    if (screenArea && index !== -1) {
      const width = screenArea.clientWidth;
      if (width > 0) {
        const targetLeft = index * width;
        if (Math.abs(screenArea.scrollLeft - targetLeft) > 5) {
          setIsProgrammaticScroll(true);
          screenArea.scrollTo({
            left: targetLeft,
            behavior: smooth ? 'smooth' : 'instant'
          });
          setTimeout(() => { setIsProgrammaticScroll(false); }, smooth ? 350 : 50);
        }
      } else {
        requestAnimationFrame(doScroll);
      }
    }
  };

  doScroll();

  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + name));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.id === 'nav-' + name));

  if (name === 'plan') renderPlan();
  if (name === 'oggi') renderOggi();
  if (name === 'recap') renderDiscover();
  if (name === 'calendario') renderCalendario();
}

// ── DIALOG DI CONFERMA ────────────────────────────────────
// openAppDialog() → Promise<boolean>. Con keepOpen il dialog resta aperto dopo "OK"
// (il chiamante mostra lo stato busy e poi chiama closeAppDialog()).
function openAppDialog({ title, msg, warn = '', okLabel = 'OK', cancelLabel = 'Annulla', keepOpen = false }) {
  if (DLG.open) closeAppDialog(false);
  document.getElementById('app-dlg-title').textContent = title || '';
  document.getElementById('app-dlg-msg').textContent = msg || '';
  const w = document.getElementById('app-dlg-warn'); w.textContent = warn; w.hidden = !warn;
  const ok = document.getElementById('app-dlg-ok'), cancel = document.getElementById('app-dlg-cancel');
  ok.textContent = okLabel; cancel.textContent = cancelLabel;
  ok.disabled = false; cancel.disabled = false;
  DLG.trigger = document.activeElement; DLG.open = true; DLG.busy = false; DLG.keepOpen = keepOpen;
  document.getElementById('app-dlg').classList.add('open');
  cancel.focus({ preventScroll: true }); // azione sicura come default
  return new Promise(res => { DLG.resolve = res; });
}
function confirmAppDialog() {
  if (!DLG.open || DLG.busy) return;
  const res = DLG.resolve; DLG.resolve = null;
  if (!DLG.keepOpen) closeAppDialog();
  if (res) res(true);
}
function closeAppDialog(result = false) {
  if (!DLG.open) return;
  DLG.open = false; DLG.busy = false;
  document.getElementById('app-dlg').classList.remove('open');
  const res = DLG.resolve; DLG.resolve = null;
  if (res) res(result);
  const t = DLG.trigger; DLG.trigger = null;
  if (t && typeof t.focus === 'function' && document.contains(t)) t.focus({ preventScroll: true });
}
function setAppDialogBusy(label) {
  DLG.busy = true;
  const ok = document.getElementById('app-dlg-ok'), cancel = document.getElementById('app-dlg-cancel');
  ok.textContent = label; ok.disabled = true; cancel.disabled = true;
}
function appDialogOverlayClick(e) { if (e.target === document.getElementById('app-dlg') && !DLG.busy) closeAppDialog(false); }

// ── LOGOUT SICURO ─────────────────────────────────────────
// Conferma → flush di tutte le sync in coda → signOut. Se il flush fallisce non si esce in silenzio.
async function requestLogout() {
  if (DLG.open) return;
  const localEv = eventiColumnOk === false && Object.values(S.days).some(d => d && Array.isArray(d.eventi) && d.eventi.length);
  const evWarn = localEv ? 'Gli eventi del calendario sono salvati solo su questo dispositivo e verranno cancellati uscendo.' : '';
  const go = await openAppDialog({
    title: 'Uscire da DayFlow?',
    msg: 'Le modifiche in sospeso vengono sincronizzate, poi i dati di questo dispositivo vengono rimossi. Potrai ritrovarli accedendo di nuovo.',
    warn: evWarn, okLabel: 'Esci', keepOpen: true
  });
  if (!go) return;
  setAppDialogBusy('Sincronizzazione…');
  const flushed = await flushAllSync();
  if (!DLG.open) return; // chiuso nel frattempo (logout da altra via)
  if (!flushed) {
    noteSync('err');
    closeAppDialog(false);
    const force = await openAppDialog({
      title: 'Modifiche non sincronizzate',
      msg: 'Alcune modifiche non sono ancora sincronizzate. Uscendo le perderai.',
      warn: evWarn, okLabel: 'Esci comunque'
    });
    if (!force) return;
  }
  await doLogout();
}

// Tastiera: Esc chiude dialog / impostazioni; Tab resta dentro il pannello modale aperto
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (DLG.open) { if (!DLG.busy) { e.preventDefault(); closeAppDialog(false); } return; }
    if (SETTINGS.open) { e.preventDefault(); closeSettings(); }
    return;
  }
  if (e.key !== 'Tab') return;
  const root = DLG.open ? document.querySelector('#app-dlg .app-dlg') : SETTINGS.open ? document.querySelector('#settings-panel .settings-sheet') : null;
  if (!root) return;
  const f = [...root.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(el => el.offsetParent !== null);
  if (!f.length) { e.preventDefault(); return; }
  const first = f[0], last = f[f.length - 1];
  if (!root.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

// ── SWIPE & CAROUSEL NAVIGATION ────────────────────────────
(function initSwipeNavigation() {
  const screenArea = document.getElementById('screen-area');
  if (!screenArea) return;

  const screens = ['plan', 'oggi', 'recap', 'calendario'];
  let isScrollingTimer = null;

  screenArea.addEventListener('scroll', () => {
    if (isProgrammaticScroll) return;
    const width = screenArea.clientWidth;
    if (!width) return;

    const index = Math.round(screenArea.scrollLeft / width);
    const activeName = screens[index];

    if (activeName && activeName !== curScreen) {
      setCurScreen(activeName);
      document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + activeName));
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.id === 'nav-' + activeName));

      clearTimeout(isScrollingTimer);
      isScrollingTimer = setTimeout(() => {
        if (activeName === 'plan') renderPlan();
        else if (activeName === 'oggi') renderOggi();
        else if (activeName === 'recap') renderDiscover();
        else if (activeName === 'calendario') renderCalendario();
      }, 60);
    }
  }, { passive: true });

  window.addEventListener('resize', () => {
    const targetScreen = document.getElementById('screen-' + curScreen);
    if (targetScreen && screenArea) {
      screenArea.scrollTo({ left: targetScreen.offsetLeft, behavior: 'instant' });
    }
  });
})();

// ── SERVICE WORKER (solo HTTPS) ────────────────────────────
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// Ponte per gli handler inline (onclick="..." in index.html e nei template HTML dei moduli): resta finché esistono
Object.assign(window, {
  addFeedTopic,           // discover.js
  appDialogOverlayClick,  // app.js
  CAL,                    // calendario.js (FAB: openEventoModal(CAL.date))
  calGoToday,             // calendario.js
  calShiftWeek,           // calendario.js
  clearFeedCache,         // discover.js
  clearFeedPrefs,         // discover.js
  clearFeedSeen,          // discover.js
  closeAppDialog,         // app.js
  closeFeedSheet,         // discover.js
  closeModal,             // plan.js
  closeSettings,          // settings.js
  confirmAppDialog,       // app.js
  doLogin,                // auth.js
  doResetPwd,             // auth.js
  doSignup,               // auth.js
  expandArticle,          // discover.js
  exportBackup,           // state.js
  feedSheetOverlayClick,  // discover.js
  fetchGeminiModels,      // discover.js
  generateFeed,           // discover.js
  goScreen,               // app.js
  loadMoreFeed,           // discover.js
  offsetDate,             // utils.js (frecce data: setSelectedDate(offsetDate(...)))
  openEventoModal,        // calendario.js
  openFeedChat,           // discover.js
  openFeedSheet,          // discover.js
  openImpegniModal,       // plan.js
  openModal,              // plan.js
  openSettings,           // settings.js
  overlayClick,           // plan.js
  regenerateFeed,         // discover.js
  removeFeedKey,          // discover.js
  removeFeedTopic,        // discover.js
  requestLogout,          // app.js
  saveFeedKey,            // discover.js
  sendFeedChat,           // discover.js
  setFeedModel,           // discover.js
  setFeedModelFromInput,  // discover.js
  setFeedTopic,           // discover.js
  setSelectedDate,        // state.js
  settingsGo,             // settings.js
  settingsOverlayClick,   // settings.js
  settingsSyncNow,        // settings.js
  shareFeedCard,          // discover.js
  switchFeedSheet,        // discover.js
  switchTab,              // auth.js
  toggleFeedKeyVis,       // discover.js
  toggleFeedSaved,        // discover.js
  toggleFocusMode,        // state.js
  toggleSidebar,          // state.js
});
