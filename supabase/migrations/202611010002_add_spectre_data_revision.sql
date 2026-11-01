alter table public.spectre_data
  add column if not exists revision bigint not null default 0;
