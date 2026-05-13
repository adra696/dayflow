# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**DayFlow** is an ADHD-focused habit tracker and daily task manager. Design principles: radical simplicity, no guilt, low friction. The UI language is Italian.

## Running the App

No build step. The entire app is a single self-contained file:

- **Open in browser**: Open `dayflow1_0.html` directly, or serve it with any static file server (e.g., `npx serve .` or VS Code Live Server).
- **No npm install, no compilation, no bundler.**

## Architecture

The entire app lives in one file: `dayflow1_0.html` (~850 lines). It contains:
1. `<head>`: CSS custom properties (design tokens) + all styles (~450 lines)
2. `<body>`: HTML structure for all screens and the auth screen
3. `<script>`: All JavaScript logic (~400 lines)

Supabase is loaded via CDN: `<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2">`.

### Four Screens (tabs)

| Screen ID | Nav label | Purpose |
|---|---|---|
| `#screen-plan` | Pianifica | Morning: set 3 daily tasks + review habits |
| `#screen-oggi` | Oggi | Dashboard: check off habits, progress bar, stats |
| `#screen-recap` | Riepilogo | Evening: summary + free notes + AI placeholder |
| `#screen-analytics` | Storico | Monthly heatmap + weekly/monthly averages |

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
| Analytics | `calcAvg()`, `weekDays()`, `monthDays()`, heatmap rendering |
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

## Specifications

`istruzioni.txt` contains the full feature spec in Italian — data structures, calculation formulas, UX rules, and the release roadmap. Read it when implementing features related to skip logic, progress calculation, or analytics.
