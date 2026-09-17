# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**DayFlow** is an ADHD-focused habit tracker and daily task manager. Design principles: radical simplicity, no guilt, low friction. The UI language is Italian.

## Running the App

No build step. The entire app is a single self-contained file:

- **Open in browser**: Open `dayflow1_0.html` directly, or serve it with any static file server (e.g., `npx serve .` or VS Code Live Server).
- **No npm install, no compilation, no bundler.**

## Architecture

The entire app lives in one file: `dayflow1_0.html` (~5600 lines). It contains:
1. `<head>`: CSS custom properties (design tokens) + all styles (~3350 lines)
2. `<body>`: HTML structure for all screens and the auth screen
3. `<script>`: All JavaScript logic (~2000 lines)

Supabase is loaded via CDN: `<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2">`.

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
- Every mutation calls `persist()` (localStorage) and schedules a Supabase sync via `scheduleSync()` (debounced ~2s).

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
| Auth | `doLogin()`, `doSignup()`, `doLogout()`, `switchTab()` |
| Data | `load()`, `persist()`, `getDay()`, `activeHabits()`, `calcPct()` |
| Supabase sync | `sbSaveHabits()`, `sbLoadHabits()`, `sbSaveDay()`, `sbLoadDay()`, `sbLoadAllDays()`, `scheduleSync()` |
| Navigation | `goScreen()`, `openModal()`, `closeModal()` |
| Calendario | `renderCalendario()`, `calBuildGrid()`, `renderCalStrip()`, `renderCalDay()`, `calLayoutEventi()`, `calSetDate()`, `updateCalNow()`, `openEventoModal()`, `saveEvento()`, `deleteEvento()`, `ensureEventi()`, `normalizeEvento()` |
| Analytics | `calcAvg()`, `weekDays()` |
| Discover | `renderDiscover()`, `generateFeed()`, `regenerateFeed()`, `expandArticle()`, `openFeedChat()`, `sendFeedChat()`, `openFeedSheet()`, `geminiRequest()`, `geminiStream()`, `streamArticle()`, `parseArticleText()` |
| Utils | `todayStr()`, `uid()`, `fmtDate()`, `p2()`, `pctColor()`, `heatColor()` |

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

- Model `gemini-2.5-flash` via REST `generateContent`; the API key goes in the `x-goog-api-key` header, never in the URL.
- API key lives only in `localStorage` (`dayflow_gemini_key`). Topics in `dayflow_feed_topics`, mirrored to `profiles.feed_topics` with a silent fallback if the column does not exist.
- Daily cache `dayflow_feed_YYYY-MM-DD` = `{ generatedAt, topicIds, cards[], stale }`; older keys are pruned on load. Expanded articles are stored inside `cards[i].fullArticle` (`{ title, sections: [{ heading, paragraphs[] }] }`; `heading` may be `''`).
- Article streaming: `expandArticle()` → `streamArticle()` uses `geminiStream(body, onChunk, { signal })` (endpoint `:streamGenerateContent?alt=sse`, fetch reader + `TextDecoder` + `createSSEParser()`, same error codes as `geminiRequest`, plus `code: 'abort'`; `thinkingBudget: 0` for faster first token). The model writes plain text: line 1 title, blank line, `## Subheading`, paragraphs separated by blank lines; `parseArticleText(text, final)` parses it incrementally and `paintArticleStream()` updates the DOM per block via `textContent` (rAF-throttled, no full re-render, blinking `.art-tail` cursor). `fullArticle` is saved only when the stream completes with `STOP` (`finishReason: MAX_TOKENS` → `code: 'truncated'`, shown as "Articolo interrotto" + Riprova; article request sets `maxOutputTokens: 3072`). On completion the card is looked up by id in the current `FEED.data` (the feed may have been regenerated meanwhile) before `saveFeedCache`, then `syncFeedSaved`; closing the sheet or opening another card calls `abortArticleStream()` and nothing is saved. Mid-stream errors keep the partial text (`FEED.articlePartial`, memory only) with the error and a "Riprova" button. The chat still uses the non-streaming `geminiText()`.
- Feed behaves like a reel: pull-to-refresh on the first card (touch drag, or mouse wheel up at the top on desktop) calls `regenerateFeed()`; the last slide (`#disc-end`) is watched by an IntersectionObserver and triggers `loadMoreFeed()`, which appends `FEED_CARDS_N` cards via `fetchFeedCards()` without resetting scroll (`overflow-anchor: none` on `.feed`). With a topic chip active, load-more generates only for that topic.
- Dedupe: every generated title is stored in `localStorage` `dayflow_feed_seen` (`[{ t, ts, topicId }]`, 72h TTL, capped at 300) and the last 80 are sent to Gemini as an exclusion list; exact duplicates are also filtered client-side. Settings sheet shows the count and a "Dimentica tutto" button.
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
- **Navigation**: tap a day in the strip, ‹ › arrows shift a week, `calGoToday()`, horizontal swipe on the timeline shifts one day and on the strip one week. `.cal-scroll` is `touch-action: pan-y` so a horizontal drag never moves the screen carousel.
- **Events**: tap an empty slot (rounded to 30 min) or the FAB to create, tap a block to edit. The editor reuses `#modal-overlay` (`openEventoModal` / `renderEventoModal` / `saveEvento` / `deleteEvento`), state in `evDraft`.
- `normalizeEvento()` migrates legacy events: missing `durata` → 60 min, missing or malformed `ora` → `tuttoIlGiorno`. `ensureEventi()` runs from `ensureSlotArrays()`, so every day read through `getDay()` is normalized.
- Events do **not** feed `calcPct()`; progress still comes from habits, daily tasks and recurring commitments.

## Specifications

`istruzioni.txt` contains the full feature spec in Italian — data structures, calculation formulas, UX rules, and the release roadmap. Read it when implementing features related to skip logic, progress calculation, or analytics.
