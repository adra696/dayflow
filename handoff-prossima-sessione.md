# Handoff: DayFlow, stato del refactor al 18 settembre 2026

## Contesto
DayFlow è un habit tracker personale (PWA su GitHub Pages, installata su iPhone, un solo utente, UI in italiano). Fino a ieri viveva in un unico `dayflow1_0.html` da 298 KB. È in corso una ristrutturazione in più file, scelta dopo aver confrontato quattro opzioni (split classico, ES modules nativi, Vite, framework): la decisione è **ES modules nativi senza bundler**, in tre passi. `CLAUDE.md` è aggiornato con la nuova struttura: leggilo prima di tutto.

L'utente usa i crediti Fable con moderazione: i compiti meccanici li delega ad Antigravity (Gemini) fuori da Claude o al subagent `dayflow-builder` (opus); a Claude/Fable restano revisione, decisioni e le parti delicate. Gli agenti in `.claude/agents/` sono stati riconfigurati il 18 set: `dayflow-implementer` (fable) è il default, `dayflow-builder` (opus) solo per lavoro meccanico con soluzione già nel brief, `dayflow-verifier` (sonnet) per verifiche.

## Obiettivo
Arrivare a un'app in ES modules con dipendenze esplicite e una manciata di test `node --test` sui calcoli, senza cambiare alcun comportamento e senza toolchain.

## Decisioni e conclusioni
- Passo 0 (service worker cache-first versionato, `dayflow-v19`) e passo 1 (split in `index.html` + `css/{tokens,base,screens,desktop}.css` + `js/` 10 script classici `defer`) sono **fatti e verificati**. Antigravity ha eseguito, Claude ha revisionato e corretto due regressioni: il blocco JS della swipe navigation era stato perso (ripristinato in `js/app.js`) e il blocco `@media (min-width: 768px)` era finito prima delle regole base di `screens.css` (spostato in `css/desktop.css`, caricato per ultimo).
- Metodo di revisione che ha funzionato: estrarre l'originale da git HEAD `bcd9334` e confrontare riga per riga (normalizzate) la concatenazione dei nuovi file con l'originale, più un controllo sulla cascata CSS per regole a pari specificità. Da rifare dopo il passo 2 usando come baseline una copia di `js/` pre-conversione.
- `dayflow1_0.html` resta come redirect a `index.html` (PWA installata). `manifest.json` ha `start_url` su `index.html`.
- Ogni release richiede il bump di `CACHE` in `sw.js`.
- I 4 errori 400 in console verso Supabase sono pre-esistenti: la colonna `profiles.feed_topics` non esiste, fallback silenzioso documentato.
- Handler inline (80) restano; nel passo 2 si usa un ponte su `window`. Niente conversione ad `addEventListener`, niente Vite, niente framework: scartati per un'app personale.

## Stato attuale
- Working tree con lo split completo, **non committato**: `git.exe` locale è corrotto (crash 0xC000012F, file danneggiati in `C:\Program Files\Git`). L'utente deve reinstallare Git, poi:
  `git checkout -b refactor/split` e `git add -A && git commit -m "refactor: split single-file app into css/ + js/, cache-first SW"`.
- Verifica in browser fatta con sessione loggata: 4 schermate, impostazioni, flush di sync ok, mobile 375px, swipe tra schermate. Console pulita a parte i 400 attesi.
- Non ancora provato su iPhone dopo il deploy.
- Il brief per il passo 2 è pronto in `handoff-passo2-es-modules.md` (regola dei setter per lo stato mutabile condiviso, ponte `window`, grafo import senza cicli, `sync.js` in blocco, checklist di verifica). Può essere eseguito da Antigravity o da `dayflow-implementer`; la revisione la fa Claude.
- File di lavoro nella root che si possono cancellare a fine refactor: `handoff-20260918.md`, `handoff-split-completed.md` (report di Antigravity), `handoff-passo2-es-modules.md`, questo file.

## Prossimi passi
1. Chiedi all'utente se Git è stato riparato e se lo split è committato su `refactor/split`. Se no, non fare nulla di irreversibile sul working tree.
2. Se l'utente porta il report del passo 2 (fatto altrove): revisiona. Copia baseline vs file convertiti, controlla la tabella dello stato mutabile e i setter, il ponte `window` completo (grep di `on\w+="(\w+)\(` in `index.html` e nei template dei file `js/`), assenza di cicli negli import, `sync.js` toccato solo con `import`/`export`. Poi verifica in browser con `preview_start` `dayflow-static` (la sessione nel browser integrato è già loggata).
3. Se il passo 2 non è stato fatto: eseguilo con `dayflow-implementer` (fable) seguendo `handoff-passo2-es-modules.md`, oppure dai il file all'utente per Antigravity, a sua scelta.
4. Dopo il passo 2: test `node --test` in `test/` su `calcPct`, `calcAvg`, `normalizeEvento`, `ensureSlotArrays`, `adoptRemoteDay`. Aggiungere `package.json` con `"type": "module"`.
5. Alla fine: aggiornare `CLAUDE.md` (sezione Architecture: moduli, grafo import, ponte), bump `CACHE`, merge in `main`, prova su iPhone.

---
*Report generato da Claude — continua questo lavoro in una nuova chat incollandoci questo file come primo messaggio.*
