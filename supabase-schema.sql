-- ════════════════════════════════════════════════════════════════════
-- TERM TRACKER — Supabase schema
-- Run once: Supabase → SQL Editor → New query → paste → Run.
--
-- Stores each student's entire Term Tracker state as one JSON document,
-- locked down with Row Level Security so a user can only ever read/write
-- their own row. This matches the app's data shape exactly (modules with
-- marks + struggles + assessments, settings with name/year/timeline/…),
-- so nothing is lost on sync.
-- ════════════════════════════════════════════════════════════════════

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Row Level Security: a student sees and edits only their own row.
alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select using ( auth.uid() = id );

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
  on public.profiles for insert with check ( auth.uid() = id );

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update using ( auth.uid() = id ) with check ( auth.uid() = id );

-- Auto-create an empty profile row when a new auth user signs up
-- (covers Google/OAuth sign-ups too).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, data) values (new.id, '{}'::jsonb)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
