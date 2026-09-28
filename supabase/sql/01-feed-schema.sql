-- DayFlow · Discover nel cloud · schema (passo 1)
-- Da incollare in Dashboard → SQL Editor → New query → Run.
-- Si può rieseguire senza danni (if not exists / drop policy if exists).

-- ── 1. Profilo: argomenti e impostazioni del feed ─────────────────────────
-- feed_topics: [{ id, label, emoji, color, focus?, exclude?, area? }]
--   id stabile (mai rinominato), area = null → vale feed_settings.area
-- feed_settings: { area: 'misto'|'italia'|'europa'|'mondo', maxAgeDays: 3, profile: '...' }
alter table public.profiles add column if not exists feed_topics jsonb;
alter table public.profiles add column if not exists feed_settings jsonb not null default '{}'::jsonb;

-- ── 2. Notizie candidate (scritte solo dalla Edge Function) ───────────────
create table if not exists public.feed_items (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  batch_id      uuid not null,                     -- una generazione = un batch
  kind          text not null check (kind in ('morning', 'more')),
  origin        text not null default 'search',    -- 'search' = Google via Gemini; in futuro 'rss'
  created_at    timestamptz not null default now(),
  topic_id      text not null,
  subtopic      text not null default '',
  tags          text[] not null default '{}',
  type          text not null check (type in ('notizia', 'analisi', 'curiosita', 'da_tenere_docchio')),
  title         text not null,
  title_key     text not null,                     -- titolo normalizzato, per i duplicati
  summary       text not null default '',
  why           text not null default '',          -- "perché conta"
  source        text not null default '',          -- nome della testata
  url           text,                              -- link all'articolo (verificato sulle fonti Google)
  sources       jsonb not null default '[]'::jsonb,-- [{ title, uri, url }] fonti Google collegate
  published_at  timestamptz,
  q_specificity smallint check (q_specificity between 1 and 5),
  q_novelty     smallint check (q_novelty between 1 and 5),
  q_importance  smallint check (q_importance between 1 and 5),
  model         text,
  article       jsonb,                             -- approfondimento già generato { title, sections }
  unique (user_id, title_key)
);
create index if not exists feed_items_user_created on public.feed_items (user_id, created_at desc);

alter table public.feed_items enable row level security;
drop policy if exists "feed_items: leggo le mie" on public.feed_items;
create policy "feed_items: leggo le mie" on public.feed_items
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "feed_items: aggiorno le mie" on public.feed_items;
create policy "feed_items: aggiorno le mie" on public.feed_items
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
-- dal client si può aggiornare solo la colonna article (cache dell'approfondimento)
revoke insert, update, delete on public.feed_items from anon, authenticated;
grant update (article) on public.feed_items to authenticated;

-- ── 3. Registro delle interazioni (attivo dal primo giorno) ───────────────
-- topic_id/subtopic/type/tags copiati dalla card: i segnali restano anche quando
-- le notizie vecchie vengono cancellate.
create table if not exists public.feed_events (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  item_id    uuid references public.feed_items(id) on delete set null,
  kind       text not null check (kind in ('view', 'open', 'skip', 'up', 'down', 'unvote', 'save', 'unsave', 'chat', 'less', 'more', 'share')),
  topic_id   text,
  subtopic   text,
  type       text,
  tags       text[],
  dwell_ms   integer,
  created_at timestamptz not null default now()
);
create index if not exists feed_events_user_created on public.feed_events (user_id, created_at desc);

alter table public.feed_events enable row level security;
drop policy if exists "feed_events: leggo i miei" on public.feed_events;
create policy "feed_events: leggo i miei" on public.feed_events
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "feed_events: scrivo i miei" on public.feed_events;
create policy "feed_events: scrivo i miei" on public.feed_events
  for insert to authenticated with check (user_id = (select auth.uid()));

-- ── 4. Log delle generazioni (per controllare il cron e i limiti) ─────────
create table if not exists public.feed_runs (
  id          bigint generated always as identity primary key,
  user_id     uuid references auth.users(id) on delete cascade,
  kind        text not null,
  started_at  timestamptz not null default now(),
  ms          integer,
  ok          boolean,
  inserted    integer,
  detail      jsonb
);
create index if not exists feed_runs_user_started on public.feed_runs (user_id, started_at desc);

alter table public.feed_runs enable row level security;
drop policy if exists "feed_runs: leggo i miei" on public.feed_runs;
create policy "feed_runs: leggo i miei" on public.feed_runs
  for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete on public.feed_runs from anon, authenticated;

-- ── 5. Segreto per il cron ────────────────────────────────────────────────
-- Genera un segreto casuale e lo mette nel Vault (solo se non esiste già).
select vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'feed_cron_secret')
where not exists (select 1 from vault.secrets where name = 'feed_cron_secret');

-- Mostra il segreto: copialo, serve al passo 3 (FEED_CRON_SECRET).
select decrypted_secret as feed_cron_secret from vault.decrypted_secrets where name = 'feed_cron_secret';
