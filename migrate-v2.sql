-- ════════════════════════════════════════════════════════════════════
-- CTA MARK DASHBOARD — Migrate v1 blob → v2 normalized tables
--
-- Run AFTER supabase-schema.sql. Reads each student's JSONB blob
-- from the old `profiles` table and inserts rows into the new
-- normalized tables. Safe to re-run (uses ON CONFLICT DO NOTHING).
-- ════════════════════════════════════════════════════════════════════

do $$
declare
  r record;
  mod jsonb;
  mk  jsonb;
  mid uuid;
begin
  for r in
    select id as user_id, data
    from public.profiles
    where data is not null
      and data != '{}'::jsonb
      and (data->>'isSetup')::boolean is true
  loop
    -- 1. User settings
    insert into public.user_settings (user_id, name, program, institution, exam_date, is_setup)
    values (
      r.user_id,
      coalesce(r.data->'settings'->>'name', ''),
      coalesce(r.data->'settings'->>'program', 'PGDA'),
      coalesce(r.data->'settings'->>'institution', ''),
      case
        when r.data->'settings'->>'examDate' is not null
          and r.data->'settings'->>'examDate' != ''
        then (r.data->'settings'->>'examDate')::timestamptz
        else null
      end,
      true
    )
    on conflict (user_id) do nothing;

    -- 2. Modules + marks
    if jsonb_typeof(r.data->'modules') = 'array' then
      for mod in select * from jsonb_array_elements(r.data->'modules')
      loop
        mid := gen_random_uuid();

        insert into public.modules (id, user_id, name, code, color, sort_order)
        values (
          mid,
          r.user_id,
          coalesce(mod->>'name', 'Unknown'),
          coalesce(mod->>'code', 'UNK'),
          coalesce(mod->>'color', '#ffffff'),
          coalesce((mod->>'sortOrder')::int, 0)
        )
        on conflict (user_id, code) do update set id = excluded.id
        returning id into mid;

        -- Marks array inside each module
        if jsonb_typeof(mod->'marks') = 'array' then
          for mk in select * from jsonb_array_elements(mod->'marks')
          loop
            if mk->>'assessment' is not null and mk->>'score' is not null then
              insert into public.marks (module_id, user_id, assessment, score)
              values (
                mid,
                r.user_id,
                mk->>'assessment',
                (mk->>'score')::numeric
              )
              on conflict (module_id, assessment) do nothing;
            end if;
          end loop;
        end if;
      end loop;
    end if;
  end loop;

  raise notice 'Migration complete.';
end $$;
