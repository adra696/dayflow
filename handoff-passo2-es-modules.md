# Handoff: DayFlow, passo 2 — conversione a ES modules nativi

## Contesto
DayFlow è un habit tracker personale (PWA su GitHub Pages, un solo utente, UI in italiano). Leggi `CLAUDE.md` prima di iniziare. Il passo 1 è già fatto: l'app è divisa in `index.html` + `css/{tokens,base,screens,desktop}.css` + `js/{utils,state,sync,auth,plan,oggi,calendario,discover,settings,app}.js`. I 10 file JS sono script classici caricati con `defer` in quest'ordine; tutto è globale e l'HTML usa 80 handler inline (`onclick="..."` ecc.). Il service worker `sw.js` è cache-first con lista `STATIC` e cache `dayflow-v19`.

## Obiettivo
Trasformare i 10 script classici in ES modules (`import`/`export`) con un unico `<script type="module" src="js/app.js">`, **senza cambiare alcun comportamento**. Non è una riscrittura: si aggiungono `import`/`export` e si risolve il problema dello stato condiviso. Niente bundler, niente framework, niente TypeScript.

## Regole non negoziabili
1. **`sync.js` si sposta in blocco.** Puoi solo aggiungere righe `import` in cima e `export` in fondo (o la parola `export` davanti alle dichiarazioni). Nessuna modifica interna alla logica: epoch, lock in flight, coda persistita, `adoptRemoteDay`, retry.
2. **Nessuna funzione viene riscritta, rinominata, riordinata o "migliorata".** Se qualcosa sembra sbagliato, annotalo nel report finale e lascialo com'è.
3. **Gli handler inline restano invariati.** Le funzioni che chiamano vengono esposte su `window` in `app.js` (ponte), non convertite ad `addEventListener`.
4. **Grafo degli import senza cicli**, in questo ordine di dipendenza:
   `utils.js` ← `state.js` ← `sync.js` ← `auth.js` / `plan.js` / `oggi.js` / `calendario.js` / `discover.js` / `settings.js` ← `app.js`.
   `state.js` non importa nulla tranne `utils`. `sync.js` importa solo `utils` e `state`. Le schermate importano `utils`, `state`, `sync` e, se serve, un'altra schermata **solo verso il basso** (mai `state` → schermata, mai `sync` → schermata). Se `sync.js` o `state.js` hanno bisogno di chiamare una funzione di una schermata (es. `refreshDayViews` che chiama `renderOggi`/`renderCalendario`), la soluzione è un registro di callback: `sync.js` esporta `const hooks = { refreshDayViews: () => {} }` e `app.js` assegna `hooks.refreshDayViews = ...`. Documenta ogni hook creato.
5. **Verifica ad ogni file convertito**, non alla fine.
6. Non fare merge in `main`, non aggiornare `CLAUDE.md`, non toccare `css/`, non cambiare `sw.js` se non per file nuovi.

## Il problema centrale: lo stato mutabile condiviso
Con gli script classici, `let curScreen` dichiarato in `state.js` può essere riassegnato da `app.js` (`curScreen = 'oggi'`). Con i moduli, **un binding importato è di sola lettura**: `curScreen = 'oggi'` in un altro modulo lancia `TypeError: Assignment to constant variable`. Questo è l'unico punto dove serve toccare codice esistente, e va fatto in modo meccanico.

Procedura obbligatoria, prima di convertire qualsiasi file:
1. Elenca tutte le variabili top-level `let` di ogni file (`grep -n "^let " js/*.js`, più quelle dichiarate con `let a = 1, b = 2`).
2. Per ognuna, cerca in tutti gli altri file le **riassegnazioni** (`nome =`, `nome++`, `nome--`, `nome +=`, e i pattern tipo `[nome] =`). Le letture non contano, le mutazioni di proprietà (`S.days[x] = ...`, `SETTINGS.open = true`, `pendingSync.add(...)`) non contano: quelle funzionano.
3. Produci una tabella `variabile | file che la dichiara | file che la riassegnano`. Mettila nel report.
4. Per ogni variabile riassegnata da un file diverso da quello che la dichiara, scegli **una** di queste due soluzioni, in ordine di preferenza:
   - **a)** esiste già un setter (es. `setSelectedDate()` in `state.js`): usa quello nei file esterni.
   - **b)** aggiungi in `state.js` (o nel file che la dichiara) un setter minimale `export function setCurScreen(v) { curScreen = v; }` e sostituisci le riassegnazioni esterne con la chiamata. Il modulo che dichiara la variabile continua a leggerla e scriverla direttamente; gli altri leggono il binding importato (che è live: vede sempre il valore aggiornato) e scrivono tramite setter.
   Non spostare le variabili in un oggetto `G.curScreen` e non riscrivere tutte le letture: troppo invasivo.
5. Attenzione ai casi nascosti: `curUser` (assegnato in `auth.js` e in `app.js` dall'`onAuthStateChange`), `curScreen` (in `app.js` da `goScreen` e dalla swipe navigation), `selectedDate`, `isProgrammaticScroll`, `focusMode`, `editId`, `mMode`, `allDaysLoaded`, `lastTopPct`, `eventiColumnOk`, `habitsDirty`, `syncDebounce`, `syncEpoch`, `evDraft`, le variabili del feed in `discover.js`. La lista vera la produce il grep, non questa nota.

## Passi

### 1. Preparazione
- Copia `js/` in `js_pre_modules/` fuori dal repo (o in una cartella ignorata) come baseline per il confronto finale.
- Crea `package.json` minimale con `{ "type": "module" }` così `node --check js/*.js` accetta la sintassi `import`/`export`. Aggiungilo anche a `STATIC` in `sw.js`? No: non serve al browser, non aggiungerlo.
- Fai la tabella dello stato mutabile (sezione sopra) e applica i setter. Questo passo si fa **ancora con gli script classici**: verifica in browser che tutto funzioni prima di introdurre i moduli. Commit "prep: setters for cross-file state".

### 2. Ponte su `window`
- Estrai l'elenco delle funzioni chiamate da attributi inline in `index.html` (`on\w+="(\w+)\(`) e dentro le stringhe HTML generate in JS (cerca `onclick="` e simili dentro i file `js/`; sono i 61 render via `innerHTML`). Aggiungi anche le funzioni chiamate via `setTimeout('nome()')` o stringhe simili, se esistono.
- In fondo ad `app.js` crea un blocco unico:
  ```js
  // Ponte per gli handler inline (onclick="..." nell'HTML e nei template): resta finché esistono
  Object.assign(window, { goScreen, openSettings, closeSettings, toggleHabit, /* ... */ });
  ```
  Una riga per funzione, in ordine alfabetico, con un commento sul file di provenienza. Se una funzione manca dal ponte, il click fallisce con `ReferenceError` in console: la verifica in browser deve controllare la console dopo ogni interazione.

### 3. Conversione, un file alla volta, in questo ordine
`utils.js` → `state.js` → `sync.js` → `auth.js` → `plan.js` → `oggi.js` → `calendario.js` → `discover.js` → `settings.js` → `app.js`.

Per ogni file:
- Aggiungi `export` alle funzioni e alle variabili top-level usate da altri file (le altre restano private al modulo). Per sapere quali: per ogni nome dichiarato nel file, grep negli altri file.
- Aggiungi in cima gli `import { ... } from './x.js'` necessari (estensione `.js` obbligatoria, percorso relativo).
- `state.js`: `const sb = supabase.createClient(...)` usa il global `supabase` del CDN caricato come script classico prima del modulo: va bene così, non importarlo.
- Finché non sono tutti convertiti, l'app **non funziona** (un modulo e uno script classico non condividono scope). Quindi: convertili tutti in una passata, poi cambia `index.html`:
  ```html
  <link rel="modulepreload" href="js/utils.js">
  ... (uno per ogni modulo, nell'ordine di dipendenza)
  <script type="module" src="js/app.js"></script>
  ```
  e togli i 10 `<script defer>`.
- I moduli sono in strict mode automaticamente: se qualcosa assegnava una variabile mai dichiarata (`foo = 1` senza `let`), ora lancia `ReferenceError`. Cercali prima con `node --check` (non li vede) e poi in browser guardando la console.
- `this` a top-level è `undefined` nei moduli: cerca `this` fuori dalle funzioni e dai metodi.
- Il listener di `keydown`, la swipe navigation e la registrazione del service worker in `app.js` restano identici.

### 4. Verifica
- `node --check` su ogni file (con `package.json` type module).
- Confronto con la baseline: concatenando i file convertiti e togliendo le righe `import`/`export` (e la parola `export` a inizio riga), le righe non vuote devono coincidere con la baseline **tranne** le sostituzioni con i setter, il blocco ponte e gli hook. Elenca nel report ogni riga diversa.
- Browser (`npx serve .` o `python -m http.server 8765`): console senza errori a ogni passaggio; login; 4 schermate; swipe orizzontale tra le schermate (la nav in basso deve seguire); spunta un'abitudine in Oggi; scrivi un task in Pianifica; crea, modifica, elimina un evento nel Calendario; trascina la striscia settimanale; apri Impostazioni, "Sincronizza ora", cambia il modello Gemini; apri un articolo in Discover se c'è la chiave; modifica offline poi torna online e verifica "sincronizzato"; ricarica e controlla che i dati ci siano. Testa anche a 375px di larghezza.
- Nota: 4 errori 400 in console verso Supabase sono pre-esistenti (`profiles.feed_topics` non esiste, fallback silenzioso). Qualsiasi altro errore è una regressione.

### 5. Consegna
- Commit "refactor: convert scripts to ES modules" sul branch `refactor/split` (se git è rotto, lascia i file e dillo nel report).
- Report finale con: tabella dello stato mutabile e setter aggiunti, elenco degli hook, elenco delle funzioni nel ponte, righe che differiscono dalla baseline, esito di ogni voce della verifica.

## Cosa NON fare
- Non convertire gli handler inline ad `addEventListener`.
- Non spostare funzioni tra file, non rinominare, non riformattare.
- Non "sistemare" nulla in `sync.js` oltre a `import`/`export`.
- Non introdurre Vite, TypeScript, bundler o dipendenze npm.
- Non toccare `css/`, `manifest.json`, `dayflow1_0.html`.
