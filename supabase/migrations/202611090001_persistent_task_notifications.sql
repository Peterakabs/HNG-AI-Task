-- Persistent in-app due reminders for authenticated and device-based guest accounts.
-- The backend service role remains the only writer/reader for these records.
alter table public.notifications
  alter column recipient_user_id drop not null,
  add column if not exists recipient_scope text,
  add column if not exists push_attempt_count integer not null default 0,
  add column if not exists push_next_attempt_at timestamptz,
  add column if not exists push_sent_at timestamptz,
  add column if not exists push_failure_reason text;

alter table public.notifications drop constraint if exists notifications_notification_type_check;
alter table public.notifications add constraint notifications_notification_type_check check (notification_type in (
  'reminder_acknowledged','reminder_sent','reminder_failed',
  'collaboration_invitation_accepted','collaboration_invitation_declined',
  'collaboration_task_updated','collaboration_comment_added','collaboration_access_removed',
  'task_reminder'
));

create index if not exists notifications_scope_created_idx
  on public.notifications (recipient_scope, created_at desc) where recipient_scope is not null;
create table if not exists public.notification_preferences (
  owner_scope text primary key,
  in_app boolean not null default true,
  browser_push boolean not null default false,
  task_reminders boolean not null default true,
  collaboration_updates boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.notification_preferences enable row level security;
revoke all on public.notification_preferences from anon, authenticated;
grant all on public.notification_preferences to service_role;

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  owner_scope text not null,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists push_subscriptions_owner_scope_idx on public.push_subscriptions(owner_scope);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;
grant all on public.push_subscriptions to service_role;
