# DayFlow — Implementazione nuove funzionalità

## Scope
- Navigazione multi-giorno su tutte le schermate
- Storico → Calendario con gestione impegni/scadenze
- Claude AI rimandato a una fase successiva

---

## Modulo 1 — Navigazione multi-giorno

### Obiettivo
Permettere all'utente di navigare a giorni precedenti e futuri in tutte le schermate (Pianifica, Oggi, Riepilogo), modificando e salvando dati per qualunque giorno.

### Variabili globali da aggiungere
- `selectedDate` — stringa `YYYY-MM-DD`, inizializzata a oggi al caricamento

### Nuove funzioni da aggiungere
- `setSelectedDate(ds)` — aggiorna `selectedDate` e re-renderizza la schermata corrente
- `offsetDate(ds, giorni)` — restituisce la data offset di N giorni rispetto a `ds`
- `renderDateNavHeader(ds, containerId)` — inserisce le frecce ← → con la data corrente nel contenitore indicato; freccia destra disabilitata se `ds` è oggi o nel futuro (opzionale)

### Modifiche a funzioni esistenti
- `renderPlan()` — sostituire `todayStr()` con `selectedDate`; chiamare `renderDateNavHeader` in testa
- `renderOggi()` — stessa sostituzione; aggiungere nav header
- `renderRecap()` — stessa sostituzione; aggiungere nav header
- `saveNotes()` — sostituire le due chiamate hardcoded a `todayStr()` con `selectedDate`
- `goScreen(name)` — resettare `selectedDate` a oggi quando si cambia schermata

### Modifiche HTML
- Aggiungere un contenitore `div` per la date nav in ciascuna delle tre schermate (Pianifica, Oggi, Riepilogo), che sostituisce o affianca il topbar-date attuale

### CSS da aggiungere
- `.date-nav` — layout flex con frecce e data centrata
- `.date-nav-arrow` — stile frecce (può riutilizzare `.hm-arrow` esistente)
- `.date-nav-label` — stile data centrale; badge "oggi" se `ds === todayStr()`

### Compatibilità dati
Nessuna migrazione necessaria. `getDay(ds)`, `scheduleSync(ds,...)` e `sbSaveDay(ds,...)` sono già parametrizzati per date arbitrarie.

---

## Modulo 2 — Calendario (rinomina + funzionalità)

### 2.1 Rinomina Storico → Calendario
- Label nav: `Storico` → `Calendario`
- Titolo screen: `Storico.` → `Calendario.`
- ID screen: `screen-analytics` → `screen-calendario` (aggiornare tutti i riferimenti)
- Funzione: `renderAnalytics()` → `renderCalendario()`
- Riferimenti in `goScreen()` aggiornati di conseguenza

### 2.2 Nuovo tipo di dato: Impegni/Scadenze
Aggiungere il campo `eventi` alla struttura di default in `getDay(ds)`.

Ogni evento ha:
- `id` — identificatore univoco
- `titolo` — testo libero
- `tipo` — `'impegno'` oppure `'scadenza'`
- `ora` — stringa `HH:MM` opzionale (null se tutto il giorno)
- `completato` — booleano

Tutti i lettori di `day.eventi` usano `day.eventi || []` per compatibilità con dati pre-esistenti.

### 2.3 Heatmap: badge eventi sulle celle
- `renderHeatmap()` aggiunge un piccolo pallino colorato sulle celle che hanno almeno un evento
- Colore: verde per impegno, arancio/rosso per scadenza
- Il badge è sovrapposto alla cella (posizione assoluta, angolo in alto a destra)

### 2.4 Popup giornaliero potenziato
Il popup attuale (`showPopup`) mostra solo stat + habit + note preview. Nuovo layout:

**Sezione 1 — Riepilogo**
- Data formattata, percentuale completamento, colore coerente

**Sezione 2 — Compiti del giorno**
- Lista dei 3 compiti (readonly nel popup)
- Pulsante "Vai al giorno" → `setSelectedDate(ds)` + `goScreen('plan')`

**Sezione 3 — Impegni e scadenze**
- Lista eventi del giorno con tipo e ora
- Form inline: campo testo titolo + select tipo (impegno/scadenza) + input ora opzionale + pulsante Aggiungi
- Ogni evento ha pulsante ✕ per eliminarlo
- Ogni modifica chiama `scheduleSync(ds, ...)` per salvare

### 2.5 Sezione "Prossimi impegni" sotto la heatmap
- Itera i prossimi 14 giorni a partire da oggi
- Mostra solo i giorni che hanno almeno un evento
- Ogni riga: data formattata + titolo evento + tipo (badge colorato)
- Click sulla riga → `setSelectedDate(ds)` + `goScreen('plan')`

### CSS da aggiungere
- `.evento-badge` — pallino piccolo sovrapposto alla cella heatmap
- `.evento-item` — riga evento nel popup (flex: tipo-badge | titolo | ora | ✕)
- `.evento-type-badge` — badge colorato tipo impegno/scadenza
- `.evento-form` — form inline aggiunta evento nel popup
- `.prossimi-wrap` — contenitore sezione prossimi impegni
- `.prossimi-row` — riga singolo impegno futuro

---

## Ordine di implementazione consigliato

1. **Modulo 1 completo** — navigazione date (prerequisito: `selectedDate`, `offsetDate`, `renderDateNavHeader`)
2. **2.1** — rinomina Storico → Calendario
3. **2.2** — struttura dati eventi in `getDay()`
4. **2.3** — badge heatmap
5. **2.4** — popup potenziato (la parte più complessa)
6. **2.5** — sezione prossimi impegni

---

## Verifica end-to-end

| Scenario | Atteso |
|----------|--------|
| Pianifica → click ← | Data retrocede di 1 giorno, task del giorno precedente caricati |
| Pianifica → inserire task per ieri → tornare ad oggi | Task ieri salvati, oggi non modificato |
| Oggi → navigare a 3 giorni fa → check habit | Habit salvato per quella data |
| Riepilogo → navigare → editare note | Note salvate per il giorno corretto |
| Calendario → click cella → "Vai al giorno" | Pianifica si apre con quella data |
| Calendario → aggiungere impegno → chiudere popup | Badge compare sulla cella |
| Sezione prossimi impegni | Mostra impegni futuri ordinati per data |
| Offline → navigare date → riaprire online | Dati sincronizzati (`pendingSync` esistente gestisce questo) |
