# Handoff: DayFlow — Split Meccanico Completato (Passi 0 e 1)

**Data**: 18 Settembre 2026  
**Stato**: Passi 0 e 1 completati con successo. Tutti i file creati, verificati e pronti.

---

## 1. Cosa è stato fatto

### Passo 0 — Service Worker (`sw.js`)
- Bump della cache da `dayflow-v18` a `dayflow-v19`.
- Aggiornata la lista `STATIC` per includere tutti i file post-split (HTML, 3 file CSS, 10 file JS, manifest, icone).
- Passaggio della strategia degli asset applicativi da network-first a **cache-first versionata** (aggiornamento atomico al bump della cache).
- Mantenute rigorosamente intatte le regole di esclusione:
  - Supabase e Gemini: sempre network (le POST non finiscono mai nella Cache API).
  - Google Fonts e CDN (jsdelivr): stale-while-revalidate.

### Passo 1 — Split del file unico (`dayflow1_0.html` → CSS + JS + index.html)
- **`index.html`**: Nuova pagina principale snella con `<head>` pulito (meta, manifest, font, CDN supabase senza defer, 3 `<link>` CSS, 10 `<script defer>`) e il `<body>` identico al precedente con tutti gli 80 handler inline intatti.
- **`dayflow1_0.html`**: Convertito in meta-refresh immediato verso `index.html` per garantire che la PWA installata su iPhone continui ad aprirsi senza interruzioni.
- **`manifest.json`**: `start_url` aggiornato a `./index.html`.

#### CSS (3 file sotto `css/`)
1. **`css/tokens.css`** (70 righe): Reset globale `*`, custom properties in `:root`, regole base `html`/`body`, fix font-size 16px per iOS Safari.
2. **`css/base.css`** (1811 righe): Form reset, schermata auth, shell, topbar, sync bar, progress ring/bar, focus mode, stats, righe abitudini, modali, toast, tap targets (≥44×44px), pannello impostazioni globale, app dialog di conferma, media queries responsive desktop (min-width: 768px).
3. **`css/screens.css`** (1460 righe): Schermate Pianifica, Oggi (tasks e habit list), Discover/Gemini (snap verticale, schede, skeleton, bottom sheet, streaming articoli, chat) e Calendario (header, strip settimanale con drag rAF, allday band, timeline 24h, editor evento).

#### JavaScript (10 script classici con `defer` sotto `js/`)
Caricati nell'esatto ordine di dipendenza:
1. **`js/utils.js`** (78 righe): `todayStr`, `offsetDate`, `fmtHeaderDate`, `renderDateNavHeader`, `p2`, `uid`, `pctColor`, `heatColor`, `fmtDate`, `fmtShort`, `weekDays`, `monthDays`, `setBar`, `setRing`, `setSS`, `shootConfetti`, `showToast`, `withTimeout`, `plural`.
2. **`js/state.js`** (190 righe): Costanti (`SUPA_URL`, `SUPA_KEY`, `SK`, `APP_VERSION`), client Supabase (`sb`), stato `S`, `curUser`, `curScreen`, `isProgrammaticScroll`, `selectedDate`, `mMode`, `editId`, `SETTINGS`, `DLG`, `allDaysLoaded`, `lastTopPct`, `focusMode`, `setSelectedDate`, `load`, `persist`, `getDay`, `ensureSlotArrays`, `atdDoneCount`, `activeHabits`, `isoDow`, `getImpegniDelGiorno`, `calcPct`, `updateTopProgressBar`, `calcAvg`, `toggleFocusMode`, `calcStreak`, `calcHabitStreak`, `toggleSidebar`, `exportBackup`.
3. **`js/sync.js`** (407 righe): Tutta la logica di sincronizzazione Supabase in blocco unico: code (`pendingSync`, `restoredPending`, `dirtyGen`, `habitsDirty`), locks (`habitsInflight`, `dayInflight`), session epoch, `adoptRemoteDay`, `sbSaveHabits`, `sbSaveHabitsOnce`, `sbLoadHabits`, `sbSaveDay`, `sbSaveDayOnce`, `sbLoadDay`, `sbLoadAllDays`, `sbLoadDaysRange`, `loadWindowForDate`, `sbLoadAllDaysInBackground`, `scheduleSync`, `syncPendingDays`, `savePendingQueue`, `restorePendingQueue`, `reconcileRestoredDay`, `dropPendingDay`, `refreshDayViews`, `retryPendingSync`, `hasUnsyncedChanges`, `flushAllSync`, `noteSync`, `sbSaveFeedTopics`, `sbLoadFeedTopics`, listener `visibilitychange`/`pagehide`.
4. **`js/auth.js`** (71 righe): `switchTab`, `doLogin`, `doSignup`, `doLogout`, `translateAuthError`, `doResetPwd`.
5. **`js/plan.js`** (266 righe): `renderPlan`, `renderTaskInputs`, `checkPriBanner`, `renderHPlanList`, `renderWeeklyHabits`, modali gestione abitudini (`openModal`, `closeModal`, `renderModal`, etc.) e impegni ricorrenti (`openImpegniModal`, `renderImpegniModal`, `submitImpegnoForm`, etc.).
6. **`js/oggi.js`** (141 righe): `renderOggi`, `setupRowGestures`, `renderHOggiList`, `updateOggiStats`, `addRipple`.
7. **`js/calendario.js`** (472 righe): Timeline oraria iOS-style, week strip con Pointer Events e rAF, `calBuildGrid`, `renderCalHeader`, `renderCalStrip`, `renderCalDay`, `calLayoutEventi`, `calSetDate`, `updateCalNow`, editor eventi (`openEventoModal`, `saveEvento`, `deleteEvento`), `normalizeEvento`, `ensureEventi`, `eventiDelGiorno`.
8. **`js/discover.js`** (1050 righe): Costanti e stato Gemini/FEED, `geminiRequest`, streaming con SSE (`geminiStream`, `streamArticle`, `paintArticleStream`), generazione feed, dedupe/seen, salvati, preferenze utente, chat con AI, selettore modello Gemini, impostazioni discover (`renderFeedSettings`, `refreshFeedSettings`, `feedSettingsHTML`).
9. **`js/settings.js`** (114 righe): `settingsPanelEl`, `openSettings`, `closeSettings`, `settingsOverlayClick`, `settingsGo`, `renderSettings`, `renderSettingsSync`, `settingsSyncNow`.
10. **`js/app.js`** (189 righe): `initApp`, `goScreen`, dialog di sistema (`openAppDialog`, `confirmAppDialog`, `closeAppDialog`, `setAppDialogBusy`), `requestLogout` sicuro, listener tastiera (Esc/Tab trap), registrazione service worker.

---

## 2. Verifiche Automatiche Eseguite

1. **Controllo sintattico**: `node --check` eseguito su tutti i 10 file JS: **0 errori**.
2. **Bilanciamento CSS**: Parentesi `{}` e `}` contate e verificate per tutti i 3 file CSS: **100% bilanciati**, nessun tag `<style>` residuo.
3. **Controllo duplicati funzioni**: Analisi AST di tutte le funzioni top-level: **esattamente 224 funzioni top-level uniche**, 0 duplicati (identico conteggio a prima dello split).
4. **Controllo variabili globali**: Analisi di tutte le variabili a livello radice: **esattamente 63 variabili globali uniche**, 0 collisioni o doppie dichiarazioni.
5. **Handler inline**: Verificati tutti gli handler presenti in `index.html` (`onclick`, `onkeydown`, etc.): ogni funzione invocata esiste nel rispettivo file JS.
6. **Server statico HTTP**: Avviato `npx serve . -l 3000` e testate tutte le 16 risorse (HTML, CSS, JS, manifest, sw.js): **tutte rispondono con HTTP 200 OK**.

---

## 3. Nota su Git (Da fare manualmente)

Durante la sessione è emerso che l'installazione locale di Git sul computer (`C:\Program Files\Git`) ha file corrotti sul filesystem NTFS (`La directory o il file è danneggiato e illeggibile`), che causavano il crash di `git.exe`.
Pertanto, i commit non sono stati eseguiti via CLI.

**Cosa fare per salvare il lavoro su Git**:
1. Riparare/reinstallare Git (o eseguire `chkdsk /f` se necessario).
2. Dal terminale o da VS Code / GitHub Desktop:
   ```bash
   git checkout -b refactor/split
   git add .
   git commit -m "refactor: split single-file dayflow into modular CSS/JS and cache-first SW (steps 0 and 1)"
   ```

---

## 4. Prossimi Passi (Per ripartire)

1. **Verifica manuale nel browser**:
   Aprire `http://localhost:3000` (o avviare `npx serve .` se riavviato):
   - Accedere con le proprie credenziali.
   - Provare le 4 schermate: **Pianifica**, **Oggi**, **Discover**, **Calendario**.
   - Creare, modificare ed eliminare un evento nel Calendario.
   - Trascinare la striscia settimanale del Calendario.
   - Aprire le Impostazioni (icona ingranaggio) e premere "Sincronizza ora".
   - Testare una modifica offline (da devtools: tab Network -> Offline) e poi tornare online per verificare la sincronizzazione.
2. **Passo successivo (prossima sessione / altro agente)**:
   - Eventuale migrazione a ES Modules e creazione dei test automatizzati.
