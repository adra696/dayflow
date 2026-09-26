-- DayFlow · Discover nel cloud · prova manuale e controlli (passo 6)
-- Da eseguire UNA QUERY ALLA VOLTA (selezionala e premi Run).

-- A) Gli argomenti sono arrivati sul profilo? Se feed_topics è null, apri l'app,
--    Discover → Argomenti, e modifica/salva qualcosa: l'app li copia su Supabase.
select id, feed_topics, feed_settings from public.profiles;

-- B) Lancia subito la generazione del mattino, ignorando l'orario ("force").
select net.http_post(
  url := 'https://iqlxjazrshqzqrltkjoz.supabase.co/functions/v1/generate-feed',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlxbHhqYXpyc2hxenFybHRram96Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MTUzMzUsImV4cCI6MjA5NDE5MTMzNX0.N5F7RW3ueIHFtwwZFBXkbeTxZMam_lh8hPshy7uX1MI',
    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'feed_cron_secret')
  ),
  body := '{"mode":"morning","force":true}'::jsonb,
  timeout_milliseconds := 10000
);

-- C) Risposta immediata della funzione (deve essere 202 {"started":true}).
select id, status_code, content, error_msg, created from net._http_response order by id desc limit 5;

-- D) Dopo 1-2 minuti: esito della generazione (ok, quante notizie, errori, tempi, token).
select started_at, kind, ok, inserted, ms, detail from public.feed_runs order by started_at desc limit 5;

-- E) Le notizie generate.
select created_at, topic_id, subtopic, type, q_specificity, q_novelty, q_importance, title, source, url, published_at
from public.feed_items order by created_at desc limit 50;
