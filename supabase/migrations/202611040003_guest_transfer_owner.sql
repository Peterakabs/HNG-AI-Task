-- A device guest workspace may be transferred to one authenticated account.
-- This prevents the same device's guest tasks from being copied into multiple accounts.
alter table public.guest_accounts
  add column if not exists transferred_to_user_id uuid references auth.users(id) on delete set null;

create index if not exists guest_accounts_transferred_to_user_idx
  on public.guest_accounts (transferred_to_user_id)
  where transferred_to_user_id is not null;
