-- Fresh Spectre schema. No legacy local JSON data is imported.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.guest_accounts (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null unique,
  created_at timestamptz not null default now()
);

-- Each row belongs either to one authenticated user or one guest installation.
-- The JSON document keeps the existing app data shape during this storage move.
create table if not exists public.spectre_data (
  owner_key text primary key,
  data jsonb not null default '{"tasks":[],"folders":[],"tags":[],"notes":[],"username":""}'::jsonb,
  revision bigint not null default 0,
  updated_at timestamptz not null default now(),
  constraint spectre_data_owner_key_format check (owner_key ~ '^(user|guest):[a-zA-Z0-9-]{1,80}$')
);

create table if not exists public.scheduled_actions (
  id uuid primary key default gen_random_uuid(),
  creator_user_id uuid not null references auth.users(id) on delete cascade,
  client_request_id text,
  recipient_name text not null,
  recipient_email text not null,
  subject text not null,
  message text not null,
  scheduled_at timestamptz not null,
  timezone text not null,
  status text not null default 'scheduled' check (status in ('scheduled','sending','completed','failed')),
  failure_reason text,
  created_at timestamptz not null default now(),
  attempted_at timestamptz,
  completed_at timestamptz,
  unique (creator_user_id, client_request_id)
);

create index if not exists scheduled_actions_due_idx
  on public.scheduled_actions (scheduled_at) where status = 'scheduled';
create index if not exists scheduled_actions_creator_idx
  on public.scheduled_actions (creator_user_id, scheduled_at desc);

-- Claim due actions atomically so multiple NestJS instances cannot send the same email.
create or replace function public.claim_due_scheduled_actions(p_limit integer default 50)
returns setof public.scheduled_actions
language sql
security definer
set search_path = public
as $$
  with due as (
    select id from public.scheduled_actions
    where status = 'scheduled' and scheduled_at <= now()
    order by scheduled_at
    for update skip locked
    limit greatest(1, least(p_limit, 200))
  )
  update public.scheduled_actions a
  set status = 'sending', attempted_at = now()
  from due where a.id = due.id
  returning a.*;
$$;

-- All application queries go through NestJS using its server-only Supabase key.
-- Browser roles cannot read or write application tables directly.
alter table public.profiles enable row level security;
alter table public.guest_accounts enable row level security;
alter table public.spectre_data enable row level security;
alter table public.scheduled_actions enable row level security;
revoke all on public.profiles, public.guest_accounts, public.spectre_data, public.scheduled_actions from anon, authenticated;
grant all on public.profiles, public.guest_accounts, public.spectre_data, public.scheduled_actions to service_role;
revoke all on function public.claim_due_scheduled_actions(integer) from public, anon, authenticated;
grant execute on function public.claim_due_scheduled_actions(integer) to service_role;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
