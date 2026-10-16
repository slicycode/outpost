-- Run once in the Supabase SQL editor.
create table if not exists public.matches (
  code        text primary key,
  doc         jsonb not null,
  version     integer not null default 1,
  updated_at  timestamptz not null default now()
);
-- The API uses the service-role key from the server only; keep RLS on so the anon key can't read tokens.
alter table public.matches enable row level security;
