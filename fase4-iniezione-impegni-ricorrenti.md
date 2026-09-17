# Fase 4 — Iniezione impegni ricorrenti nei giorni

## Obiettivo

Gli impegni ricorrenti configurati in `S.impegniRicorrenti[]` (fase 3) devono apparire come righe automatiche in Pianifica e Oggi sui giorni della settimana corrispondenti, essere completabili, e contare nella percentuale giornaliera.

Stato attuale (post fase 3): array `S.impegniRicorrenti[]` esiste, CRUD funzionante, ma nessuna integrazione runtime nei giorni.

## Schema dati

### Esteso: day record

```js
S.days["YYYY-MM-DD"] = {
  ...esistenti,
  impegniRicorrentiCompletati: { [recId]: true }   // NEW, sparso
}
```

Solo gli ID degli impegni completati per quel giorno appaiono come chiavi. Assenza = non completato.

### Lettura

`S.impegniRicorrenti` esistente:
```js
{ id, titolo, ora?, giorniSettimana: number[1..7], ordine, attivo }
```

ISO weekday: 1=lun, 2=mar, ..., 7=dom.

## File touchpoints

Tutto in `dayflow1_0.html` (numeri linea post-fase 3).

| Linea/funzione | Cosa toccare |
|---|---|
| `getDay` 2763 | Inizializzare `impegniRicorrentiCompletati: {}` se mancante |
| `ensureSlotArrays` ~2766 | Aggiungere normalizzazione `impegniRicorrentiCompletati` |
| Nuova util | `isoDow(ds)` → ritorna 1..7 da stringa data |
| Nuova util | `getImpegniDelGiorno(ds)` → filtra `S.impegniRicorrenti` per dow + ordina |
| `calcPct` 2791 | Aggiungere impegni del giorno a `total` e `done` |
| `renderTaskInputs` 3103 | Dopo loop compiti, appendere righe read-only per ogni ricorrente del dow |
| `renderHOggiList` 3206 | Iniettare righe ricorrenti (UI simile a habit ma con badge "🔁") |
| `renderRecap` 3277 | Riga summary per ogni impegno ricorrente del giorno |
| `renderHeatmap` 3325 | (opzionale, può andare in fase 5) badge se giorno ha ricorrenti |
| `showPopup` 3351 | Sezione "Impegni ricorrenti" del giorno con checkbox toggle |

## Implementazione step-by-step

### Step 1 — Utils base

Aggiungere subito dopo `ensureSlotArrays` / `atdDoneCount`:

```js
function isoDow(ds) {
  // 'YYYY-MM-DD' → 1..7 (lun..dom)
  const d = new Date(ds + 'T12:00:00');
  const js = d.getDay();       // 0=dom .. 6=sab
  return js === 0 ? 7 : js;    // 1..7 ISO
}

function getImpegniDelGiorno(ds) {
  const dow = isoDow(ds);
  return (S.impegniRicorrenti || [])
    .filter(r => r.attivo !== false && Array.isArray(r.giorniSettimana) && r.giorniSettimana.includes(dow))
    .slice()
    .sort((a, b) => (a.ordine || 0) - (b.ordine || 0));
}
```

### Step 2 — `getDay` + `ensureSlotArrays`

In `getDay` default record aggiungere `impegniRicorrentiCompletati: {}`.

In `ensureSlotArrays` (o un altro ensure separato) aggiungere all'inizio:

```js
if (!day.impegniRicorrentiCompletati || typeof day.impegniRicorrentiCompletati !== 'object') {
  day.impegniRicorrentiCompletati = {};
}
```

### Step 3 — `calcPct`

Patch finale prima del `return`:

```js
const imp = getImpegniDelGiorno(ds);
total += imp.length;
imp.forEach(r => { if (day.impegniRicorrentiCompletati[r.id]) done++; });
```

Verifica: % corretta con 1 abitudine + 3 task + 2 ricorrenti.

### Step 4 — `renderTaskInputs` (Pianifica)

Dopo il loop sui compiti e prima del bottone `+ aggiungi slot`, appendere sezione separata:

```js
const impegni = getImpegniDelGiorno(today);
if (impegni.length) {
  const sep = document.createElement('div');
  sep.className = 'plan-impegni-sep';
  sep.textContent = '— Impegni ricorrenti di oggi —';
  c.appendChild(sep);
  impegni.forEach(r => {
    const row = document.createElement('div');
    row.className = 'plan-task plan-impegno';
    const num = document.createElement('span'); num.className = 'plan-num'; num.textContent = '🔁';
    const lbl = document.createElement('div'); lbl.className = 'plan-impegno-lbl';
    lbl.textContent = r.titolo + (r.ora ? ` · ${r.ora}` : '');
    row.appendChild(num); row.appendChild(lbl);
    c.appendChild(row);
  });
}
```

Note: read-only in Pianifica (no checkbox, niente priorità). Solo info.

### Step 5 — `renderHOggiList` (Oggi)

Dopo il loop habits e prima della tasks-row, iniettare righe ricorrenti come habit-like:

```js
const impegni = getImpegniDelGiorno(today);
impegni.forEach(r => {
  const completato = !!day.impegniRicorrentiCompletati[r.id];
  const row = document.createElement('div');
  row.className = 'habit-row impegno-row' + (focusMode && completato ? ' done-hidden' : '');
  row.onclick = e => {
    if (e.pointerType === 'touch') return;
    addRipple(row, e);
    const d = getDay(today);
    d.impegniRicorrentiCompletati[r.id] = !d.impegniRicorrentiCompletati[r.id];
    if (!d.impegniRicorrentiCompletati[r.id]) delete d.impegniRicorrentiCompletati[r.id];
    scheduleSync(today, 'sd-oggi', 'st-oggi-sync');
    renderHOggiList(getDay(today), today);
    updateOggiStats(today);
  };
  const fill = document.createElement('div'); fill.className = 'hold-fill'; row.prepend(fill);
  setupRowGestures(row, () => {
    const d = getDay(today);
    d.impegniRicorrentiCompletati[r.id] = !d.impegniRicorrentiCompletati[r.id];
    if (!d.impegniRicorrentiCompletati[r.id]) delete d.impegniRicorrentiCompletati[r.id];
    scheduleSync(today, 'sd-oggi', 'st-oggi-sync');
    renderHOggiList(getDay(today), today);
    updateOggiStats(today);
  }, null);
  const chk = document.createElement('div'); chk.className = 'hcheck' + (completato ? ' done' : '');
  chk.innerHTML = '<svg viewBox="0 0 11 11" fill="none" stroke="#080808" stroke-width="2.5" stroke-linecap="round"><polyline points="1.5,5.5 4.5,8.5 9.5,2.5"/></svg>';
  const nm = document.createElement('span'); nm.className = 'hname' + (completato ? ' done' : '');
  nm.textContent = r.titolo;
  const badge = document.createElement('span'); badge.className = 'impegno-badge'; badge.textContent = '🔁';
  row.appendChild(chk); row.appendChild(nm); row.appendChild(badge);
  if (r.ora) {
    const ora = document.createElement('span'); ora.className = 'impegno-ora'; ora.textContent = r.ora;
    row.appendChild(ora);
  }
  c.appendChild(row);
});
```

Aggiornare anche `habit-count-lbl` per includere impegni:

```js
const totHab = habits.length + impegni.length;
const doneHab = habits.filter(h => day.abitudini[h.id]?.completato).length
             + impegni.filter(r => day.impegniRicorrentiCompletati[r.id]).length;
document.getElementById('habit-count-lbl').textContent = `Abitudini — ${doneHab}/${totHab}`;
```

(O cambia label a "Routine" se preferito.)

### Step 6 — `renderRecap`

Dopo il loop habits e prima della riga "Attività del giorno":

```js
const impegni = getImpegniDelGiorno(selectedDate);
impegni.forEach(r => {
  const completato = !!day.impegniRicorrentiCompletati[r.id];
  const row = document.createElement('div'); row.className = 'sum-row';
  const icon = document.createElement('div');
  icon.className = 'sum-icon ' + (completato ? 'ok' : 'ko');
  icon.innerHTML = completato
    ? '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="3" fill="none"><polyline points="20 6 9 17 4 12"/></svg>'
    : '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="3" fill="none"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  const nm = document.createElement('span'); nm.className = 'sum-name';
  nm.textContent = '🔁 ' + r.titolo + (r.ora ? ` · ${r.ora}` : '');
  const badge = document.createElement('span'); badge.className = 'sum-badge ' + (completato ? 'bd' : 'bm');
  badge.textContent = completato ? 'completato' : 'mancato';
  row.appendChild(icon); row.appendChild(nm); row.appendChild(badge);
  list.appendChild(row);
});
```

### Step 7 — `showPopup` (Calendario, popup giorno)

Dopo la sezione `compiti`, prima di `eventi`, aggiungere:

```js
const impegniPop = getImpegniDelGiorno(ds);
if (impegniPop.length) {
  const iTitle = document.createElement('div'); iTitle.className = 'dp-sec-title';
  iTitle.textContent = 'Impegni ricorrenti:';
  popup.appendChild(iTitle);
  impegniPop.forEach(r => {
    const item = document.createElement('div'); item.className = 'dp-item';
    const chk = document.createElement('div');
    const completato = !!day.impegniRicorrentiCompletati[r.id];
    chk.className = 'dp-check' + (completato ? ' done' : '');
    chk.onclick = (e) => {
      e.stopPropagation();
      const d = getDay(ds);
      d.impegniRicorrentiCompletati[r.id] = !d.impegniRicorrentiCompletati[r.id];
      if (!d.impegniRicorrentiCompletati[r.id]) delete d.impegniRicorrentiCompletati[r.id];
      scheduleSync(ds, 'sd-an', 'st-an-sync');
      showPopup(ds, cell, ev);
      renderHeatmap();
    };
    const txt = document.createElement('span');
    txt.textContent = r.titolo + (r.ora ? ` · ${r.ora}` : '');
    item.appendChild(chk); item.appendChild(txt);
    popup.appendChild(item);
  });
}
```

## CSS da aggiungere

Vicino a `.habit-row` / `.plan-task`:

```css
.plan-impegni-sep {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text3);
  letter-spacing: .12em;
  text-transform: uppercase;
  padding: 16px 20px 8px;
  border-bottom: 1px solid var(--border)
}

.plan-impegno {
  background: rgba(16, 185, 129, 0.04)
}

.plan-impegno-lbl {
  flex: 1;
  font-family: var(--sans);
  font-size: 15px;
  color: var(--text2)
}

.impegno-row {
  background: linear-gradient(to right, rgba(16, 185, 129, 0.04), transparent)
}

.impegno-badge {
  font-size: 11px;
  margin-left: auto;
  opacity: 0.7
}

.impegno-ora {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text3);
  margin-left: 8px
}

.dp-check {
  width: 16px;
  height: 16px;
  border-radius: 4px;
  border: 1.5px solid var(--border3);
  cursor: pointer;
  flex-shrink: 0
}

.dp-check.done {
  background: var(--green);
  border-color: var(--green)
}
```

Desktop responsive: padding-left/right 40px sul separatore se necessario, aggiungere `.plan-impegno` al blocco selettori in `@media` per coerenza con `.plan-task`.

## Edge cases

- **Giorno senza ricorrenti**: tutti i loop ritornano array vuoto, nessun render extra. OK.
- **`impegniRicorrentiCompletati` mancante in day vecchio**: `ensureSlotArrays` lo inizializza. Lettura sicura con `||`.
- **Modifica giorni settimana di un ricorrente**: i check sui giorni passati restano (mostrati solo nei nuovi popup se il dow ancora include). Da specificare in fase 5.
- **Eliminazione ricorrente**: `impegniRicorrentiCompletati[r.id]` resta nei day record ma non viene mai più letto. Acceptable, niente cleanup necessario.
- **Streak**: `calcStreak` usa `calcPct(ds) >= soglia`. Con ricorrenti che contano, streak può diventare più severo (più item da completare). Verificare se vogliamo eccezione o accettare.
- **Sync race**: toggle su Oggi → `scheduleSync` salva tutto il day record. `impegniRicorrentiCompletati` parte del payload `attivita_del_giorno`? No — campo top-level. Vedi step 8.

### Step 8 — Sync Supabase day

In `sbSaveDay`:
```js
await sb.from('days').upsert({
  user_id: curUser.id,
  data: ds,
  abitudini: day.abitudini,
  attivita_del_giorno: day.attivitaDelGiorno,
  impegni_ricorrenti_completati: day.impegniRicorrentiCompletati || {},  // NEW
  note: day.note || '',
  timestamp: day.timestamp || Date.now()
}, { onConflict: 'user_id,data' });
```

In `sbLoadDay` / `sbLoadAllDays`:
```js
return {
  ...esistente,
  impegniRicorrentiCompletati: data.impegni_ricorrenti_completati || {}
};
```

**Step Supabase preliminare** (manuale):
```sql
alter table days add column if not exists impegni_ricorrenti_completati jsonb default '{}'::jsonb;
```

Eseguire prima del merge fase 4.

## Verifica end-to-end

1. Creare impegno "Palestra" L M V 19:00 (fase 3, già fatto).
2. Aprire Pianifica oggi (se oggi ∈ {L,M,V}): sezione "Impegni ricorrenti di oggi" mostra "🔁 Palestra · 19:00".
3. Oggi: riga "Palestra" appare nella lista habits con badge 🔁 e ora. Tap → check verde.
4. Ring % aumenta (1 item su totale).
5. Recap stesso giorno: riga summary "🔁 Palestra · 19:00 — completato".
6. Calendario heatmap → click giorno futuro che è L/M/V → popup mostra "Impegni ricorrenti: Palestra · 19:00" con check toggleabile.
7. Hard refresh → check persiste (localStorage + Supabase).
8. Cambio dow del ricorrente (rimuovo V): giorni venerdì futuri NON mostrano più Palestra. Giorni venerdì passati con check già fatto mantengono lo storico nel DB ma UI non lo renderizza (acceptable).
9. Elimina ricorrente: sparisce ovunque.

## Risk note

- **DB migration**: senza colonna nuova su `days`, errore Supabase su save. Eseguire SQL prima.
- **Carico render**: con 10+ ricorrenti su giorno, lista Oggi cresce. Acceptable.
- **Streak**: ricalibrazione possibile se utente nota drop. Da rivalutare dopo test.
- **Mobile gesture**: hold-to-check su impegno_row riusa `setupRowGestures`. Verificare che pointer events non si sovrappongano a habit-row gestures.
