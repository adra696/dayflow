# Handoff: DayFlow, redesign dell'algoritmo del feed Discover

## ISTRUZIONE PER LA NUOVA SESSIONE (leggere per prima)

La tua **prima risposta** a questo handoff deve essere **solo** la ripresentazione, quasi parola per parola, della sezione "RISPOSTA DA RIPRESENTARE" in fondo a questo file (struttura da fissare subito, cose modificabili dopo, bozza di algoritmo, 6 domande aperte). L'utente vuole ripartire da lì per discuterne. **Non scrivere codice e non avviare subagent** prima che l'utente abbia risposto alle domande.

Prima di rispondere leggi `CLAUDE.md` (architettura completa) e `js/discover.js`, in particolare `fetchFeedCards()` (~riga 561) e `streamArticle()` (~riga 740). Rispondi in italiano. L'utente usa lo stile "caveman" (risposte asciutte, niente preamboli).

## Contesto

DayFlow è un habit tracker personale per l'ADHD: PWA su GitHub Pages (https://adra696.github.io/dayflow/), installata su iPhone, UI in italiano, usata solo dall'autore. Stack: HTML, CSS e JS con ES modules, niente build; Supabase per auth e sync (tabelle `profiles`, `days`); Gemini per Discover (chiave oggi solo in `localStorage`). Service worker cache-first `dayflow-v20`: ogni rilascio deve alzare `CACHE`. Il repo è pulito su `main` (`c7b1240`).

Orchestrazione concordata (vedi `.claude/agents/`): Claude orchestra; `dayflow-implementer` (fable) implementa di default, `dayflow-builder` (opus) solo compiti meccanici con soluzione già scritta, `dayflow-verifier` (sonnet) verifica. Per i test in browser senza login: `_mock.html` + `_mock-supabase.js`, esclusi da git. Nel cloud potrebbero non esserci: vanno rigenerati da `index.html` sostituendo lo script CDN di Supabase con un mock.

## Problema emerso

L'utente trova le notizie di Discover "generiche e banali". Causa principale: il prompt in `fetchFeedCards()` chiede a Gemini notizie "recenti e verosimili" **senza alcun accesso al web**, quindi le notizie sono inventate e anche la testata indicata come fonte è di fantasia. Altre cause:
- ogni argomento è solo un'etichetta ("Tech", "Sport"), senza focus né esclusioni;
- nessuna selezione: Gemini genera 8 card e vengono mostrate tutte;
- nessun segnale negativo: `dayflow_feed_prefs` registra solo le aperture;
- temperatura 1.0.

## Proposte approvate dall'utente (tutte)

1. **Notizie vere**: Gemini con lo strumento `google_search`, fonte e link reali, articolo di approfondimento basato sulla fonte vera.
   - Da verificare con una prova: latenza, quota gratuita, e compatibilità tra ricerca e `responseSchema` sui modelli 2.5. Se non sono compatibili, va letto il JSON dal testo.
2. **Argomenti più ricchi**: focus, esclusioni, area (Italia/Europa/mondo), livello (divulgativo/tecnico). Creazione di argomenti a partire da una frase.
3. **Prompt con criteri di qualità, in due passaggi**: circa 20 candidate, poi selezione per specificità, novità e rilevanza. Tipi di contenuto misti. Per ogni notizia, "perché conta".
4. **Feedback esplicito**: 👍/👎, "meno notizie così", "di più su questo".
5. **Profilo di interessi**: testo sintetizzato da Gemini, modificabile nelle impostazioni.
6. **Generazione nel cloud** (proposta dall'utente):
   - Tabella Supabase `feed_items`, protetta con RLS.
   - Edge Function `generate-feed`: legge `profiles.feed_topics` e i titoli già visti, chiama Gemini con la ricerca, scrive le card.
   - `pg_cron` ogni mattina alle 6:00 (ora di Roma; il cron gira in UTC) genera circa 25 notizie.
   - L'app legge dalla tabella (apertura istantanea). Quando mancano 3–4 card chiede alla funzione, in background, un nuovo gruppo (l'app oggi anticipa già con `FEED_PREFETCH_AHEAD = 3`).
   - Chiave Gemini come segreto Supabase; la funzione verifica il JWT dell'utente.
   - Anche "già visti", interessi e feedback vanno spostati su Supabase.
   - Se la tabella è vuota o la funzione fallisce, l'app torna a generare dal client come oggi.
   - La pubblicazione della funzione la fa l'utente (dashboard o `supabase functions deploy`).

Ordine concordato:
1. Prova della ricerca con la chiave dell'utente.
2. Tabella, funzione, cron e prompt nuovo.
3. Il client legge dalla tabella e anticipa il caricamento.
4. Argomenti più ricchi, feedback e profilo.

Domande ancora aperte, poste prima della discussione sull'algoritmo:
- orario e quantità del mattino (proposta: 6:00, ~25 notizie; l'utente ha detto "vanno bene tutte le implementazioni proposte");
- se la Supabase CLI è installata o se si usa la dashboard.

## RISPOSTA DA RIPRESENTARE

### Risposta breve

**L'algoritmo si potrà cambiare velocemente in futuro, a patto di impostare adesso la struttura giusta.**

Il principio è separare due cose:
1. **Generazione.** Nel cloud Gemini raccoglie ogni mattina un **insieme ampio di notizie candidate** (circa 40), con molte informazioni per ciascuna.
2. **Selezione e ordinamento.** Una funzione a parte decide cosa mostrarti e in che ordine, pescando da quell'insieme.

Così cambiare l'algoritmo vuol dire modificare una funzione e un paio di pesi: effetto immediato, senza rigenerare niente. Se invece Gemini producesse direttamente il feed già ordinato, ogni cambio richiederebbe di rifare prompt e generazione, e ogni tentativo costerebbe un giorno di prove.

### Da decidere adesso (strutturale)

- **Le informazioni salvate per ogni notizia.** Oltre a titolo, riassunto, fonte e link:
  - argomento e sotto-argomento (ad esempio Tech → chip);
  - tag;
  - tipo di contenuto (notizia, analisi, curiosità, da tenere d'occhio);
  - data di pubblicazione vera;
  - un **voto di qualità** dato da Gemini: quanto è specifica, nuova e importante.

  Sono dati che l'algoritmo usa per scegliere. Se non li raccogli alla generazione, dopo non li hai.
- **Il registro delle interazioni, attivo dal primo giorno.** Per ogni card: vista, aperta, 👍/👎, salvata, ignorata (scorsa in meno di un secondo o due). È l'unica cosa che non si recupera dopo: se lo aggiungi fra un mese, perdi un mese di segnali.
- **Il modello dati degli argomenti.** Id stabile, focus, esclusioni, area. Cambiarlo dopo vuol dire migrare dati salvati su Supabase.

### Modificabile in qualsiasi momento

Prompt, pesi, proporzioni tra argomenti, numero di card, orario, quanta "esplorazione" fare, interfaccia delle card.

### Bozza di algoritmo, da discutere

Per ogni candidata un punteggio:

```
punteggio = qualità (voto Gemini)
          × peso argomento   (cresce con 👍 e aperture, cala con 👎 e notizie ignorate)
          × freschezza       (una notizia di 2 ore > una di 20 ore)
```

Poi l'ordine si costruisce una card alla volta, con alcune regole:
- **Varietà**: mai 2 card di fila sullo stesso argomento, mai 3 dello stesso tipo.
- **Esplorazione**: 1 card su 6–7 viene da un argomento o sotto-tema che guardi poco, per non chiuderti in una bolla.
- **Apertura**: la prima card è sempre la notizia più importante del giorno tra i tuoi argomenti.

### Da decidere insieme

1. **Proporzioni**: argomenti in parti fisse ("40% Tech"), o che si adattano da soli a cosa apri?
2. **Esplorazione**: ti va qualche notizia fuori dai tuoi interessi abituali, o preferisci un feed stretto?
3. **Tipi di contenuto**: solo notizie, o anche analisi, curiosità e "da tenere d'occhio"?
4. **Età massima**: solo ultime 24 ore, o anche cose di qualche giorno se rilevanti?
5. **Italia o mondo**: le preferenze valgono per tutti gli argomenti o una per argomento?
6. **Cosa conta come "non mi interessa"**: solo 👎 esplicito, o anche le card scorse velocemente?

Rispondi anche a spanne. Poi fisso struttura e bozza di algoritmo, e parto con la fase 1.
