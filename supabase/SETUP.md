# Discover nel cloud: configurazione dalla Dashboard Supabase

Tutto si fa da browser su https://supabase.com/dashboard, progetto `iqlxjazrshqzqrltkjoz`. Ci vogliono circa 15 minuti. I file da incollare sono in questa cartella (`supabase/`).

Cosa si ottiene: ogni mattina alle 6:00 (ora di Roma) una funzione nel cloud chiede a Gemini, con la ricerca Google, circa 40 notizie vere sui tuoi argomenti e le salva nella tabella `feed_items`. L'app non le legge ancora: il collegamento è la fase 3. Nel frattempo Discover continua a funzionare come oggi.

---

## 1. Tabelle e segreto del cron

1. Menu a sinistra → **SQL Editor** → **New query**.
2. Incolla tutto `sql/01-feed-schema.sql` → **Run**.
3. Il risultato in basso mostra una colonna `feed_cron_secret` con una stringa lunga. **Copiala**: serve al passo 3.
   Per rivederla più tardi: `select decrypted_secret from vault.decrypted_secrets where name = 'feed_cron_secret';`

Crea:
- le colonne `feed_topics` e `feed_settings` su `profiles`;
- la tabella `feed_items` (notizie);
- la tabella `feed_events` (registro delle interazioni);
- la tabella `feed_runs` (log di ogni generazione);
- il segreto del cron nel Vault.

Tutte le tabelle sono protette da RLS: ognuno vede solo le proprie righe.

## 2. Estensioni per il cron

1. Menu → **Database** → **Extensions**.
2. Cerca **pg_cron** → attivala (schema proposto: lascia quello di default).
3. Cerca **pg_net** → attivala.

(In alcune versioni della dashboard pg_cron si attiva da **Integrations → Cron → Enable**: è la stessa cosa.)

## 3. Segreti della funzione

Menu → **Edge Functions** → **Secrets** (se non lo trovi: **Project Settings → Edge Functions**). Aggiungi:

| Nome | Valore |
|---|---|
| `GEMINI_API_KEY` | la tua chiave Gemini (la stessa dell'app va bene: la quota è condivisa) |
| `FEED_CRON_SECRET` | la stringa copiata al passo 1 |
| `GEMINI_MODEL` | *(facoltativo)* ad esempio `gemini-2.5-flash`, che è il default |

`SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` ci sono già: non vanno aggiunti.

## 4. La funzione `generate-feed`

1. Menu → **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Nome: **`generate-feed`**, esattamente così (il cron chiama questo indirizzo).
3. Cancella il codice di esempio e incolla tutto `functions/generate-feed/index.ts`.
4. **Deploy**.
5. Nei dettagli della funzione, **Verify JWT** (o "Enforce JWT verification") deve restare **attivo**.

Per aggiornarla in futuro: apri la funzione → scheda **Code** → incolla la nuova versione → **Deploy**.

## 5. Il cron delle 6:00

SQL Editor → nuova query → incolla `sql/02-feed-cron.sql` → **Run**. L'ultima riga del risultato deve mostrare il job `dayflow-feed-morning` con `active = true`.

Il job parte alle 4:00 e alle 5:00 UTC e la funzione lavora solo quando a Roma sono le 6, così l'ora legale è gestita da sola.

## 6. Prova manuale

Apri `sql/03-feed-test.sql` ed esegui **una query alla volta**: selezionala nell'editor e premi Run.

- **A. Argomenti.** Se `feed_topics` è vuoto (`NULL`), apri DayFlow → Discover → Argomenti e cambia qualcosa (aggiungine uno e toglilo): l'app li copia su Supabase. Senza argomenti salvati, il cron salta l'utente.
- **B. Avvio.** Lancia subito una generazione, ignorando l'orario.
- **C. Risposta.** Deve esserci `status_code = 202` e `{"started":true}`.
  - `401`: Verify JWT o la chiave anon nel file non vanno.
  - `403`: `FEED_CRON_SECRET` non corrisponde al segreto del Vault.
  - `500`: manca `GEMINI_API_KEY`.
- **D. Esito, dopo 1-2 minuti.** `ok = true` e `inserted` > 0. In `detail` trovi modello, ricerche fatte, token ed eventuali errori per argomento.
- **E. Le notizie.** Controlla che titoli, fonti e link siano veri e sensati.

I log dettagliati sono in **Edge Functions → generate-feed → Logs**.

**Mandami in chat il risultato di D ed E.** Una foto o un copia-incolla di qualche riga basta.

---

## Note

- **Quota Gemini**: ogni generazione fa una chiamata con ricerca per argomento. Al mattino, con 4 argomenti, sono 4 chiamate. Le richieste "more" dall'app (fase 3) sono al massimo 6 all'ora.
- **Pulizia**: le notizie più vecchie di 30 giorni vengono cancellate ogni mattina. Gli eventi in `feed_events` restano, perché tengono una copia di argomento, tipo e tag.
- **Fermare il cron**: `select cron.unschedule('dayflow-feed-morning');`
- **Rigenerare il segreto del cron**:
  1. `select vault.update_secret((select id from vault.secrets where name = 'feed_cron_secret'), 'NUOVO_VALORE');`
  2. Aggiorna anche `FEED_CRON_SECRET` al passo 3.
