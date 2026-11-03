create table if not exists public.google_calendar_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  google_email text,
  encrypted_refresh_token text not null,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.google_calendar_connections enable row level security;
-- This table is accessed only by the NestJS service role. No client policies are granted.
revoke all on public.google_calendar_connections from anon, authenticated;
grant all on public.google_calendar_connections to service_role;

