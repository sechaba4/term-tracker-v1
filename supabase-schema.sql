-- ════════════════════════════════════════════════════════════════════
-- CTA MARK DASHBOARD — Supabase schema (v2, normalized)
--
-- Run in your Supabase project: SQL Editor → New query → paste → Run.
-- Replaces the v1 single-blob schema with normalized tables, proper
-- indexes for scaling, CHECK constraints for data integrity, and
-- Row Level Security so every student can only touch their own rows.
--
-- MIGRATION FROM v1: if you have existing data in the old `profiles`
-- table, run migrate-v2.sql AFTER this file to move it over.
-- ════════════════════════════════════════════════════════════════════


-- ── 0. EXTENSIONS ──────────────────────────────────────────────────
create extension if not exists "pgcrypto";       -- gen_random_uuid()


-- ── 1. USER SETTINGS ──────────────────────────────────────────────
-- One row per student. Stores profile info (not marks).
create table if not exists public.user_settings (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  name         text not null default '' check (length(name) <= 200),
  program      text not null default 'PGDA' check (length(program) <= 100),
  institution  text not null default '' check (length(institution) <= 200),
  exam_date    timestamptz,
  is_setup     boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint uq_user_settings_user unique (user_id)
);

create index if not exists idx_user_settings_user on public.user_settings (user_id);


-- ── 2. MODULES ─────────────────────────────────────────────────────
-- Each student has ≤8 modules (typically 4 for CTA PGDA).
create table if not exists public.modules (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  name         text not null check (length(name) between 1 and 200),
  code         text not null check (code ~ '^[A-Za-z0-9_-]{1,20}$'),
  color        text not null default '#ffffff' check (color ~ '^#[0-9a-fA-F]{6}$'),
  sort_order   int not null default 0 check (sort_order between 0 and 99),
  created_at   timestamptz not null default now(),

  constraint uq_module_per_user unique (user_id, code)
);

create index if not exists idx_modules_user on public.modules (user_id);


-- ── 3. MARKS ───────────────────────────────────────────────────────
-- One row per module per assessment period (Feb, Apr, Jun, Sep).
create table if not exists public.marks (
  id           uuid primary key default gen_random_uuid(),
  module_id    uuid not null references public.modules(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  assessment   text not null check (assessment in ('Feb','Apr','Jun','Sep')),
  score        numeric(5,2) check (score is null or (score >= 0 and score <= 100)),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint uq_mark_per_assessment unique (module_id, assessment)
);

create index if not exists idx_marks_module  on public.marks (module_id);
create index if not exists idx_marks_user    on public.marks (user_id);
create index if not exists idx_marks_lookup  on public.marks (user_id, module_id, assessment);


-- ── 4. QUESTION BREAKDOWNS ─────────────────────────────────────────
-- Per-question earned/available for a specific mark entry.
create table if not exists public.question_breakdowns (
  id               uuid primary key default gen_random_uuid(),
  mark_id          uuid not null references public.marks(id) on delete cascade,
  user_id          uuid not null references auth.users(id) on delete cascade,
  question_number  int not null check (question_number between 1 and 100),
  earned           numeric(5,2) not null default 0 check (earned >= 0 and earned <= 999),
  available        numeric(5,2) not null default 0 check (available >= 0 and available <= 999),
  created_at       timestamptz not null default now(),

  constraint uq_breakdown_per_question unique (mark_id, question_number)
);

create index if not exists idx_qb_mark on public.question_breakdowns (mark_id);
create index if not exists idx_qb_user on public.question_breakdowns (user_id);


-- ── 5. SCHEDULE PROGRESS ───────────────────────────────────────────
-- Tracks which study-schedule periods a student has completed.
create table if not exists public.schedule_progress (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  week_id      text not null check (length(week_id) <= 50),
  period_id    text not null check (length(period_id) <= 50),
  completed    boolean not null default false,
  completed_at timestamptz,

  constraint uq_schedule_entry unique (user_id, week_id, period_id)
);

create index if not exists idx_schedule_user on public.schedule_progress (user_id);


-- ── 6. TASKS ───────────────────────────────────────────────────────
-- Per-module weekly task checklist.
create table if not exists public.tasks (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  module_code  text check (module_code is null or module_code ~ '^[A-Za-z0-9_-]{1,20}$'),
  week         text check (week is null or length(week) <= 50),
  description  text not null check (length(description) between 1 and 1000),
  completed    boolean not null default false,
  completed_at timestamptz,
  created_at   timestamptz not null default now(),

  constraint uq_task unique (user_id, module_code, week, description)
);

create index if not exists idx_tasks_user        on public.tasks (user_id);
create index if not exists idx_tasks_user_module on public.tasks (user_id, module_code);


-- ── 7. NOTES (per-module scratchpad) ───────────────────────────────
create table if not exists public.notes (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  module_code  text not null check (module_code ~ '^[A-Za-z0-9_-]{1,20}$'),
  content      text not null default '' check (length(content) <= 10000),
  updated_at   timestamptz not null default now(),

  constraint uq_note_per_module unique (user_id, module_code)
);

create index if not exists idx_notes_user on public.notes (user_id);


-- ════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- Every table: a student can only SELECT/INSERT/UPDATE/DELETE
-- rows where user_id = auth.uid(). No exceptions.
-- ════════════════════════════════════════════════════════════════════

-- Helper: enable RLS + create all four policies in one pattern.
-- (Supabase requires RLS enabled per-table.)

do $$
declare
  t text;
begin
  for t in
    select unnest(array[
      'user_settings', 'modules', 'marks',
      'question_breakdowns', 'schedule_progress', 'tasks', 'notes'
    ])
  loop
    execute format('alter table public.%I enable row level security', t);

    -- Drop existing policies (idempotent re-run)
    execute format('drop policy if exists "%s_select_own" on public.%I', t, t);
    execute format('drop policy if exists "%s_insert_own" on public.%I', t, t);
    execute format('drop policy if exists "%s_update_own" on public.%I', t, t);
    execute format('drop policy if exists "%s_delete_own" on public.%I', t, t);

    -- Create policies
    execute format(
      'create policy "%s_select_own" on public.%I for select using (auth.uid() = user_id)', t, t);
    execute format(
      'create policy "%s_insert_own" on public.%I for insert with check (auth.uid() = user_id)', t, t);
    execute format(
      'create policy "%s_update_own" on public.%I for update using (auth.uid() = user_id) with check (auth.uid() = user_id)', t, t);
    execute format(
      'create policy "%s_delete_own" on public.%I for delete using (auth.uid() = user_id)', t, t);
  end loop;
end $$;


-- ════════════════════════════════════════════════════════════════════
-- AUTO-SEED: create a user_settings row on sign-up
-- ════════════════════════════════════════════════════════════════════

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.user_settings (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ════════════════════════════════════════════════════════════════════
-- UPDATED_AT AUTO-TOUCH
-- Automatically bumps updated_at on UPDATE for tables that have it.
-- ════════════════════════════════════════════════════════════════════

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare
  t text;
begin
  for t in
    select unnest(array['user_settings', 'marks', 'notes'])
  loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format(
      'create trigger set_updated_at before update on public.%I for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;


-- ════════════════════════════════════════════════════════════════════
-- ROW LIMITS — prevent abuse (one student can't create 10,000 modules)
-- ════════════════════════════════════════════════════════════════════

create or replace function public.enforce_module_limit()
returns trigger
language plpgsql
as $$
begin
  if (select count(*) from public.modules where user_id = new.user_id) >= 12 then
    raise exception 'Module limit reached (max 12 per student)';
  end if;
  return new;
end;
$$;

drop trigger if exists check_module_limit on public.modules;
create trigger check_module_limit
  before insert on public.modules
  for each row execute function public.enforce_module_limit();

create or replace function public.enforce_task_limit()
returns trigger
language plpgsql
as $$
begin
  if (select count(*) from public.tasks where user_id = new.user_id) >= 500 then
    raise exception 'Task limit reached (max 500 per student)';
  end if;
  return new;
end;
$$;

drop trigger if exists check_task_limit on public.tasks;
create trigger check_task_limit
  before insert on public.tasks
  for each row execute function public.enforce_task_limit();


-- ════════════════════════════════════════════════════════════════════
-- KEEP THE LEGACY profiles TABLE (read-only, for migration)
-- If you already ran v1, this is a no-op. New deploys get it too
-- so the migration script always has something to read from.
-- ════════════════════════════════════════════════════════════════════

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);
