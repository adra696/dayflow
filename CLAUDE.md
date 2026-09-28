# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**DayFlow** is an ADHD-focused habit tracker and daily task manager. Design principles: radical simplicity, no guilt, low friction. The UI language is Italian.

## Running the App

No build step, no npm install, no bundler. Serve the folder with any static file server (`npx serve .`, `python -m http.server 8765`, VS Code Live Server) and open `index.html`. The `.claude/launch.json` config `dayflow-static` serves it on port 8765 for browser verification.

`test-grounding.html` is a standalone dev page (not part of the app, not in `sw.js` `STATIC`, not linked) for the Discover redesign: tests Gemini with `google_search` (JSON in text vs `responseSchema`) and `url_context`, reads the key from `localStorage` `dayflow_gemini_key` or a field, and builds a copyable report without the key.

`supabase/` holds the cloud side of the Discover redesign, deployed by hand from the Supabase dashboard (no CLI; steps in `supabase/SETUP.md`): `sql/01-feed-schema.sql` (`profiles.feed_topics`/`feed_settings`, tables `feed_items`, `feed_events`, `feed_runs` with RLS, cron secret in Vault), `sql/02-feed-cron.sql` (pg_cron at 4:00 and 5:00 UTC → the function runs only when it is 6:00 in Rome), `sql/03-feed-test.sql`, `sql/04-feed-phase4.sql` (`feed_items.follow_id`, table `feed_follows` with RLS: followed stories, 14 days), and the Edge Function `functions/generate-feed/index.ts` (Gemini + `google_search`, one call per topic, JSON read from text, sources mapped via `groundingSupports`, redirect links resolved; modes `morning` via `x-cron-secret`, `more` via user JWT checked with `auth.getUser`; gateway Verify JWT must be OFF). Modes: `morning` (cron; per user: taste profile if not `profileManual` and older than 7 days → `generateForUser` → `checkFollows`, max 6 followed stories, ≤2 updates each, inserted with `follow_id`, logged as `kind: 'follows'`), `more`, `profile` (user JWT, rebuilds the taste profile from 30 days of events with Gemini without search, merges `profile`/`profileAt`/`profileManual:false` into `feed_settings`; 422 `{ error: 'dayflow-few-signals' }` under 5 signals; 6/h), `proxy` (Gemini passthrough for articles/chat, JSON or SSE, key stays in Supabase secrets; only `google_search`/`url_context` tools allowed) and `models`; per-user hourly limits counted in `feed_runs` (`more` 6, `proxy` 120). **Retired model fallback**: every Gemini call goes through `callGemini()`; on 404 (or 400 "not found / not supported") `pickReplacement()` lists the models and picks stable > preview, same family (flash → flash), then highest version; the choice lives in memory 6h (`replaced`, redone after a cold start), is logged in `feed_runs` as `kind: 'model-fallback'`, and the proxy recomputes `thinkingConfig` for the new model. Proxy responses carry `x-dayflow-model` (exposed via CORS); the client's `adoptCloudModel()` saves it as the local model and shows a toast when it differs. To make it permanent set the `GEMINI_MODEL` secret. **Every change to `index.ts` must be pasted again in the dashboard (Edge Functions → generate-feed → Code → Deploy).**

`dayflow1_0.html` (the old single-file entry point) is now only a meta-refresh redirect to `index.html`, kept so the PWA already installed on iPhone keeps opening. Do not delete it.

## Architecture

Since 18 Sep 2026 the app is split into native ES modules: `index.html` loads a single `<script type="module" src="js/app.js">` (plus one `<link rel="modulepreload">` per module so the browser fetches the whole graph in parallel); nothing is global any more except the Supabase CDN client and the `window` bridge described below. The HTML and the JS templates still use ~80 inline handlers such as `onclick="goScreen('oggi')"`.

| File | Content |
|---|---|
| `index.html` | `<head>` (meta, CSP, manifest, fonts, Supabase CDN, 4 CSS links, 10 `modulepreload` links, the `js/app.js` module script) + the whole `<body>`: auth screen, shell, 4 screens, modals, settings panel, app dialog |
| `css/tokens.css` | Reset, `:root` custom properties (design tokens), `html`/`body`, the `max-width: 767px` 16px input rule |
| `css/base.css` | Auth screen, shell, topbar, sync indicator, progress, focus mode, stats, habit rows, modals, toast, TAP TARGETS block, settings panel, app dialog |
| `css/screens.css` | Pianifica, Oggi tasks, Discover (feed, sheet, article, chat, topics, model picker), Calendario (strip, all-day band, timeline, event editor) |
| `css/desktop.css` | The single `@media (min-width: 768px)` block (sidebar, layout, desktop modals, Calendario). **Must stay last**: it overrides base rules of equal specificity in the other files |
| `js/utils.js` | `todayStr`, `offsetDate`, `fmtDate`, `fmtShort`, `p2`, `uid`, `pctColor`, `heatColor`, `weekDays`, `monthDays`, `setBar`/`setRing`/`setSS`, `showToast`, `shootConfetti`, `withTimeout`, `plural` |
| `js/state.js` | Constants (`SUPA_URL`, `SUPA_KEY`, `SK`, `APP_VERSION`), Supabase client `sb`, `S`, `curUser`, `curScreen`, `selectedDate`, `SETTINGS`, `DLG`, the state setters, `load`, `persist`, `getDay`, `ensureSlotArrays`, `activeHabits`, `getImpegniDelGiorno`, `calcPct`, `calcAvg` (unused by the app, exported for the tests), `calcStreak` (unused, not exported), `toggleFocusMode`, `exportBackup` |
| `js/sync.js` | All Supabase sync in one block (see Persistence): queues, locks, epoch, `adoptRemoteDay`, `sbSave*`/`sbLoad*`, `scheduleSync`, `syncPendingDays`, `flushAllSync`, persisted queue, retry, `noteSync`, feed topics mirror, `online`/`visibilitychange`/`pagehide` listeners |
| `js/auth.js` | `switchTab`, `doLogin`, `doSignup`, `doLogout`, `doResetPwd`, `translateAuthError` |
| `js/plan.js` | Pianifica screen, habit management modal, recurring commitments modal |
| `js/oggi.js` | `renderOggi`, row gestures, habit list, stats |
| `js/calendario.js` | Everything `cal*`, event editor, `normalizeEvento`, `ensureEventi` |
| `js/feedrank.js` | Pure ranking for Discover: `feedQuality`, `feedFreshness`, `topicWeights(events, topicIds)`, `rankFeedItems(items, weights, { offset, prevTypes, moreSub, lessSub, blockedSources })` (score = quality × topic weight × freshness × subtopic multiplier — `"topicId:subtopic"` in `moreSub` ×1.5, in `lessSub` ×0.4, case-insensitive; cards whose sources are **all** blocked are dropped; top card = most important; every 6th card from a below-average topic; never 3 of the same `type` in a row; 2 of the same topic in a row is fine), source helpers `feedDomain`, `feedCardSources(c)` (primary `source`/`url` + `sources[]`, deduped by domain; a primary without link is skipped when search sources exist), `feedSourceCount`, `feedCardBlocked` (a blocked domain also covers subdomains), and `mergeNearDuplicates(items)` (same topic + title word-set Jaccard ≥ `FR.mergeJaccard` = 0.5 on normalized words ≥3 chars minus stopwords → one new card = the higher-quality one with merged deduped `sources` and `mergedIds`) |
| `js/discover.js` | `FEED` state, cloud feed (pool from `feed_items`, `requestCloudMore`, events queue), Gemini requests and streaming (cloud proxy or local key), fallback client generation, dedupe, saved, prefs, chat, model picker, Discover settings |
| `js/settings.js` | Settings panel (`openSettings`, `closeSettings`, `renderSettings*`, `settingsSyncNow`, `settingsGo`) |
| `js/app.js` | Entry module: hook registration, `initApp`, auth state listener, `goScreen`, app dialog, `requestLogout`, keyboard handling (Esc, Tab trap), swipe/carousel navigation, service worker registration, `window` bridge |
| `package.json` | `"type": "module"` + the `test` script only; no dependencies, nothing to install |
| `test/` | Node unit tests (see Tests) |

**Import graph** (no cycles; evaluation order follows the graph, not a script list):

```
utils ← state ← sync ← { auth, plan, oggi, calendario, discover, settings } ← app
feedrank (no imports) ← discover
plan → oggi          calendario → plan (closeModal)
settings → discover  auth → settings (closeSettings)
```

Every module exports through a single `export { … }` block at the bottom. `app.js` imports everything and is the only module with bootstrap code at top level (besides the `online`/`visibilitychange`/`pagehide` listeners in `sync.js` and the `localStorage` reads for `focusMode` in `state.js`).

**Shared state is written only through setters.** An imported binding is read-only, so a module that needs to reassign a top-level variable of another module calls its setter: `state.js` exports `setS`, `setCurUser`, `setCurScreen`, `setIsProgrammaticScroll`, `setSelectedDateOnly` (assignment only; `setSelectedDate()` also re-renders and loads the remote window), `setMMode`, `setEditId`, `setAllDaysLoaded`, `setLastTopPct`; `sync.js` exports `setSyncDebounce`, `setHabitsDirty`, `setHabitsInflight`, `bumpSyncEpoch`. Mutating properties of an exported object (`S.days[ds] = …`, `SETTINGS.open = true`, `pendingSync.add(ds)`) needs no setter.

**Upward dependencies are hooks registered by `app.js`.** Lower modules call functions of modules that would import them back (a cycle), so they hold them in module-level `let`s filled by a `set*Hooks()` call at the top of `app.js`, before any bootstrap (all modules are already evaluated at that point):

| Hook | Filled with | Used by |
|---|---|---|
| `setStateHooks` | `ensureEventi`, `loadWindowForDate`, `renderPlan`, `renderOggi`, `renderDiscover`, `renderHOggiList` | `ensureSlotArrays`, `setSelectedDate`, `toggleFocusMode` |
| `setSyncHooks` | `FEED`, `FEED_TOPICS_LS`, `ensureEventi`, `normalizeTopic`, `renderCalDay`, `renderCalStrip`, `renderCalendario`, `renderDiscover`, `renderHOggiList`, `renderOggi`, `renderPlan`, `renderSettingsSync`, `updateOggiStats` | remote loads that re-render the active screen, `sbSaveDay` payload, `noteSync`, feed topics mirror |
| `setAuthHooks` | `initApp`, `closeAppDialog` | `doLogin`/`doSignup`, `doLogout` |
| `setDiscoverHooks` | `openSettings` | `openFeedSheet('settings')` redirect |

If you add a new upward call, add it to the matching hook object (and to the destructuring in the `set*Hooks` function) rather than importing the module.

**`window` bridge.** Inline handlers (`onclick="…"` in `index.html` and in the HTML templates built by the modules) resolve names on `window`, so the last statement of `app.js` is an `Object.assign(window, { … })` listing every function/object they reference (`goScreen`, `openModal`, `setSelectedDate`, `offsetDate`, `CAL`, all Discover/settings actions…). **Any new function called from an inline handler must be added there, or the click throws `ReferenceError`.** Handlers attached from JS (`addEventListener`, `el.onclick = fn`) do not need it.

### Tests

`test/*.test.js` use only `node:test` + `node:assert/strict` (no npm dependencies). Run them with `npm test` (= `node --test test/*.test.js`, Node ≥ 22; the glob is expanded by Node, so it also works in PowerShell). `test/setup.js` must be the first import of every test file: it installs in-memory `localStorage`, an inert `supabase.createClient`, and `window`/`document` stubs so `state.js`/`sync.js` can be imported in Node; tests then register the real `ensureEventi` with `setStateHooks()` and reset `S.days`, `pendingSync`, `restoredPending` in `beforeEach`. Covered: `calcPct`, `calcAvg`, `normalizeEvento`, `ensureSlotArrays`/`ensureEventi`, `getDay`, `adoptRemoteDay`, the `feedrank.js` ranking (incl. subtopic multiplier, blocked sources, source count, `mergeNearDuplicates`), and in `test/discover.test.js` (imports `discover.js`) `parseArticleText`/`articleFromBlocks` (tldr), `applyFeedSettingsOps`, `normalizeTopic`. Tests describe the current behaviour of the code; a function that is private only for the tests' sake is exported by adding its name to the module's `export {}` block.

Supabase is loaded via CDN as a classic script before the app scripts: `<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2">`.

**Service worker** (`sw.js`): cache-first for every app asset listed in `STATIC` (HTML, CSS, JS, manifest, icons). Any new or renamed asset must be added to `STATIC`, and **every release must bump `CACHE`** (`dayflow-vNN`) or installed PWAs keep the old files. Supabase and Gemini are always network (POST bodies never touch the Cache API); Google Fonts and jsdelivr are stale-while-revalidate.

### Four Screens (tabs)

| Screen ID | Nav label | Purpose |
|---|---|---|
| `#screen-plan` | Pianifica | Morning: set 3 daily tasks + review habits + recurring commitments + weekly habits |
| `#screen-oggi` | Oggi | Dashboard: check off habits, progress bar, stats |
| `#screen-recap` | Discover | AI news feed (Gemini): vertical snap cards, topic chips, article drill-down + contextual chat. The id is kept as `recap` for routing compatibility. |
| `#screen-calendario` | Calendario | iOS-style calendar: week strip + single-day hourly timeline, events only |

Navigation is a fixed bottom bar. `goScreen(id)` switches the active screen.

### Global State Object (`S`)

All app state lives in the global object `S`:

```javascript
S = {
  habits: [
    { id, nome, frequenza: "giornaliera"|"settimanale", targetSettimanale, ordine, attiva }
  ],
  days: {
    "YYYY-MM-DD": {
      data, timestamp,
      abitudini: { [habitId]: { completato: boolean, saltato?: boolean } },
      attivitaDelGiorno: { compiti: [str,str,str], altaPriorita: [bool,bool,bool], completato: boolean },
      eventi: [ { id, titolo, tipo: "impegno"|"scadenza", tuttoIlGiorno: bool, ora: "HH:MM", durata: minuti, completato: bool } ],
      note: string
    }
  }
}
```

### Persistence

- **Cloud (primary)**: Supabase PostgreSQL — tables `profiles` (habits) and `days` (daily records), one row per user per day.
- **Local fallback**: `localStorage` key `dayflow_v3`, full JSON of `S`.
- Every mutation calls `persist()` (localStorage) and schedules a Supabase sync via `scheduleSync()` (debounced 1.2s). `scheduleSync(ds)` adds `ds` to `pendingSync` and bumps `dirtyGen[ds]`; when the timer fires `syncPendingDays()` saves **every** queued day, and `sbSaveDay()` (returns `true/false`) removes a day from `pendingSync` only if it was not modified again while the upsert was in flight. `sbSaveHabits()` (profile: habits + recurring commitments) returns `true/false` and keeps `habitsDirty` set until a save succeeds.
- **In-flight locks**: at most one upsert per day (`dayInflight` Map) and one for the profile (`habitsInflight`); a `sbSaveDay`/`sbSaveHabits` call while one is in flight joins its promise, and on success the running upload re-runs with fresh data if the day/profile changed meanwhile (so the last payload the server receives is the newest); on failure no immediate re-run (queue + retry/backoff rules); `flushAllSync()` also awaits uploads already in flight (and their re-runs) within its timeout.
- **Session epoch**: `syncEpoch` is bumped by `doLogout()` (and the corrupted-session branch), which also clears `dayInflight`/`habitsInflight` and `RETRY.running`; every save/load/reconcile/flush/retry captures it at start and, after each `await`, returns (`false`/`null`) without touching queue, `S`, indicators or `noteSync` if it changed; lock entries are removed only by the wrapper that owns them; `dirtyGen` values come from a monotonic `genSeq` (never reused across sessions).
- `flushAllSync(timeoutMs = 10000)` cancels the debounce timer and immediately saves the dirty profile + all pending days; resolves `true` only if nothing is left to sync (timeout = failure). Used by logout and "Sincronizza ora". `noteSync()` records the last outcome in `SYNC_INFO` for the settings panel.
- **Day merge rule (last-write-wins on client timestamp)**: `day.timestamp` is the `Date.now()` of the last local edit and is set **only** in `scheduleSync()` (every day mutation goes through it; it is also what `sbSaveDay()` uploads). A day freshly created by `getDay()` has `timestamp: 0` (never edited), so any remote row replaces it; read-side normalization (`ensureSlotArrays`/`ensureEventi`/`normalizeEvento`) and adopting a remote day never touch it. Every remote → local merge goes through `adoptRemoteDay()` (initial window, `loadWindowForDate()`, `renderOggi()`, background/Calendario full load): remote wins only if `remote.timestamp > local.timestamp` (equal = our own save, local kept), and a day still in `pendingSync` is never overwritten. Device clocks are trusted as-is: with skewed clocks the write of the device that is "behind" can lose — accepted.
- **Persisted sync queue** (`localStorage` `dayflow_pending_sync` = `{ uid, days: [ds], habits: bool }`): `savePendingQueue()` rewrites it (or removes it when empty) every time the queue changes — `scheduleSync()`, `sbSaveDay()` success/failure, `sbSaveHabits()` start/success, `dropPendingDay()`; also on `visibilitychange`→hidden and `pagehide` (plus `persist()`). `initApp()` calls `restorePendingQueue()` right after `load()` and **before** any remote load; a queue whose `uid` ≠ `curUser.id` is ignored, dates missing from `S.days` are dropped, and the `habits` flag is restored only if local habits/commitments exist (never upload an empty profile). Restored dates go into `pendingSync` **and** `restoredPending`; after the initial window load `initApp` calls `retryPendingSync(true)` without awaiting it. `doLogout()` removes the key (as does the corrupted-session branch at startup).
- **Restored vs in-session queue**: a day edited in this session (in `pendingSync`, not in `restoredPending`) is never overwritten by a remote load. A *restored* day follows last-write-wins before it is uploaded: `adoptRemoteDay()` (any remote load) and `reconcileRestoredDay()` (a per-day `sbLoadDay()` run by `syncPendingDays()` before each upload, so days outside the loaded window are checked too) adopt the remote row and drop the day from the queue if `remote.timestamp > local.timestamp`; otherwise (older, equal, missing or unreadable/offline) the local day is uploaded. The `restoredPending` flag is cleared on successful upload or on a new local edit (`scheduleSync()`), so every retry re-checks the remote. The profile has no per-record timestamp: while `habitsDirty` (also restored), `sbLoadHabits()` does not overwrite local habits/commitments — local wins and gets uploaded.
- **Automatic retry**: `retryPendingSync(force)` = `flushAllSync(15000)` if the queue is non-empty, fired only by events (no timers → no retry loop): `online` (force, ignores backoff), `visibilitychange`→visible (respects backoff: 5 s, doubling, max 5 min; reset on success), app hidden with a debounce pending (best-effort immediate upload). The settings "N in coda" counter includes restored days.
- There is no "Salva giornata" button: Pianifica task fields save as you type (`input` → `scheduleSync()` → `persist()` immediately).

### Progress Calculation

```
total = active habits NOT skipped
      + non-empty daily tasks (each task weighs 1, like a habit)
      + recurring commitments scheduled for that weekday
done  = completed non-skipped habits + atdDoneCount(day) + completed commitments (impegniRicorrentiCompletati)
pct   = total === 0 ? 0 : Math.round(done / total * 100)   // calcPct() returns null for a day never opened
```

This supersedes the older formula in `istruzioni.txt` (daily tasks as a single "+1" item).

Days never opened contribute nothing to weekly/monthly averages. Weekly habits can be marked `saltato` (skipped) so rest days don't penalize the daily percentage.

### Key Functions

| Category | Functions |
|---|---|
| Auth | `doLogin()`, `doSignup()`, `requestLogout()` (confirm + flush, the only entry point), `doLogout()` (actual sign-out, never call directly from UI), `switchTab()` |
| Data | `load()`, `persist()`, `getDay()`, `activeHabits()`, `calcPct()`, `exportBackup()` |
| Supabase sync | `sbSaveHabits()`, `sbLoadHabits()`, `sbSaveDay()`, `sbLoadDay()`, `sbLoadAllDays()`, `scheduleSync()`, `syncPendingDays()`, `flushAllSync()`, `hasUnsyncedChanges()`, `noteSync()` |
| Navigation | `goScreen()`, `openModal()`, `closeModal()` |
| Settings | `openSettings(section?)`, `closeSettings(restoreFocus = true)`, `renderSettings()`, `renderSettingsSync()`, `settingsSyncNow()`, `settingsGo()` |
| Dialog | `openAppDialog({ title, msg, warn, okLabel, cancelLabel, keepOpen })` → `Promise<boolean>`, `confirmAppDialog()`, `closeAppDialog()`, `setAppDialogBusy()` |
| Calendario | `renderCalendario()`, `calBuildGrid()`, `renderCalStrip()`, `renderCalDay()`, `calLayoutEventi()`, `calSetDate()`, `updateCalNow()`, `openEventoModal()`, `saveEvento()`, `deleteEvento()`, `ensureEventi()`, `normalizeEvento()` |
| Analytics | `calcAvg()` (exported for the tests, not called by the app), `weekDays()` |
| Discover | `renderDiscover()`, `generateFeed()`, `regenerateFeed()`, `expandArticle()`, `openFeedChat()`, `sendFeedChat()`, `openFeedSheet()`, `feedSettingsHTML()`, `renderFeedSettings(el)`, `refreshFeedSettings()`, `geminiRequest()`, `geminiStream()`, `streamArticle()`, `parseArticleText()` |
| Utils | `todayStr()`, `uid()`, `fmtDate()`, `p2()`, `pctColor()`, `heatColor()` |

## Impostazioni

- Global settings panel `#settings-panel` (`.fsheet-overlay.settings-overlay` + `.fsheet.settings-sheet`, `role="dialog"`, `aria-modal`): full screen on mobile, centered 600px sheet from 768px (inherits the desktop `.fsheet` rules). Opened by the gear `.settings-btn` in every topbar (replaces the old "esci" buttons) and, on desktop, by `#nav-settings-btn` at the bottom of the sidebar (hidden on mobile so the bottom nav stays 4 columns). Closes with X, tap outside (desktop), Esc; focus goes to the close button on open and back to the trigger on close; Tab is trapped inside. State in `SETTINGS = { open, trigger }`.
- Sections (`#settings-sec-<id>`, `.settings-sec` + `.settings-row`/`.settings-lbl`/`.settings-val`): **account** (email, last sync outcome from `SYNC_INFO` with a `.sync-dot`, "Sincronizza ora" → `settingsSyncNow()` = `flushAllSync()` + a cheap read to verify connectivity when nothing was queued, "Esci" → `requestLogout()`), **abitudini** / **impegni** (counts + `settingsGo(openModal | openImpegniModal)`, which closes the panel first), **oggi** (switch `#set-focus` bound to `focusMode`/`toggleFocusMode()`, kept in sync with the "focus" button), **discover** (`#settings-discover-body`, rendered by `renderFeedSettings()`), **dati** (`exportBackup()` downloads `JSON.stringify(S)` as `dayflow-backup-YYYY-MM-DD.json`; no import), **info** (`DayFlow ${APP_VERSION}`).
- `openFeedSheet('settings')` (e.g. "Cambia chiave", regenerate without key) redirects to `openSettings('discover')`, which scrolls to the Discover section. The feed sheet never renders settings any more; every Discover settings action (`saveFeedKey`, `removeFeedKey`, `setFeedModel`, `fetchGeminiModels`, `clearFeedCache`, `clearFeedSeen`, `clearFeedPrefs`) calls `refreshFeedSettings()` and keeps the panel open; key/cache changes re-render the feed only if Discover is the current screen. "Argomenti" closes the panel and opens the topics sheet.
- **Logout** (`requestLogout()`): app dialog "Uscire da DayFlow?" (`#app-dlg`, red "Esci" + "Annulla", never native `confirm()`); if `eventiColumnOk === false` and some day has events, a warning says they live only on this device and will be deleted. On confirm the dialog stays open in busy state while `flushAllSync()` runs; on failure/timeout a second dialog "Alcune modifiche non sono ancora sincronizzate. Uscendo le perderai." offers "Esci comunque" / "Annulla". Only then `doLogout()` clears timers and queues, signs out and wipes `S` + `localStorage[SK]`.
- Dialog z-order: modal 100 < feed sheet 110 < settings 115 < app dialog 130.

## Accessibility / touch

- No text below 11px anywhere (CSS and inline styles in JS).
- Tap targets ≥44×44 without changing the look: transparent `::after` (see the `TAP TARGETS` CSS block) on `.icon-btn`, `.date-nav-arrow`, `.cal-arrow`, `.cal-today-btn`, `.focus-btn`, `.skip-btn`, `.pri-toggle`, `.slot-del`, `.modal-close`, `.set-switch`; expansions never reach a neighbour's visible box (`.slot-del` expands only 6px towards `.pri-toggle`). Oggi task rows (`.task-item.clickable`) are the tap target themselves, `min-height: 44px`.
- Viewport allows zoom (no `maximum-scale`/`user-scalable=no`); `body` and `#screen-area` use `touch-action: manipulation` (no double-tap zoom, pinch allowed); `.cal-scroll`/`.cal-strip` are `pan-y pinch-zoom`. Below 768px every `input`/`textarea`/`select` is forced to 16px so iOS Safari does not auto-zoom on focus.

## Design System

CSS custom properties defined in `:root`:

| Variable | Value | Usage |
|---|---|---|
| `--bg` | `#09090b` | Main dark background |
| `--text` | `#f4f4f5` | Primary text |
| `--green` | `#10b981` | Success, active state, progress fill |
| `--red` | `#ef4444` | Error, skip, high-priority |
| `--orange` | `#f59e0b` | Mid-progress |
| `--yellow` | `#eab308` | Warning, syncing indicator |
| `--mono` | DM Mono | Labels, stats, navigation text |
| `--sans` | DM Sans | Body copy |

Progress bar color thresholds: 0–25% red → 26–50% orange → 51–75% yellow → 76–100% green.

## Supabase Configuration

Credentials are hardcoded at the top of `js/state.js`:

```javascript
const SUPA_URL = 'https://iqlxjazrshqzqrltkjoz.supabase.co';
const SUPA_KEY = '...'; // public anon key, safe to expose
```

The `SUPA_KEY` is the public anon key (read/write gated by Supabase RLS policies), not a secret.

The `days` table needs an `eventi jsonb` column:

```sql
alter table public.days add column if not exists eventi jsonb not null default '[]'::jsonb;
```

If the column is missing, `sbSaveDay()` catches the error once, flips `eventiColumnOk` to `false` and keeps saving everything else; events then live in `localStorage` only. `adoptRemoteDay()` never lets a remote row without `eventi` wipe local events.

## Discover Feed (Gemini)

**Cloud mode (logged in, `cloudOn()`)** — since Sep 2026 the news come from Supabase, the rest of this section describes the client generation that remains as fallback:
- `generateFeed()` → `cloudFeedCards(null, FEED_FIRST_N, reload)`: `loadFeedPool()` reads `feed_items` of the last 72h + `feed_events` of the last 30 days, maps rows with `rowToCard()` (`db: true`, `why`, `url`, `type`, `subtopic`, `tags`, `q: [spec, novelty, importance]`, `pubAt`, `pubDay` when Gemini gave only a date), computes `FEED.weights = topicWeights(...)`, and `pickFromPool()` ranks the unseen ones with `rankFeedItems`. Seen = `view`/`skip`/`down`/`less` events + `localStorage` `dayflow_feed_viewed` (7d). If fewer than 4 are left it awaits `requestCloudMore(topicId)` (function `mode: 'more'`, one at a time); when fewer than `FEED_CARDS_N` remain after a pick it prefetches in background. `loadMoreFeed()` → `nextFeedCards()`; any cloud failure except auth/rate falls back to `fetchFeedCards()`. Pull-to-refresh reloads the pool.
- Gemini calls (`geminiRequest`/`geminiStream`/model list) go through `geminiFetch()`: function `mode: 'proxy'` with the user JWT; on network error or 5xx, and only if a local key exists, direct call with the local key. The local key is optional in cloud mode. Errors `dayflow-auth`/`dayflow-rate` have their own messages.
- Cards show "Perché conta" (`.feed-why`) and the source as a link (`a.feed-src`, `feedSourceClick()` logs `open`). Articles of cloud cards pass the real URL with tools `url_context` + `google_search` (retry without tools on 400) and are cached in `feed_items.article` (the only column the client may update). Chat adds `url_context`.
- Interactions (`logFeedEvent(card, kind, dwell)`): `view` (card ≥60% visible for ≥1.5 s) / `skip`, `open`, `chat`, `save`/`unsave`, `share`, `up`/`down`/`unvote`, `less`/`more`, queued in `localStorage` `dayflow_feed_evq` (with `uid`) and inserted into `feed_events` in batches (4 s debounce, app hidden). Skips never lower a topic's weight; only explicit negatives do (`down`, `less`). A `view`/`skip` also marks the card's `mergedIds` as seen.
- Adding a topic saves the profile first and then asks the function for news on it. `sbLoadFeedTopics()` copies local topics to `profiles.feed_topics` when the profile has none.
- **Phase 4 (feedback, richer topics, taste profile).** Pool rows also read `sources` and `follow_id` (`FEED_ITEM_COLS_P4`; if the select fails on `follow_id` because SQL 04 was not run, `FEED.noFollowCol` retries without it); `rowToCard()` maps `followId` and `sources: [{ title, url }]`. `pickFromPool()` = `rankFeedItems(mergeNearDuplicates(feedPoolLeft()), …, feedPrefs())`; `feedPoolLeft()` also excludes ids merged into cards already in the feed.
  - **Card**: `.feed-top` row = topic badge, "↻ Aggiornamento" (`.feed-upd`, when `followId`), 👍/👎 (`.feed-vbtn`, only on `db` cards). `voteFeedCard(id, v)` logs `up`/`down` (same vote again → `unvote`), stores the vote in `localStorage` `dayflow_feed_votes` (`{ id: { v, ts } }`, 30 days) and opens `.feed-vote-pop` inside the card: 👎 → "Meno su «subtopic»" (`lessSub` + event `less`) / "Non mostrarmi <domain or name>" (`blockedSources`, lowercase); 👍 → "Di più su «subtopic»" (`moreSub` + event `more`) / "Segui la storia". `feedVoteAction()` runs the choice; the popover closes on outside click, feed scroll or re-render. Meta row shows "N fonti" (`.feed-nsrc`) when `feedCardSources()` has ≥2 outlets.
  - **`profiles.feed_settings`** (`{ area, profile, profileAt, profileManual, prefs: { moreSub, lessSub, blockedSources }, …other keys }`, shared with the function) is never overwritten whole: `changeFeedSettings(ops)` applies ops (`{ k, v }` sets a key, `{ list, add|del }` edits a `prefs` list, case-insensitive dedupe, max 100) to the local copy and queues them in `localStorage` `dayflow_feed_settings` = `{ uid, s, ops }`; `syncFeedSettings()` (one run at a time, re-runs if called meanwhile) reads the row, applies the queued ops (`applyFeedSettingsOps`) and `update`s `feed_settings` by `id`; on failure ops stay queued and are retried by the next pool load / Discover open / settings open. Without ops it just refreshes the local copy.
  - **Ascolta voice**: `ttsItVoices()` ranks Italian `speechSynthesis` voices (user choice in `localStorage` `dayflow_tts_voice` > Premium/Enhanced/Siri > known good names; iOS Eloquence/novelty voices like Eddy, Rocko, Grandma last); Discover settings has a voice select + "Prova" (`setFeedTtsVoice`, `testFeedTtsVoice`) and explains how to download an enhanced voice on iPhone.
  - **Followed stories** (`feed_follows`, SQL 04): `followFeedStory(id)` inserts `{ item_id, topic_id, title, summary, url }` (user_id defaults to `auth.uid()`), `loadFeedFollows()` lists active ones not expired, "Smetti di seguire" (`unfollowFeedStory(i)` / `toggleFollowFeedStory(id)`) sets `active=false`. State `FEED.follows`.
  - **Article**: the prompt asks for 3 lines starting with `- ` right after the title (plus the topic's level); `parseArticleText()` returns `{ title, tldr, blocks }` (`- ` lines before the first block, an "In breve" label is skipped) and `articleFromBlocks(title, blocks, tldr)` stores `fullArticle.tldr` (max 3; old articles without it still render). Box "In 30 secondi" (`.art-tldr`, filled live while streaming), sources list (`.art-srcs`) when ≥2 outlets, tools row `#fart-tools`: "🔊 Ascolta"/"■ Stop" (`toggleArticleSpeech()`, `speechSynthesis`, it-IT voice if any, one utterance per title/tldr point/heading/paragraph, all queued at once; hidden without `speechSynthesis`; stopped by `closeFeedSheet()`, opening another card/mode, `abortArticleStream()`) and "📌 Segui la storia"/"✓ Storia seguita".
  - **Topics** (`normalizeTopic` keeps `focus`, `exclude` ≤300 chars, `area` `'misto'|'italia'|'europa'|'mondo'` or `null` = general, `level` `'divulgativo'|'tecnico'`): ✎ opens an inline editor (`editFeedTopic`, `saveFeedTopicEdit`, `cancelFeedTopicEdit`; name, emoji, focus, exclusions, area incl. "Come generale", level) saved via `saveFeedTopics()`. "Crea da una frase" (`createFeedTopicFromPhrase()`) calls `geminiJSON()` (proxy, no tools, `responseSchema` `{ label, emoji, focus, exclude, level }`) and shows the result in the editor as a draft (`FEED.topicDraft`, `topicEdit = '__new'`) that "Aggiungi" adds through `addFeedTopicObj()` (same path as the quick add).
  - **Settings** (cloud only, `feedCloudSettingsHTML()` in `feedSettingsHTML()`): general area select (`setFeedArea`), taste profile textarea + "Salva" (`saveFeedProfile`: `profileManual: true` and `profileAt` now; empty text → `profileManual: false`) + "Rigenera" (`regenFeedProfile`: function `mode: 'profile'` → `{ profile, profileAt }`; error `dayflow-few-signals` → "Servono almeno 5 reazioni alle notizie"), prefs lists with × (`removeFeedPref(list, i)`), followed stories with "Smetti di seguire". `renderFeedSettings()` reloads settings + follows from the cloud at most every 30 s and keeps an edited (dirty) profile textarea across re-renders.

**Client generation (fallback, not logged in or cloud down):**

- Model selectable in the Discover section of the global settings panel (default `gemini-2.5-flash`), used for feed, articles and chat via REST `generateContent`; the API key goes in the `x-goog-api-key` header, never in the URL. `feedModel()` reads `localStorage` `dayflow_gemini_model` (validated by `/^[a-z0-9][a-z0-9.\-]*$/i`, local only like the key) and `geminiUrl(stream)` builds the endpoint at request time. The picker (`renderFeedModelPicker()`, options styled as `.topic-row.model-opt`) lists 3 presets (Flash, Flash-Lite, Pro), the models loaded by "Carica modelli dalla chiave" (`fetchGeminiModels()`: `GET v1beta/models?pageSize=200`, keeps `models/gemini*` with `generateContent`, drops embedding/tts/image/live/audio…, stored in `dayflow_gemini_models` = `{ ts, models: [{ id, label }] }`) and a free-text "Altro modello" field. `setFeedModel()` saves + toasts; it does not regenerate the feed nor invalidate cached feed/articles.
- `geminiThinkingConfig()` picks a model-compatible `thinkingConfig`: `{ thinkingBudget: 0 }` for 2.5 flash / flash-lite, `{ thinkingLevel: 'low' }` for `gemini-3*`, omitted for everything else (Pro cannot disable thinking → 400). When thinking is not off, the article's `maxOutputTokens` goes from 3072 to 8192 because thinking tokens count against it.
- `feedErrorMessage()`: 401/403 (or 400 whose detail mentions the API key) → invalid key; other 400 → "Richiesta rifiutata: <detail>"; 404 → current model unavailable, suggests changing it in settings.
- API key lives only in `localStorage` (`dayflow_gemini_key`). Topics in `dayflow_feed_topics` (phase 4 fields included), mirrored to `profiles.feed_topics` with a silent fallback if the column does not exist.
- Daily cache `dayflow_feed_YYYY-MM-DD` = `{ generatedAt, topicIds, cards[], stale }`; older keys are pruned on load. Expanded articles are stored inside `cards[i].fullArticle` (`{ title, sections: [{ heading, paragraphs[] }] }`; `heading` may be `''`).
- Article streaming: `expandArticle()` → `streamArticle()` uses `geminiStream(body, onChunk, { signal })` (endpoint `:streamGenerateContent?alt=sse`, fetch reader + `TextDecoder` + `createSSEParser()`, same error codes as `geminiRequest`, plus `code: 'abort'`; `thinkingConfig` from `geminiThinkingConfig()`, i.e. thinking off on flash models for faster first token). The model writes plain text: line 1 title, blank line, `## Subheading`, paragraphs separated by blank lines; `parseArticleText(text, final)` parses it incrementally and `paintArticleStream()` updates the DOM per block via `textContent` (rAF-throttled, no full re-render, blinking `.art-tail` cursor). `fullArticle` is saved only when the stream completes with `STOP` (`finishReason: MAX_TOKENS` → `code: 'truncated'`, shown as "Articolo interrotto" + Riprova; article request sets `maxOutputTokens: 3072`, 8192 when thinking stays on). On completion the card is looked up by id in the current `FEED.data` (the feed may have been regenerated meanwhile) before `saveFeedCache`, then `syncFeedSaved`; closing the sheet or opening another card calls `abortArticleStream()` and nothing is saved. Mid-stream errors keep the partial text (`FEED.articlePartial`, memory only) with the error and a "Riprova" button. The chat still uses the non-streaming `geminiText()`.
- Feed behaves like a reel: pull-to-refresh on the first card (touch drag, or mouse wheel up at the top on desktop) calls `regenerateFeed()`; the last slide (`#disc-end`) is watched by an IntersectionObserver and triggers `loadMoreFeed()`, which appends `FEED_CARDS_N` cards via `fetchFeedCards()` without resetting scroll (`overflow-anchor: none` on `.feed`). With a topic chip active, load-more generates only for that topic.
- Dedupe: every generated title is stored in `localStorage` `dayflow_feed_seen` (`[{ t, ts, topicId }]`, 72h TTL, capped at 300) and the last 80 are sent to Gemini as an exclusion list; exact duplicates are also filtered client-side. The Discover settings section shows the count and a "Dimentica tutto" button.
- Prefetch: the observer also watches the last `FEED_PREFETCH_AHEAD` (3) real cards, so the next batch starts when few cards remain ahead; if the filtered view has ≤ 3 cards (or none: the "end" slide is rendered alone as a loading state) `attachFeedEndObserver()` calls `loadMoreFeed()` immediately. Cards generated while the chip changed are stored in `FEED.data.cards` but appended to the DOM only if they match the current filter (`appendFeedCards()`); `FEED.moreTopic` tracks the in-flight topic and results are discarded if the feed was regenerated meanwhile.
- Saved: bookmark button on each card → `dayflow_feed_saved` (full card objects incl. `fullArticle`, max 100); chip `saved` shows them newest-first with no end slide, no load-more, no pull-to-refresh. `feedCardById()` also looks in saved.
- Implicit interests: `expandArticle()` / `openFeedChat()` call `recordFeedPref()` → `dayflow_feed_prefs` (14d TTL, max 30); last 15 matching active topics go into the prompt as "INTERESSI DELL'UTENTE". Reset button in settings.
- Share: `shareFeedCard()` uses `navigator.share`, clipboard fallback.
- CSP `connect-src` allows `generativelanguage.googleapis.com`; `sw.js` treats that host as network-only (POST bodies must never hit the Cache API).

## Calendario (settimana + timeline)

- One day at a time, iOS Calendar style. `CAL = { date, inited }` holds the viewed day; `selectedDate` (Pianifica/Oggi) is untouched.
- **Week strip**: 7 buttons (Mon–Sun of `CAL.date`'s week). The day number sits in a circle tinted by `heatColor(calcPct(ds))` — that is the only trace left of the old monthly heatmap. Today = accent number, selected = ring, a dot below marks days with events.
- **Timeline**: `calBuildGrid()` draws 25 hairlines + 24 hour labels once; `CAL_HOUR_H = 56` px per hour, so the body is 1368px tall. Events are absolutely positioned in `#cal-canvas` (`top = min/60*56`, min height `CAL_MIN_EV = 26`). `calLayoutEventi()` groups overlapping events into clusters and splits the width into columns.
- **All-day band** (`#cal-allday`) shows `tuttoIlGiorno` events as chips above the timeline; hidden when empty.
- **Now line** (`#cal-now`, red) only on today, repositioned every 30 s while the Calendario screen is active.
- **Navigation**: tap a day in the strip, ‹ › arrows shift a week, `calGoToday()`, horizontal swipe on the timeline shifts one day and on the strip one week. `.cal-scroll` is `touch-action: pan-y pinch-zoom` so a horizontal drag never moves the screen carousel.
- **Strip slider**: `#cal-strip-days` is an `overflow:hidden` viewport holding `.cal-strip-track` with 3 week pages (prev / current / next, `calStripPage()`), resting at `translateX(-100%)`. `calInitStripDrag()` uses Pointer Events (touch + mouse, capture only after the horizontal lock, click suppressed after a drag): the track follows the finger via rAF; release past 25% width or >0.4 px/ms commits ±7 days, otherwise it snaps back. Every week change (drag, arrows, timeline day swipe, `calGoToday()`) goes through `calSetDate()` → `calStripUpdate()`: same week → only `sel` changes; other week → the target week is pre-rendered in the side page and the track slides one page (`calStripAnimate()`, `.32s var(--ease-out)`, `transitionend` + timeout fallback), then `calStripBuild()` rebuilds centred without transition. `CAL.date` changes immediately, the strip catches up. A new change during a slide first jumps the running one to its end (`calStripStop()`); drags and day taps are ignored while `CALS.anim`. `prefers-reduced-motion` → instant change.
- **Events**: tap an empty slot (rounded to 30 min) or the FAB to create, tap a block to edit. The editor reuses `#modal-overlay` (`openEventoModal` / `renderEventoModal` / `saveEvento` / `deleteEvento`), state in `evDraft`.
- `normalizeEvento()` migrates legacy events: missing `durata` → 60 min, missing or malformed `ora` → `tuttoIlGiorno`. `ensureEventi()` runs from `ensureSlotArrays()`, so every day read through `getDay()` is normalized.
- Events do **not** feed `calcPct()`; progress still comes from habits, daily tasks and recurring commitments.

## Specifications

`istruzioni.txt` contains the full feature spec in Italian — data structures, calculation formulas, UX rules, and the release roadmap. Read it when implementing features related to skip logic, progress calculation, or analytics.
