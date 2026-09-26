-- DayFlow · Discover nel cloud · cron del mattino (passo 5)
-- Richiede le estensioni pg_cron e pg_net attive (Dashboard → Database → Extensions).
-- Da incollare in Dashboard → SQL Editor → Run. Rieseguibile: cron.schedule con lo
-- stesso nome aggiorna il job esistente.
--
-- Alle 6:00 di Roma. pg_cron gira in UTC e Roma cambia ora legale, quindi il job parte
-- alle 4:00 e alle 5:00 UTC e la funzione lavora solo quando a Roma sono le 6
-- (estate 4:00 UTC, inverno 5:00 UTC). L'altra chiamata risponde "skipped".
--
-- Authorization = chiave anon pubblica (la stessa di js/state.js): serve solo a passare
-- il controllo JWT del gateway; l'autorizzazione vera è x-cron-secret.

select cron.schedule(
  'dayflow-feed-morning',
  '0 4,5 * * *',
  $$
  select net.http_post(
    url := 'https://iqlxjazrshqzqrltkjoz.supabase.co/functions/v1/generate-feed',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlxbHhqYXpyc2hxenFybHRram96Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MTUzMzUsImV4cCI6MjA5NDE5MTMzNX0.N5F7RW3ueIHFtwwZFBXkbeTxZMam_lh8hPshy7uX1MI',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'feed_cron_secret')
    ),
    body := '{"mode":"morning"}'::jsonb,
    timeout_milliseconds := 10000
  );
  $$
);

-- Controllo: il job deve comparire qui.
select jobid, jobname, schedule, active from cron.job where jobname = 'dayflow-feed-morning';
