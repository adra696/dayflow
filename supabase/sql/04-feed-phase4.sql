-- DayFlow · Discover fase 4 · storie seguite
-- Da incollare in Dashboard → SQL Editor → Run (se compare l'avviso RLS, scegli l'opzione che lo attiva).
-- Rieseguibile.

-- Notizie che aggiornano una storia seguita
alter table public.feed_items add column if not exists follow_id uuid;

-- Storie seguite: ogni mattina la funzione cerca novità (max 14 giorni, poi scadono)
create table if not exists public.feed_follows (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  item_id     uuid references public.feed_items(id) on delete set null,
  topic_id    text not null,
  title       text not null,
  summary     text not null default '',
  url         text,
  created_at  timestamptz not null default now(),
  until       timestamptz not null default now() + interval '14 days',
  active      boolean not null default true,
  checked_at  timestamptz,
  updates     integer not null default 0
);
create index if not exists feed_follows_user on public.feed_follows (user_id, active);

alter table public.feed_follows enable row level security;
drop policy if exists "feed_follows: leggo le mie" on public.feed_follows;
create policy "feed_follows: leggo le mie" on public.feed_follows
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "feed_follows: creo le mie" on public.feed_follows;
create policy "feed_follows: creo le mie" on public.feed_follows
  for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists "feed_follows: modifico le mie" on public.feed_follows;
create policy "feed_follows: modifico le mie" on public.feed_follows
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "feed_follows: cancello le mie" on public.feed_follows;
create policy "feed_follows: cancello le mie" on public.feed_follows
  for delete to authenticated using (user_id = (select auth.uid()));

-- Controllo: deve restituire 1 riga con follow_id = 1 e policy = 4
select
  (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'feed_items' and column_name = 'follow_id') as follow_id,
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'feed_follows') as policy;
