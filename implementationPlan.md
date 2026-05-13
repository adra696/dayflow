# Roadmap Miglioramenti DayFlow

Analisi completa di `dayflow1_0.html`. Miglioramenti ordinati per impatto/sforzo.

---

## Priorità ALTA — Bug reali

### 1. Tag HTML malformato
```html
<!-- ATTUALE (bug) -->
<button class="logout-btn" onclick="doLogout()">esci</button></output>
<!-- CORRETTO -->
<button class="logout-btn" onclick="doLogout()">esci</button>
```
`</output>` spurio → bug DOM silenzioso.

### 2. Validazione form abitudini
`submitForm()` non blocca se il nome è vuoto/solo spazi.  
Fix: `if (!nome.trim()) return` prima di salvare.

### 3. Password reset mancante
Auth screen ha solo login/signup, nessun "Password dimenticata?".  
Supabase supporta `resetPasswordForEmail()`. Urgenza bassa (app personale) ma se perdi l'accesso non c'è recupero.

### 4. Timeout di rete silenzioso
`withTimeout()` scade senza alcun feedback visivo.  
Fix: toast "Sync fallito, riprovo…" quando il timeout scatta.

---

## Priorità ALTA — Streak (feature mancante più impattante)

Per utenti ADHD, vedere "7 giorni consecutivi" è più motivante della % media mensile.

**Da fare:**
- Calcola streak corrente da `S.days` (giorni consecutivi con `calcPct() >= 1`)
- Mostrala in `#screen-oggi` vicino alla barra progresso (es. `🔥 5`)
- Confetti/celebrazione al completamento se streak > soglia
- Mostrala anche nell'header di `#screen-analytics`

**Funzioni da estendere:** `calcPct()`, `renderOggi()`, `renderAnalytics()`

---

## Priorità MEDIA — UX e logica

### 5. Task giornaliere: completamento tutto-o-niente
`attivitaDelGiorno.completato` è un singolo `boolean` per 3 task → tutte e 3 valgono 1 punto.  
Miglioramento: `completato: [false, false, false]` → 3 punti separati nel progresso.  
⚠️ Richiede migrazione dati esistenti.

### 6. Analytics: indicatore trend
Storico mostra media settimanale/mensile ma non dice se stai migliorando.  
Fix: freccia ↑↓→ confrontando settimana corrente vs precedente.

### 7. Sezione AI nel Riepilogo
Attualmente placeholder statico ("Work in progress").  
Opzioni:
- **Senza AI**: array di frasi motivazionali randomiche
- **Con AI**: Claude API per riassunto della giornata basato su note + % completamento

### 8. Note non visibili nell'Analytics
Note serali di `#screen-recap` non appaiono nel popup dell'heatmap.  
Fix: aggiungere `day.note` nel popup del calendario (`renderHeatmap()`).

---

## Priorità BASSA — Qualità codice

### 9. `activeHabits()` chiamata 10+ volte per render
Filtra `S.habits` ad ogni chiamata senza caching.  
Fix: variabile locale `const habits = activeHabits()` all'inizio di ogni funzione di render.

### 10. Re-render completo ad ogni navigazione
`goScreen()` ricostruisce l'intera lista da zero.  
Non percettibile con 5-10 abitudini, ma pattern da tenere a mente.

---

## Funzioni chiave

| Funzione | Dove | Note |
|----------|------|------|
| `calcPct(ds)` | `#screen-oggi` | Base per streak: iterare S.days a ritroso |
| `renderOggi()` | `#screen-oggi` | Inserire display streak |
| `renderHeatmap()` | `#screen-analytics` | Già costruisce popup — aggiungere note |
| `submitForm()` | modal abitudini | Aggiungere validazione nome vuoto |
| `scheduleSync()` / `withTimeout()` | sync | Aggiungere feedback su timeout |
