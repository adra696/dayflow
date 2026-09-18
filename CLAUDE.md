# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**DayFlow** is an ADHD-focused habit tracker and daily task manager. Design principles: radical simplicity, no guilt, low friction. The UI language is Italian.

## Running the App

No build step, no npm install, no bundler. Serve the folder with any static file server (`npx serve .`, `python -m http.server 8765`, VS Code Live Server) and open `index.html`. The `.claude/launch.json` config `dayflow-static` serves it on port 8765 for browser verification.

`dayflow1_0.html` (the old single-file entry point) is now only a meta-refresh redirect to `index.html`, kept so the PWA already installed on iPhone keeps opening. Do not delete it.

## Architecture

Since 18 Sep 2026 the app is split into plain files (no modules yet; every script is a classic `<script defer>` sharing the global scope, and the HTML uses ~80 inline handlers such as `onclick="goScreen('oggi')"`):

| File | Content |
|---|---|
| `index.html` | `<head>` (meta, CSP, manifest, fonts, Supabase CDN, 4 CSS links, 10 deferred scripts) + the whole `<body>`: auth screen, shell, 4 screens, modals, settings panel, app dialog |
| `css/tokens.css` | Reset, `:root` custom properties (design tokens), `html`/`body`, the `max-width: 767px` 16px input rule |
| `css/base.css` | Auth screen, shell, topbar, sync indicator, progress, focus mode, stats, habit rows, modals, toast, TAP TARGETS block, settings panel, app dialog |
| `css/screens.css` | Pianifica, Oggi tasks, Discover (feed, sheet, article, chat, topics, model picker), Calendario (strip, all-day band, timeline, event editor) |
| `css/desktop.css` | The single `@media (min-width: 768px)` block (sidebar, layout, desktop modals, Calendario). **Must stay last**: it overrides base rules of equal specificity in the other files |
| `js/utils.js` | `todayStr`, `offsetDate`, `fmtDate`, `fmtShort`, `p2`, `uid`, `pctColor`, `heatColor`, `weekDays`, `monthDays`, `setBar`/`setRing`/`setSS`, `showToast`, `shootConfetti`, `withTimeout`, `plural` |
| `js/state.js` | Constants (`SUPA_URL`, `SUPA_KEY`, `SK`, `APP_VERSION`), Supabase client `sb`, `S`, `curUser`, `curScreen`, `selectedDate`, `SETTINGS`, `DLG`, `load`, `persist`, `getDay`, `ensureSlotArrays`, `activeHabits`, `calcPct`, `calcAvg`, `calcStreak`, `toggleFocusMode`, `exportBackup` |
| `js/sync.js` | All Supabase sync in one block (see Persistence): queues, locks, epoch, `adoptRemoteDay`, `sbSave*`/`sbLoad*`, `scheduleSync`, `syncPendingDays`, `flushAllSync`, persisted queue, retry, `noteSync`, feed topics mirror, `online`/`visibilitychange`/`pagehide` listeners |
| `js/auth.js` | `switchTab`, `doLogin`, `doSignup`, `doLogout`, `doResetPwd`, `translateAuthError` |
| `js/plan.js` | Pianifica screen, habit management modal, recurring commitments modal |
| `js/oggi.js` | `renderOggi`, row gestures, habit list, stats |
| `js/calendario.js` | Everything `cal*`, event editor, `normalizeEvento`, `ensureEventi` |
| `js/discover.js` | `FEED` state, Gemini requests and streaming, feed generation, dedupe, saved, prefs, chat, model picker, Discover settings |
| `js/settings.js` | Settings panel (`openSettings`, `closeSettings`, `renderSettings*`, `settingsSyncNow`, `settingsGo`) |
| `js/app.js` | `initApp`, auth state listener, `goScreen`, `openModal`/`closeModal`, app dialog, `requestLogout`, keyboard handling (Esc, Tab trap), swipe/carousel navigation, service worker registration |

Load order matters: `utils` → `state` → `sync` → `auth` → `plan` → `oggi` → `calendario` → `discover` → `settings` → `app`. A top-level `const`/`let` used by an earlier file must be declared in a file loaded before it; only `app.js` runs bootstrap code at top level.

Planned next step (not done): convert the scripts to native ES modules with a `window` bridge for the inline handlers, `sync.js` moved as a block, import graph `utils ← state ← sync ← screens ← app` with no cycles. See `handoff-passo2-es-modules.md`.

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
totaleVoci     = active habits NOT skipped + 1  (the "daily tasks" item)
vociCompletate = completed non-skipped habits + (attivitaCompletate ? 1 : 0)
percentuale    = (vociCompletate / totaleVoci) * 100
```

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
| Analytics | `calcAvg()`, `weekDays()` |
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

Credentials are hardcoded in the `<script>` section near the top of the JS block:

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

- Model selectable in the Discover section of the global settings panel (default `gemini-2.5-flash`), used for feed, articles and chat via REST `generateContent`; the API key goes in the `x-goog-api-key` header, never in the URL. `feedModel()` reads `localStorage` `dayflow_gemini_model` (validated by `/^[a-z0-9][a-z0-9.\-]*$/i`, local only like the key) and `geminiUrl(stream)` builds the endpoint at request time. The picker (`renderFeedModelPicker()`, options styled as `.topic-row.model-opt`) lists 3 presets (Flash, Flash-Lite, Pro), the models loaded by "Carica modelli dalla chiave" (`fetchGeminiModels()`: `GET v1beta/models?pageSize=200`, keeps `models/gemini*` with `generateContent`, drops embedding/tts/image/live/audio…, stored in `dayflow_gemini_models` = `{ ts, models: [{ id, label }] }`) and a free-text "Altro modello" field. `setFeedModel()` saves + toasts; it does not regenerate the feed nor invalidate cached feed/articles.
- `geminiThinkingConfig()` picks a model-compatible `thinkingConfig`: `{ thinkingBudget: 0 }` for 2.5 flash / flash-lite, `{ thinkingLevel: 'low' }` for `gemini-3*`, omitted for everything else (Pro cannot disable thinking → 400). When thinking is not off, the article's `maxOutputTokens` goes from 3072 to 8192 because thinking tokens count against it.
- `feedErrorMessage()`: 401/403 (or 400 whose detail mentions the API key) → invalid key; other 400 → "Richiesta rifiutata: <detail>"; 404 → current model unavailable, suggests changing it in settings.
- API key lives only in `localStorage` (`dayflow_gemini_key`). Topics in `dayflow_feed_topics`, mirrored to `profiles.feed_topics` with a silent fallback if the column does not exist.
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
