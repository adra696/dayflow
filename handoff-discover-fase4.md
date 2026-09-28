# Handoff: DayFlow, Discover fase 4

## Istruzioni per la nuova sessione
- Rispondi in italiano, stile asciutto ("caveman"): niente preamboli.
- Prima di tutto leggi `CLAUDE.md` (architettura; sezione "Discover Feed" con la parte cloud), `supabase/SETUP.md`, `supabase/functions/generate-feed/index.ts`, `js/discover.js`, `js/feedrank.js`.
- La PR di fase 1–3 (https://github.com/adra696/dayflow/pull/1) è già **mergiata** su `main`. Il nuovo lavoro parte da `main` aggiornato: branch nuovo, oppure branch designato ricreato da `origin/main`.
- La pubblicazione della funzione la fa l'utente dalla dashboard Supabase (niente CLI): a ogni modifica di `index.ts` va incollata in Edge Functions → `generate-feed` → Code → Deploy. Ogni SQL nuovo va eseguito nel SQL Editor.

## Contesto
DayFlow è una PWA personale per l'ADHD (HTML/CSS/JS con ES modules, niente build, Supabase, GitHub Pages, installata su iPhone, usata solo dall'autore).

Discover prima generava notizie inventate con Gemini direttamente sul dispositivo. Nelle fasi 1–3 è stato rifatto:
- una Edge Function Supabase `generate-feed` cerca ogni mattina alle 6 (ora di Roma) notizie vere con Gemini + Google Search e le salva in `feed_items`;
- l'app le legge, le ordina (`js/feedrank.js`) e registra le interazioni in `feed_events`;
- approfondimenti e chat passano dalla funzione (mode `proxy`), quindi la chiave Gemini resta nei segreti Supabase;
- se Google ritira il modello Gemini, la funzione passa da sola a un sostituto.

L'utente ha provato tutto su iPhone: funziona.

## Obiettivo
Implementare la fase 4 di Discover: feedback esplicito, argomenti più ricchi, profilo dei gusti e le 5 idee scelte dall'utente.

## Decisioni già prese
- **Ordinamento:**
  - punteggio = qualità × peso argomento × freschezza;
  - in cima la notizia più importante;
  - una card su 6 da un argomento sotto la media;
  - mai 3 card di fila dello stesso tipo;
  - due card di fila sullo stesso argomento vanno bene (l'utente non vuole quella regola);
  - le proporzioni tra argomenti si adattano a cosa apre l'utente; ogni tanto un po' di esplorazione.
- **Segnali negativi:** solo il 👎 esplicito e "meno così". Le card scorse via (`skip`) si registrano ma non penalizzano.
- **Età e tipi:** vanno bene anche notizie di qualche giorno, pesate con la freschezza. Tipi: notizia, analisi, curiosità, da tenere d'occhio.
- **Area Italia / Europa / mondo:** un'impostazione generale più un override per argomento.
- **Gemini:** tutto passa dal cloud; la chiave locale è solo una riserva facoltativa.
- **Fase 4 scelta dall'utente.** Base: 👍/👎, "meno così" / "di più su questo", argomenti più ricchi (focus, esclusioni, area, livello divulgativo/tecnico, creazione da una frase), area nelle impostazioni, profilo dei gusti modificabile. Idee extra, in ordine di preferenza:
  1. **Qualità più severa** (idea 2): scala dei voti con esempi (quasi tutto 2–3, il 5 raro), preferire testate ad aggregatori e blog, "non mostrarmi più questa fonte", titoli meno telegrafici. L'utente aveva notato voti quasi tutti tra 4 e 5 e titoli tipo "Rischio 230 miliardi ricavi bancari da stablecoin".
  2. **Segui una storia** (idea 4): le mattine dopo la funzione cerca novità e le mostra con il badge "Aggiornamento".
  3. **Ascolta** (idea 5): lettura dell'approfondimento con `speechSynthesis`, voce it-IT, a blocchi per paragrafo; si ferma alla chiusura del foglio.
  4. **In 30 secondi** (idea 6): 3 punti essenziali in cima all'approfondimento.
  5. **Più testate in una card** (idea 3): stesso fatto da più testate → una card con "N fonti".
  Scartate per ora: feed a fine giornata, approfondimenti pronti al mattino, notifiche push.
- **Scelte di design proposte all'utente, che non ha obiettato:**
  - 👍/👎 piccoli in alto a destra sulla card. 👎 apre le opzioni "Meno su «sotto-argomento»" / "Non mostrarmi <fonte>"; 👍 apre "Di più su «sotto-argomento»" / "Segui la storia".
  - Storie seguite: scadono dopo 14 giorni; al mattino se ne controllano al massimo 6 (una chiamata Gemini ciascuna).
  - Profilo dei gusti: si rigenera ogni settimana solo se l'utente non l'ha modificato a mano (`profileManual`); c'è anche il pulsante "Rigenera".

## Stato attuale
- **Già in `main`:**
  - `supabase/sql/01-03`, la funzione `supabase/functions/generate-feed/index.ts` (modes `morning`, `more`, `proxy`, `models`; fallback modello con `callGemini()` / `pickReplacement()`);
  - `js/feedrank.js`, `js/discover.js` (pool, eventi, proxy, `adoptCloudModel`);
  - test `test/feedrank.test.js`; `npm test` passa 53 test su 53; cache SW `dayflow-v21`.
- **Già fatto sul progetto Supabase:** schema 01, cron 02, estensioni, segreti (`GEMINI_API_KEY`, `FEED_CRON_SECRET`), funzione pubblicata con Verify JWT disattivato. Da confermare con l'utente che sia stata ripubblicata l'ultima versione, quella con `callGemini`.
- **Fase 4, lavoro iniziato:**
  - scritto (non committato) `supabase/sql/04-feed-phase4.sql`: colonna `feed_items.follow_id`, tabella `feed_follows` (`id`, `user_id`, `item_id`, `topic_id`, `title`, `summary`, `url`, `created_at`, `until` = +14 giorni, `active`, `checked_at`, `updates`) con RLS per select/insert/update/delete, più una query di controllo finale. L'utente non l'ha ancora eseguito;
  - la modifica della funzione **non è stata applicata** (lo script si è interrotto prima di salvare). Va rifatta.

## Piano della fase 4, già progettato

**Funzione (`index.ts`):**
- `Topic` aggiunge `level` (`divulgativo` | `tecnico`, mappa `LEVELS`); `normalizeTopics` lo conserva.
- `Settings` aggiunge `profileAt`, `profileManual` e `prefs: { moreSub: ["topicId:sub"], lessSub: [...], blockedSources: [nome o dominio] }`. Tutto sta in `profiles.feed_settings`, scritto dal client.
- Estrarre da `generateTopic` una funzione `parseItems(text, gm, topicId, settings)` riusabile, che scarti anche le fonti bloccate (nome o host).
- Costanti comuni al prompt:
  - `ITEM_FIELDS`: titolo di massimo 14 parole, frase con soggetto e verbo; scala dei voti severa, con definizioni per 1, 3 e 5 di ogni voto;
  - `SOURCE_RULES`: testate affermate; stesso fatto = una sola voce.
- `buildPrompt(t, n, days, area, seen, settings)` aggiunge livello, più/meno sotto-argomenti per l'argomento, fonti vietate e profilo.
- `checkFollows(admin, userId)`:
  - disattiva le storie scadute;
  - per ognuna delle storie attive (al massimo 6, le meno recenti per prime) fa un prompt "novità dal <checked_at>, [] se niente, massimo 2 voci";
  - inserisce le voci con `follow_id`, aggiorna `checked_at` / `updates` e scrive un log `feed_runs` con kind `follows`.
- `buildProfile(admin, userId)`:
  - raccoglie gli eventi positivi e negativi degli ultimi 30 giorni, con i titoli da `feed_items`;
  - Gemini **senza ricerca** scrive un profilo di 3–5 frasi (aggiungere a `gemini()` un parametro `search = true`);
  - salva `profile`, `profileAt` e `profileManual: false` in `feed_settings`.
- Nuovo mode `profile` (JWT utente): rigenera il profilo; se i segnali sono meno di 5 risponde con errore `dayflow-few-signals`.
- `runMorning`: prima il profilo (se serve), poi `generateForUser`, poi `checkFollows`.

**Client:**
- `normalizeTopic` deve conservare `focus`, `exclude`, `area` e `level` (oggi li scarta).
- **Card:**
  - 👍/👎 con le opzioni descritte sopra; eventi `up`, `down`, `unvote`, `less`, `more`;
  - le preferenze vanno in `feed_settings.prefs` con `sb.from('profiles').update(...)`;
  - badge "↻ Aggiornamento" se c'è `follow_id`;
  - "N fonti" nella riga meta se `sources` ha almeno 2 domini diversi.
- **`feedrank.js`:**
  - moltiplicatore per sotto-argomento (più ×1,5, meno ×0,4);
  - esclusione delle fonti bloccate;
  - `mergeNearDuplicates()`: somiglianza delle parole del titolo, stesso argomento → una card con le fonti unite;
  - test per tutto.
- **Approfondimento:**
  - il prompt chiede "In breve" con 3 punti (righe che iniziano con `- `) dopo il titolo;
  - `parseArticleText` / `articleFromBlocks` salvano `tldr` in `fullArticle`;
  - riquadro "In 30 secondi";
  - pulsanti 🔊 Ascolta / Stop e "Segui la storia" (insert in `feed_follows`).
- **Foglio argomenti:**
  - modifica di focus, esclusioni, area e livello per ogni argomento;
  - "Crea da una frase": `geminiJSON` via proxy, senza strumenti, quindi `responseSchema` va bene.
- **Impostazioni Discover:**
  - area generale;
  - profilo dei gusti (textarea, Salva che imposta `profileManual: true`, Rigenera con mode `profile`);
  - preferenze con rimozione (sotto-argomenti più/meno, fonti bloccate);
  - storie seguite con "Smetti di seguire".
- Aggiungere al `window` bridge di `app.js` le nuove funzioni chiamate dagli `onclick`.
- Alzare `CACHE` in `sw.js` a `dayflow-v22`; aggiornare `CLAUDE.md` e `SETUP.md` (passo SQL 04 e ripubblicazione della funzione).

## Prossimi passi
1. Parti da `main` aggiornato. Committa `supabase/sql/04-feed-phase4.sql`: è nella cartella di lavoro della vecchia sessione e, se non c'è, ricrealo da questa descrizione.
2. Implementa le modifiche alla funzione. Verifica con `deno check`: installabile con `npm i deno` nello scratchpad, copiando `index.ts` in una cartella con `deno.json` `{"nodeModulesDir":"auto"}`.
3. Implementa le modifiche al client e i test di `feedrank.js`. Prova in Chromium con Playwright e un Supabase finto: nella vecchia sessione si intercettava lo script CDN di Supabase servendo un client finto, e l'URL `**/functions/v1/generate-feed`.
4. Commit, push, PR. Poi dai all'utente i passi: eseguire lo SQL 04, ripubblicare la funzione, mergiare.
5. Dopo qualche giorno di uso, controlla con l'utente `feed_runs` (`morning`, `follows`, `profile`, `model-fallback`) e la distribuzione dei voti di qualità.

---
*Report generato da Claude: apri una nuova chat e incollaci questo file come primo messaggio per continuare il lavoro.*
