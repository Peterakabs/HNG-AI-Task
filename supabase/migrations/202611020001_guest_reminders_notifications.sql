-- Backward-compatible schema for scheduled guest reminders and sender notifications.
-- Also repairs databases that were created before spectre_data.revision was added.
alter table public.spectre_data
  add column if not exists revision bigint not null default 0;

alter table public.scheduled_actions
  add column if not exists task_id text,
  add column if not exists acknowledged_at timestamptz,
  add column if not exists acknowledgment_source text,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists email_sent_at timestamptz;

alter table public.scheduled_actions drop constraint if exists scheduled_actions_status_check;
update public.scheduled_actions set status = 'processing' where status = 'sending';
update public.scheduled_actions set status = 'sent' where status = 'completed';
alter table public.scheduled_actions alter column status set default 'scheduled';
alter table public.scheduled_actions
  add constraint scheduled_actions_status_check
  check (status in ('scheduled', 'processing', 'sending', 'sent', 'completed', 'failed', 'cancelled'));

alter table public.scheduled_actions drop constraint if exists scheduled_actions_acknowledgment_source_check;
alter table public.scheduled_actions
  add constraint scheduled_actions_acknowledgment_source_check
  check (acknowledgment_source is null or acknowledgment_source = 'guest_link');

create index if not exists scheduled_actions_retry_idx
  on public.scheduled_actions (status, next_attempt_at, scheduled_at);
create table if not exists public.guest_reminder_tokens (
  id uuid primary key default gen_random_uuid(),
  scheduled_action_id uuid not null references public.scheduled_actions(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists guest_reminder_tokens_action_idx
  on public.guest_reminder_tokens (scheduled_action_id, created_at desc);
alter table public.guest_reminder_tokens enable row level security;
revoke all on public.guest_reminder_tokens from anon, authenticated;
grant all on public.guest_reminder_tokens to service_role;

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  notification_type text not null check (notification_type in ('reminder_acknowledged', 'reminder_sent', 'reminder_failed')),
  title text not null,
  message text not null,
  related_task_id text,
  related_scheduled_action_id uuid not null references public.scheduled_actions(id) on delete cascade,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  unique (related_scheduled_action_id, notification_type)
);

create index if not exists notifications_recipient_created_idx
  on public.notifications (recipient_user_id, created_at desc);
alter table public.notifications enable row level security;
revoke all on public.notifications from anon, authenticated;
grant all on public.notifications to service_role;

-- Claim due work atomically. Processing rows with an expired lease can be retried
-- after a crash; provider delivery remains at-least-once, not exactly-once.
create or replace function public.claim_due_scheduled_actions(p_limit integer default 50)
returns setof public.scheduled_actions
language sql
security definer
set search_path = public
as $$
  with due as (
    select id
    from public.scheduled_actions
    where (
      status = 'scheduled'
      and scheduled_at <= now()
      and coalesce(next_attempt_at, scheduled_at) <= now()
    ) or (
      status in ('processing', 'sending')
      and attempted_at <= now() - interval '5 minutes'
    )
    order by coalesce(next_attempt_at, scheduled_at), scheduled_at
    for update skip locked
    limit greatest(1, least(p_limit, 200))
  )
  update public.scheduled_actions a
  set status = 'processing',
      attempted_at = now(),
      attempt_count = a.attempt_count + 1,
      next_attempt_at = null
  from due
  where a.id = due.id
  returning a.*;
$$;

create or replace function public.finish_scheduled_action_sent(p_action_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  action_row public.scheduled_actions%rowtype;
begin
  update public.scheduled_actions
  set status = 'sent', email_sent_at = now(), completed_at = now(), failure_reason = null
  where id = p_action_id and status = 'processing'
  returning * into action_row;
  if not found then return false; end if;

  insert into public.notifications (
    recipient_user_id, notification_type, title, message, related_task_id, related_scheduled_action_id
  ) values (
    action_row.creator_user_id, 'reminder_sent', 'Reminder sent',
    'Your scheduled reminder to ' || action_row.recipient_name || ' was accepted by the email provider.',
    action_row.task_id, action_row.id
  ) on conflict (related_scheduled_action_id, notification_type) do nothing;
  return true;
end;
$$;

create or replace function public.fail_scheduled_action(p_action_id uuid, p_failure_reason text, p_max_attempts integer default 5)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  action_row public.scheduled_actions%rowtype;
  final_status text;
  retry_seconds integer;
begin
  select * into action_row
  from public.scheduled_actions
  where id = p_action_id and status = 'processing'
  for update;
  if not found then return null; end if;

  if action_row.attempt_count >= greatest(1, least(p_max_attempts, 10)) then
    final_status := 'failed';
    update public.scheduled_actions
    set status = final_status, failure_reason = left(p_failure_reason, 1000),
        completed_at = now(), next_attempt_at = null
    where id = p_action_id;
    insert into public.notifications (
      recipient_user_id, notification_type, title, message, related_task_id, related_scheduled_action_id
    ) values (
      action_row.creator_user_id, 'reminder_failed', 'Reminder failed',
      'Your scheduled reminder to ' || action_row.recipient_name || ' could not be sent after several attempts.',
      action_row.task_id, action_row.id
    ) on conflict (related_scheduled_action_id, notification_type) do nothing;
  else
    retry_seconds := least(3600, 15 * (2 ^ greatest(0, action_row.attempt_count - 1))::integer);
    final_status := 'scheduled';
    update public.scheduled_actions
    set status = final_status, failure_reason = left(p_failure_reason, 1000),
        next_attempt_at = now() + make_interval(secs => retry_seconds), completed_at = null
    where id = p_action_id;
  end if;
  return final_status;
end;
$$;

create or replace function public.acknowledge_guest_reminder(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  action_row public.scheduled_actions%rowtype;
  app_data jsonb;
  sender_name text;
  task_status text;
  task_index integer;
  ack_time timestamptz;
  was_new boolean := false;
begin
  select a.* into action_row
  from public.guest_reminder_tokens t
  join public.scheduled_actions a on a.id = t.scheduled_action_id
  where t.token_hash = p_token_hash
    and t.revoked_at is null
    and t.expires_at > now()
  for update of t, a;
  if not found then raise exception 'Reminder link is invalid or expired.' using errcode = 'P0002'; end if;

  select coalesce(nullif(username, ''), 'A Spectre user') into sender_name
  from public.profiles where id = action_row.creator_user_id;
  sender_name := coalesce(sender_name, 'A Spectre user');

  if action_row.acknowledged_at is null then
    was_new := true;
    ack_time := now();
    if action_row.task_id is not null then
      select data into app_data from public.spectre_data
      where owner_key = 'user:' || action_row.creator_user_id::text
      for update;
      if app_data is not null then
        select (item.ordinality - 1)::integer, item.value->>'status'
        into task_index, task_status
        from jsonb_array_elements(coalesce(app_data->'tasks', '[]'::jsonb)) with ordinality as item(value, ordinality)
        where item.value->>'id' = action_row.task_id
        limit 1;
        if task_index is not null and task_status in ('To Do', 'Pending') then
          app_data := jsonb_set(app_data, array['tasks', task_index::text, 'status'], to_jsonb('Acknowledged'::text), false);
          update public.spectre_data
          set data = app_data, revision = revision + 1, updated_at = now()
          where owner_key = 'user:' || action_row.creator_user_id::text;
          task_status := 'Acknowledged';
        end if;
      end if;
    end if;
    update public.scheduled_actions
    set acknowledged_at = ack_time, acknowledgment_source = 'guest_link'
    where id = action_row.id;
    insert into public.notifications (
      recipient_user_id, notification_type, title, message, related_task_id, related_scheduled_action_id
    ) values (
      action_row.creator_user_id, 'reminder_acknowledged', 'Reminder acknowledged',
      action_row.recipient_name || ' acknowledged your reminder to ' || action_row.message || '.',
      action_row.task_id, action_row.id
    ) on conflict (related_scheduled_action_id, notification_type) do nothing;
  else
    ack_time := action_row.acknowledged_at;
    if action_row.task_id is not null then
      select task.value->>'status' into task_status
      from public.spectre_data d,
        jsonb_array_elements(coalesce(d.data->'tasks', '[]'::jsonb)) as task(value)
      where d.owner_key = 'user:' || action_row.creator_user_id::text
        and task.value->>'id' = action_row.task_id
      limit 1;
    end if;
  end if;

  return jsonb_build_object(
    'id', action_row.id,
    'recipientName', action_row.recipient_name,
    'message', action_row.message,
    'scheduledAt', action_row.scheduled_at,
    'senderName', sender_name,
    'taskStatus', task_status,
    'acknowledgedAt', ack_time,
    'alreadyAcknowledged', not was_new
  );
end;
$$;

revoke all on function public.claim_due_scheduled_actions(integer) from public, anon, authenticated;
revoke all on function public.finish_scheduled_action_sent(uuid) from public, anon, authenticated;
revoke all on function public.fail_scheduled_action(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.acknowledge_guest_reminder(text) from public, anon, authenticated;
grant execute on function public.claim_due_scheduled_actions(integer) to service_role;
grant execute on function public.finish_scheduled_action_sent(uuid) to service_role;
grant execute on function public.fail_scheduled_action(uuid, text, integer) to service_role;
grant execute on function public.acknowledge_guest_reminder(text) to service_role;
