create table if not exists public.task_invitations (
  id uuid primary key default gen_random_uuid(),
  task_id text not null,
  task_owner_user_id uuid not null references auth.users(id) on delete cascade,
  inviter_user_id uuid not null references auth.users(id) on delete cascade,
  invitee_email text not null check (invitee_email = lower(btrim(invitee_email))),
  permission text not null check (permission in ('viewer', 'editor')),
  token_hash text not null unique,
  status text not null default 'pending' check (status in ('pending','accepted','declined','expired','revoked')),
  accepted_by uuid references auth.users(id) on delete set null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists task_invitations_pending_unique
  on public.task_invitations (task_owner_user_id, task_id, invitee_email) where status = 'pending';
create index if not exists task_invitations_owner_task_idx
  on public.task_invitations (task_owner_user_id, task_id, created_at desc);

create table if not exists public.task_collaborators (
  id uuid primary key default gen_random_uuid(),
  task_id text not null,
  task_owner_user_id uuid not null references auth.users(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  permission text not null check (permission in ('viewer', 'editor')),
  joined_at timestamptz not null default now(),
  added_by uuid not null references auth.users(id) on delete cascade,
  unique (task_owner_user_id, task_id, user_id),
  check (task_owner_user_id <> user_id)
);
create index if not exists task_collaborators_member_idx
  on public.task_collaborators (user_id, joined_at desc);

create table if not exists public.task_comments (
  id uuid primary key default gen_random_uuid(),
  task_id text not null,
  task_owner_user_id uuid not null references auth.users(id) on delete cascade,
  author_user_id uuid not null references auth.users(id) on delete cascade,
  message text not null check (length(message) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists task_comments_task_idx
  on public.task_comments (task_owner_user_id, task_id, created_at);

alter table public.notifications alter column related_scheduled_action_id drop not null;
alter table public.notifications add column if not exists related_invitation_id uuid references public.task_invitations(id) on delete cascade;
alter table public.notifications add column if not exists related_collaboration_task_id text;
alter table public.notifications add column if not exists dedupe_key text;
alter table public.notifications drop constraint if exists notifications_notification_type_check;
alter table public.notifications add constraint notifications_notification_type_check check (notification_type in (
  'reminder_acknowledged','reminder_sent','reminder_failed',
  'collaboration_invitation_accepted','collaboration_invitation_declined',
  'collaboration_task_updated','collaboration_comment_added','collaboration_access_removed'
));
drop index if exists public.notifications_dedupe_key_idx;
create unique index notifications_dedupe_key_idx on public.notifications (dedupe_key);

alter table public.task_invitations enable row level security;
alter table public.task_collaborators enable row level security;
alter table public.task_comments enable row level security;
revoke all on public.task_invitations, public.task_collaborators, public.task_comments from anon, authenticated;
grant all on public.task_invitations, public.task_collaborators, public.task_comments to service_role;

-- Atomic invite creation prevents duplicate pending invites and limits each owner
-- to 20 invitations per rolling hour.
create or replace function public.create_task_invitation(
  p_task_id text, p_owner_user_id uuid, p_inviter_user_id uuid,
  p_invitee_email text, p_permission text, p_token_hash text, p_expires_at timestamptz
) returns public.task_invitations
language plpgsql security definer set search_path = public
as $$
declare result public.task_invitations%rowtype;
begin
  if p_owner_user_id <> p_inviter_user_id then raise exception 'Only the task owner can invite.' using errcode = '42501'; end if;
  if p_permission not in ('viewer','editor') then raise exception 'Invalid permission.' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext(p_owner_user_id::text));
  if (select count(*) from public.task_invitations where inviter_user_id = p_owner_user_id and created_at > now() - interval '1 hour') >= 20 then
    raise exception 'Invitation rate limit reached.' using errcode = 'P0001';
  end if;
  update public.task_invitations set status='expired',updated_at=now()
  where task_owner_user_id=p_owner_user_id and task_id=p_task_id and invitee_email=lower(btrim(p_invitee_email)) and status='pending' and expires_at<=now();
  if exists (
    select 1 from public.task_collaborators c join auth.users u on u.id=c.user_id
    where c.task_owner_user_id=p_owner_user_id and c.task_id=p_task_id and lower(u.email)=lower(btrim(p_invitee_email))
  ) then raise exception 'Person is already a collaborator.' using errcode = '23505'; end if;
  insert into public.task_invitations(task_id,task_owner_user_id,inviter_user_id,invitee_email,permission,token_hash,expires_at)
  values (p_task_id,p_owner_user_id,p_inviter_user_id,lower(btrim(p_invitee_email)),p_permission,p_token_hash,p_expires_at)
  returning * into result;
  return result;
end;
$$;

create or replace function public.accept_task_invitation(p_token_hash text, p_user_id uuid, p_email text)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare invite public.task_invitations%rowtype;
begin
  select * into invite from public.task_invitations where token_hash = p_token_hash for update;
  if not found then raise exception 'Invitation is invalid.' using errcode = 'P0002'; end if;
  if lower(btrim(p_email)) <> invite.invitee_email then raise exception 'Invitation belongs to another email.' using errcode = '42501'; end if;
  if invite.inviter_user_id = p_user_id then raise exception 'You cannot accept your own invitation.' using errcode = '42501'; end if;
  if invite.status = 'accepted' and invite.accepted_by = p_user_id then
    return jsonb_build_object('invitationId',invite.id,'taskId',invite.task_id,'ownerUserId',invite.task_owner_user_id,'permission',invite.permission,'status','accepted','alreadyAccepted',true);
  end if;
  if invite.status <> 'pending' then raise exception 'Invitation is no longer available.' using errcode = 'P0002'; end if;
  if invite.expires_at <= now() then
    update public.task_invitations set status='expired',updated_at=now() where id=invite.id;
    return jsonb_build_object('expired',true);
  end if;
  insert into public.task_collaborators(task_id,task_owner_user_id,user_id,permission,added_by)
  values (invite.task_id,invite.task_owner_user_id,p_user_id,invite.permission,invite.inviter_user_id)
  on conflict (task_owner_user_id,task_id,user_id) do update set permission=excluded.permission;
  update public.task_invitations set status='accepted',accepted_by=p_user_id,accepted_at=now(),updated_at=now() where id=invite.id;
  insert into public.notifications(recipient_user_id,notification_type,title,message,related_task_id,related_invitation_id,related_collaboration_task_id,dedupe_key)
  values (invite.task_owner_user_id,'collaboration_invitation_accepted','Invitation accepted','Someone accepted your task invitation.',invite.task_id,invite.id,invite.task_id,'invite-accepted:'||invite.id::text)
  on conflict (dedupe_key) do nothing;
  return jsonb_build_object('invitationId',invite.id,'taskId',invite.task_id,'ownerUserId',invite.task_owner_user_id,'permission',invite.permission,'status','accepted','alreadyAccepted',false);
end;
$$;

revoke all on function public.create_task_invitation(text,uuid,uuid,text,text,text,timestamptz) from public, anon, authenticated;
revoke all on function public.accept_task_invitation(text,uuid,text) from public, anon, authenticated;
grant execute on function public.create_task_invitation(text,uuid,uuid,text,text,text,timestamptz) to service_role;
grant execute on function public.accept_task_invitation(text,uuid,text) to service_role;
