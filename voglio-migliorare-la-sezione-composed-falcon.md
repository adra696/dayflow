# Piano: Calendario funzionale — impegni ricorrenti + pianificazione futura

## Context

DayFlow oggi gestisce solo il giorno corrente in modo editabile. La schermata Pianifica/Oggi è bloccata su `todayStr()` (freccia avanti disabilitata, `goScreen` resetta `selectedDate` ad ogni cambio schermo). La sezione Calendario ha già un sistema `eventi[]` per impegno/scadenza one-off ma:

1. **Manca ricorrenza**: per fissare "palestra ogni lunedì" l'utente dovrebbe ricreare l'evento ogni settimana
2. **Manca pianificazione futura**: non si può preparare i 3 task di domani da Pianifica/Oggi
3. **3 slot hard-coded**: l'utente non può aggiungere/rimuovere slot del giorno

Obiettivo: trasformare Calendario da view storica a strumento di pianificazione, con impegni ricorrenti settimanali che si auto-iniettano nei giorni giusti e libertà di scrivere tasks per qualsiasi data.

## Decisioni di design (confermate)

- Impegni ricorrenti riempiono **slot del giorno** (compaiono insieme ai 3 task come task del giorno)
- **N task per giorno variabile** (default 3, l'utente può aggiungere/rimuovere)
- Pianificazione futura abilitata in **Plan + Oggi + Calendario**
- Persistenza: nuovo array globale `S.impegniRicorrenti[]` salvato in `profiles` Supabase, merge a runtime (no materializzazione in `S.days`)
- Impegni ricorrenti **contano nel calcolo %** con flag `completato` per giorno

## Schema dati

### Nuovo: ricorrenti globali
```js
S.impegniRicorrenti = [{
  id, titolo, ora?,
  giorniSettimana: number[],   // 1=lun .. 7=dom (ISO)
  ordine, attivo                // attivo per disabilitare senza cancellare
}]
```

### Esteso: day record
```js
attivitaDelGiorno = {
  compiti: string[],             // variabile, non più fisso a 3
  altaPriorita: boolean[],       // length === compiti.length
  completatiTask: boolean[],     // length === compiti.length, NEW
  // DEPRECATED ma mantenuti per back-compat read: completato, completatiCount
},
impegniRicorrentiCompletati: { [recId]: true }  // NEW, sparso (solo i completati)
```

### Migration (read path)
- Se `completatiTask` mancante e `compiti.length === 3`: derivare da `completatiCount` distribuendolo sui primi N task non vuoti
- Scrivere shape nuovo alla prima modifica

## File touchpoints

Tutto in `C:\Users\andre\Desktop\DayFlow\dayflow1_0.html` (single-file app).

| Range linee | Cosa toccare |
|---|---|
| 2547-2548 | Stato globale: aggiungere `S.impegniRicorrenti` init (in `load` + default) |
| 2566-2583 | `renderDateNavHeader` — rimuovere disable freccia destra |
| 2588 | `getDay` — aggiungere `impegniRicorrentiCompletati: {}` e migration di `completatiTask` |
| 2590 | `calcPct` — includere impegni ricorrenti del giorno + task variabili |
| 2592 | `calcAvg`/relativo flusso — escludere giorni futuri dalle medie |
| 2878-2889 | `goScreen` — non resettare `selectedDate` se chiamato con keep flag |
| 2891-2921 | `renderPlan` / `renderTaskInputs` — supporto N slot + render impegni ricorrenti del dow |
| 2924-2947 | `renderOggi` — abilitare future, filtrare stats |
| 2974-3046 | `renderHOggiList` — render righe impegni ricorrenti accanto a habit |
| 3047-3074 | `renderCalendario` — pulsante "Gestione impegni ricorrenti" |
| 3102-3183 | `showPopup` calendario — `gotoBtn` deve preservare `selectedDate` |
| 3185-3222 | `renderProssimi` — preservare `selectedDate` su click row |
| 3230-3291 | Modale Gestione abitudini — clonare per nuova modale "Impegni ricorrenti" |
| `sbSaveHabits` / `sbLoadHabits` | Includere `impegniRicorrenti` nel payload profiles |

## Fasi implementative

### Fase 1 — Sblocco navigazione futura
Goal: poter selezionare qualsiasi data dalla freccia destra senza altri cambiamenti.

- `renderDateNavHeader` linea 2578: togliere `disabled` e abilitare `onclick` per `ds >= today`
- `goScreen` linea 2884: aggiungere parametro `keepDate=false`; se `false` reset come prima
- `showPopup` "Vai al giorno" (3125) e `renderProssimi` row click (3207): chiamare `goScreen('plan', true)`
- `calcAvg`/`renderOggi` stats: filtrare `ds > todayStr()` da `weekDays`/`monthDays` quando passati a `calcAvg`

**Verifica**: aprire Pianifica, freccia destra avanza a domani; scrivere 3 task; tornare a oggi, i task di domani persistono nel localStorage; medie settimanali ignorano il giorno futuro.

### Fase 2 — Task del giorno con N slot variabile
Goal: utente aggiunge/rimuove slot, schema retrocompatibile.

- Estendere `getDay` (2588): inizializzare `completatiTask: [false, false, false]` se mancante; lasciare `compiti`/`altaPriorita` array di lunghezza variabile
- Migration read-only in `calcPct` (2590): se `completatiTask` mancante derivare da `completatiCount`
- `renderTaskInputs` (2898): loop dinamico su `day.attivitaDelGiorno.compiti.length` + bottone `+` (aggiungi slot, push `''` su tutte le 3 array) + bottone `🗑` su ogni riga (splice index, min 1 slot)
- `calcPct` (2590): cambiare il segmento "task del giorno" → ora `compiti.filter(non vuoto).length` voci, ognuna conta `completatiTask[i] ? 1 : 0`
- Rimuovere uso di `completato` e `completatiCount` dai nuovi scritti (lasciare lettura per back-compat)
- Aggiornare `renderHOggiList` se mostra contatore task

**Verifica**: aggiungere 5 slot, completarne 3, % giornaliera corretta; ricaricare → persiste; aprire un giorno vecchio che non ha `completatiTask` → non crasha, mostra dato pre-migration.

### Fase 3 — Schema + CRUD impegni ricorrenti
Goal: nuovo array `S.impegniRicorrenti` con UI gestione, senza ancora effetti sui giorni.

- `S` init (2544): aggiungere `impegniRicorrenti: []`
- `load`/`persist` (2586-2587): auto-incluso (JSON full)
- `sbSaveHabits`/`sbLoadHabits`: estendere payload profiles per includere `impegni_ricorrenti` (verificare schema tabella Supabase; aggiungere colonna `impegni_ricorrenti jsonb` se manca — comunicare all'utente prima del migration su DB)
- Nuova modale "Gestione impegni ricorrenti" clonando struttura da `renderModal` (3230) / `renderModalList` (3238) / `renderModalForm` (3270):
  - Form fields: nome, ora (time picker opzionale), checkbox giorni settimana (L M M G V S D), bottone elimina
  - List view con drag&drop ordine (riuso pattern habit)
- Pulsante apertura modale in Calendario (sopra heatmap o accanto a "Abitudini settimanali" sezione 2479)

**Verifica**: creare "Palestra lun/mer/ven 19:00", chiudere modale, riaprire, persiste su localStorage; logout/login → ricaricato da Supabase.

### Fase 4 — Iniezione impegni ricorrenti nel giorno
Goal: gli impegni del dow appaiono come slot extra in Pianifica/Oggi, checkabili, contano nella %.

- Util nuova `getImpegniDelGiorno(ds)`: ritorna `S.impegniRicorrenti.filter(r => r.attivo && r.giorniSettimana.includes(isoDow(ds)))` ordinati per `ordine`
- `renderTaskInputs` (2898): dopo il loop sui compiti manuali, appendere righe per ogni impegno ricorrente del dow — riga read-only label (con badge "🔁 ricorrente" e ora), checkbox toggle, no priority button (default no), no input testo
- Toggle salva in `day.impegniRicorrentiCompletati[rec.id] = true|false`
- `renderHOggiList` (2974): stessa iniezione (UI righe simili a habit ma con badge)
- `calcPct` (2590): aggiungere al totale e completati gli impegni del dow:
  ```
  const imp = getImpegniDelGiorno(ds);
  total += imp.length;
  imp.forEach(r => { if (day.impegniRicorrentiCompletati?.[r.id]) done++; });
  ```
- Heatmap: il `badge` esistente per `eventi` (3091) può estendersi a mostrare anche presenza ricorrenti (opzionale, fase 5)

**Verifica**: oggi è venerdì, "Palestra ven 19:00" appare in Pianifica/Oggi, check toggle conta nella ring %, riapro Pianifica e check persiste; cambio data a sabato, palestra non appare; modifico giorni del ricorrente (no più ven) → smette di apparire su giorni venerdì futuri.

### Fase 5 — Rifinitura UX
Goal: polish e edge case.

- Badge heatmap (3091) include impegni ricorrenti del dow oltre a `eventi`
- Popup `showPopup` (3102): sezione separata per impegni ricorrenti di quel giorno (read-only, con checkbox toggle che scrive in `impegniRicorrentiCompletati`)
- `renderProssimi` (3185): includere anche impegni ricorrenti dei prossimi 14 giorni
- Conferma eliminazione impegno ricorrente: warning "stai cancellando un impegno ripetuto — i check sui giorni passati restano"
- Empty state migliorato per Pianifica futura ("Nessun impegno ricorrente per questo giorno — scrivi i task manuali")

**Verifica**: heatmap mostra badge anche su giorni futuri con ricorrenti; lista prossimi impegni include "Palestra" per ogni lun/mer/ven futuri.

## Step Supabase preliminare (manuale, da fare prima della fase 3)

Tabella `profiles` deve avere colonna `impegni_ricorrenti jsonb default '[]'`. Sequenza:
```sql
alter table profiles add column if not exists impegni_ricorrenti jsonb default '[]'::jsonb;
```
Da eseguire dal pannello Supabase. Documentare prima di mergiare fase 3.

## Verifica end-to-end

1. Aprire `dayflow1_0.html` (Live Server o `npx serve .`)
2. Login con account test
3. Calendario → "Gestione impegni ricorrenti" → crea "Palestra L M V 19:00"
4. Pianifica freccia destra → domani → scrivere 2 task + impegno ricorrente visibile se domani ∈ {L,M,V}
5. Oggi → check tutti i task + impegno ricorrente → % = 100%
6. Calendario heatmap → click su un giorno futuro → popup mostra impegno ricorrente
7. Hard refresh → tutto persiste (localStorage + Supabase sync)
8. Logout → login da altro browser → dati ricaricati

## Rischi noti

- **Schema Supabase**: serve `alter table` manuale, errore in fase 3 se dimenticato
- **Migration `completatiTask`**: giorni vecchi senza il campo — `calcPct` deve avere fallback, altrimenti % errata
- **`completato` deprecato**: code path che lo legge ancora (cercare `.completato` su `attivitaDelGiorno`) → mappare a `completatiTask.every(Boolean)` durante migration
- **Variabilità slot in Recap**: la sezione Riepilogo (`renderRecap`) probabilmente itera su 3 compiti hard-coded — controllare e adattare
