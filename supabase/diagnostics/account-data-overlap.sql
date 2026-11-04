-- Read-only diagnostic for the two named accounts. Run in Supabase SQL Editor.
-- It reports each account's task data separately and lists task IDs present in both.
select u.id as user_id, u.email,
       coalesce(jsonb_array_length(d.data->'tasks'), 0) as task_count,
       d.updated_at as data_updated_at
from auth.users u
left join public.spectre_data d on d.owner_key = 'user:' || u.id::text
where lower(u.email) in ('peterfwesh200@gmail.com', 'akabikepeter@gmail.com')
order by lower(u.email);

with target_users as (
  select id, email
  from auth.users
  where lower(email) in ('peterfwesh200@gmail.com', 'akabikepeter@gmail.com')
), task_rows as (
  select u.id as user_id, u.email, task.value as task
  from target_users u
  left join public.spectre_data d on d.owner_key = 'user:' || u.id::text
  cross join lateral jsonb_array_elements(coalesce(d.data->'tasks', '[]'::jsonb)) as task(value)
)
select email, user_id, task->>'id' as task_id, task->>'title' as title,
       task->>'due' as due, task->>'status' as status
from task_rows
order by lower(email), title, due;

-- Exact task IDs shared by both account rows are likely transferred guest-task copies.
with target_users as (
  select id, email
  from auth.users
  where lower(email) in ('peterfwesh200@gmail.com', 'akabikepeter@gmail.com')
), task_rows as (
  select u.id as user_id, u.email, task.value as task
  from target_users u
  left join public.spectre_data d on d.owner_key = 'user:' || u.id::text
  cross join lateral jsonb_array_elements(coalesce(d.data->'tasks', '[]'::jsonb)) as task(value)
)
select task->>'id' as task_id,
       array_agg(distinct email order by email) as accounts,
       max(task->>'title') as title,
       max(task->>'due') as due
from task_rows
where task->>'id' is not null
group by task->>'id'
having count(distinct user_id) > 1
order by title, due;
