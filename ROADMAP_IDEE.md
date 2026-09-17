# 🚀 DayFlow — Roadmap Idee da Ridiscutere

> ⚠️ **IMPORTANTE**: Questo documento NON è un TODO list. Sono idee/direzioni da rivalutare dopo test reale dell'app. Da ridiscutere prima di qualsiasi implementazione.

---

## 📋 Sintesi della Discussione (13 maggio 2026)

### Background
- DayFlow è un ADHD habit tracker minimalista (single-file, Supabase, PWA)
- Attualmente ha 4 schermate: Pianifica, Oggi, Riepilogo, Storico
- Tutto sincronizzato cloud-first con fallback localStorage

---

## 🎯 Tre Pilastri Identificati

### **1️⃣ Claude Skill — Pianificazione Conversazionale**

**Idea**: Una skill in Cowork che permette di modificare DayFlow da chat Claude.

**Cosa potrebbe fare:**
```
User: "Claude, aggiungi meditazione alle mie abitudini"
User: "Pianifica una settimana equilibrata"
User: "Sposta tutti i task di martedì a mercoledì"
User: "Quante abitudini ho ora?"

Claude legge/modifica il database e aggiorna DayFlow
```

**Architettura richiesta:**
- Webhook/API middleware (Vercel function o Supabase Edge Function)
- Autenticazione token-based (non hardcode credenziali)
- RLS policies ben configurate su Supabase
- Sync bidirezionale: Claude → DB → DayFlow refresh

**Vincoli identificati:**
- Richiede backend esterno (Vercel free tier OK)
- Latency ~1-3 sec tra richiesta e visualizzazione
- Conflitti cloud↔local risolti da timestamp
- Scope: solo modifica dati, non UI/UX changes

**Status**: ⏸️ **Salta per ora** — dipende da priorità 3

---

### **2️⃣ Notifiche Push Mattutine**

**Idea**: Scheduled task che ogni mattina (9am) legge il database e invia reminder.

**Opzioni canali:**
| Metodo | Affidabilità | Latency | Setup | Note |
|--------|---|---|---|---|
| **Email** | ✅ 99% | +5min | Easy (Supabase Mail) | Non real-time ma sicuro |
| **Push browser** | ⚠️ ~70% | Real-time | Richiede PWA + Service Worker | Funziona solo se app in foreground |
| **Notifica Cowork** | ✅ Se Claude aperto | Real-time | MCP nativo | Vedi in chat quando apri |
| **SMS** | ✅ 99% | +2min | Twilio (+costi) | Garantito, costa |

**Vincolo critico:**
- Scheduled task Claude gira solo quando l'app è aperta
- **Non è un cronometratore di sistema**
- Per garanzie 9am precise → servizio esterno (Firebase, OneSignal, etc.)

**Status**: ⏸️ **Saltabile per ora** — priorità bassa

---

### **3️⃣ Frontend Migliorato**

**Questa è LA priorità.**

#### **Problemi generali (analisi codice, maggio 2026):**
- Tipografia microscopica ovunque: `section-label` 9px, `stat-lbl` 8px, `nav-label` 7px — illeggibile su mobile
- Sync-bar occupa riga intera tra topbar e contenuto → rumore visivo, spreca spazio
- `shell` max-width 520px → troppo stretto su desktop
- Gerarchia visiva piatta: tutte le sezioni hanno stesso peso visivo

#### **Direzione desiderata:**
- ✅ **Più spazioso** — padding, respiro visivo
- ✅ **Semplice & user-friendly** — no complessità
- ⛔ **No bolle** come Strike (per ora)

---

#### **Schermata PIANIFICA — problemi specifici:**

Layout attuale (dall'alto):
```
topbar → sync-bar → priority-banner → "Attività importanti" → 3 input flat → [Salva] → "Le tue abitudini" → lista habits
```

Problemi identificati:
- `plan-task` usa `background: rgba(24,24,27,0.2)` su sfondo `#000` → invisibili come input, sembrano righe di lista
- Toggle priorità = solo emoji 🔥 senza label → interazione non ovvia (ADHD!)
- Pulsante "Salva giornata" in mezzo alla pagina tra task e abitudini → confonde il layout
- Lista abitudini in fondo a Pianifica: scopo poco chiaro per l'utente (non si interagisce, è solo review)

Idee di redesign (da discutere):
- **Task come card unica**: raggruppare i 3 input in un container card con bg visibile, non 3 righe flat separate
- **Label "Alta priorità"** accanto all'emoji 🔥, almeno la prima volta (onboarding)
- **"Salva" sticky in basso** oppure spostato dopo le abitudini come azione finale di chiusura
- **Rinominare sezione habits** → "Rivedi le tue abitudini" con sottotitolo esplicativo (es. "gestisci dalla ⚙")

---

#### **Schermata CALENDARIO — problemi specifici:**

Layout attuale (dall'alto):
```
topbar → sync-bar → stats grid 3col → heatmap (nav+griglia+popup inline) → "Abitudini settimanali" → lista wh-row
```

Problemi identificati:
- Stats grid: HTML e CSS out of sync (`an-stat:first-child` ha border in CSS, ma HTML mette il border inline sul secondo elemento)
- `an-lbl` 9px uppercase mono → quasi invisibile
- Day popup è `position` dentro `.heatmap-wrap` nello scroll → clipping, jarring su mobile
- `wh-dot` 14×14px per le abitudini settimanali → tap target troppo piccolo
- Sezione "Abitudini settimanali" orphaned in fondo, poco contesto, difficile da trovare
- Nessun collegamento visivo tra cella heatmap e dettaglio giorno

Idee di redesign (da discutere):
- **Stats come 3 pill-card** colorate (verde/arancione/fuoco), non raw grid con label 9px
- **Day popup come bottom sheet** (fixed, slide-up) invece di floating inline nello scroll
- **wh-dot → cerchi 24px** con nome abitudine leggibile, non puntini anonimi
- **Gap heatmap 6px, border-radius 6px** (attuale: 4px/4px) → celle più distinte
- **Pulsante "Oggi"** nel nav heatmap per tornare velocemente al mese corrente
- **Sezione abitudini settimanali** spostata sopra la heatmap o integrata come tab switcher

---

#### **Idee cross-schermata (10 punti dalla sessione maggio 2026):**

**Calendario:**
1. Vista settimana con barre verticali (7 bar chart sotto heatmap) — `calcPct()` già esiste
2. Heatmap filtrabile per singola abitudine — selector sopra griglia
3. Popup giorno più ricco — aggiungere abitudini ✓/✗ e note (dati già in `S.days[ds]`)
4. Streak per singola abitudine — non solo streak globale
5. Grafico trend mensile — linea con media per settimana del mese

**Organizzazione:**
6. Task per giorni futuri da Pianifica — date picker per preparare task di domani/dopodomani
7. Categorie/gruppi abitudini — campo `categoria` opzionale, raggruppamento in "Oggi"
8. Task ricorrenti settimanali — slot precompilato automaticamente (es. "call lunedì")
9. Riordino priorità task inline in "Oggi" — long-press per portare in posizione 1
10. Review settimanale in Riepilogo — ogni domenica: recap settimana con stats per abitudine

---

#### **Non decidere adesso — TEST FIRST:**
Usare l'app 3-5 giorni, poi tornare con feedback concreto su quale schermata frustra di più.

**Status**: 🔴 **PRIORITÀ #1** — Da approfondire dopo test

---

## ❓ Domande Aperte da Esplorare

### Sul Frontend (prioritario):
- [ ] Quali elementi mancano o disorientano?
- [ ] Lo spacing attuale è il problema?
- [ ] Le interazioni (hold/swipe) sono scopribili?
- [ ] Che ordine logico ha senso per Oggi?
- [ ] Altre schermate aumenterebbero chiarezza?

### Su Claude Skill (dopo frontend):
- [ ] Quanto conversazionale? ("Pianifica settimana" vs "Aggiungi X a lunedì")
- [ ] Modifica solo dati strutturati o anche note libere?
- [ ] Accettabile latency 1-3 sec?
- [ ] Complessità backend sostenibile?

### Su Notifiche (later):
- [ ] Vale la pena per un'app solo personale?
- [ ] Email sufficiente o serve push real-time?
- [ ] Budget per SMS/servizi?

---

## 📌 Prossimi Step

1. **Usa l'app per 3-5 giorni** — Oggi, Pianifica, Recap, Storico
2. **Prendi note** sulla frustrazione:
   - Dove senti confusione?
   - Cosa cercheresti per primo ogni giorno?
   - Cosa manca nel feedback?
   - Interazioni che non capisci?
3. **Torna qui con feedback concreto** — ridiscutiamo architettura
4. **Poi decidi priorità:**
   - Solo frontend?
   - Frontend + Claude Skill?
   - Tutte e tre?

---

## 🎨 Design Inspiration

- **Strike** (habit tracker minimalista) — minimalism, clarity
- **Apple Health** — clean layout, progress ring
- **Notion** — spacious, breathing room
- **Todoist** — hierarchy, priority

---

## 💾 Stato Implementazione

| Feature | Status | Sforzo | Note |
|---------|--------|--------|------|
| Frontend UX | 🔴 Analysis phase | ? | Test required |
| Claude Skill | 🔵 Design phase | 2-3h | Backend needed |
| Notifiche | 🟢 Idea | 1-2h | Can skip |
| Notion sync | 🟢 Idea | TBD | Nice-to-have |

---

**Last updated**: 13 maggio 2026  
**Next review**: After 3-5 days of real usage
