-- Staff tasks and in-app reminders.
-- Run after 20261122010000_contact_identities_and_lead_score.sql.
-- Safe to run more than once. Does not delete follow_up_date or follow_up_note.

begin;

create table if not exists public.staff_tasks (
  id               uuid primary key default gen_random_uuid(),
  title            text not null,
  detail           text,
  kind             text not null default 'manual',
  assignee         uuid,
  due_on           date,
  status           text not null default 'open',
  contact_id       uuid references public.contacts(id) on delete cascade,
  booking_id       uuid references public.workshop_bookings(id) on delete cascade,
  conversation_id  uuid references public.conversations(id) on delete set null,
  created_at       timestamptz not null default now(),
  done_at          timestamptz,
  created_by       uuid,
  constraint staff_tasks_title check (char_length(btrim(title)) between 1 and 160),
  constraint staff_tasks_detail check (detail is null or char_length(detail) <= 2000),
  constraint staff_tasks_kind check (kind in ('manual', 'lead_no_reply', 'booking_unpaid', 'post_workshop_review', 'no_rebook')),
  constraint staff_tasks_status check (status in ('open', 'done', 'dismissed'))
);

create unique index if not exists staff_tasks_open_kind_idx
  on public.staff_tasks (kind, contact_id)
  where status = 'open' and kind <> 'manual' and contact_id is not null;
create index if not exists staff_tasks_assignee_idx on public.staff_tasks (assignee, due_on) where status = 'open';

comment on table public.staff_tasks is
  'Follow-ups for staff. Automatic titles name the rule. They do not copy WhatsApp text. The single follow_up_date on the contact is left in place.';

create table if not exists public.staff_notifications (
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid not null,
  task_id     uuid references public.staff_tasks(id) on delete cascade,
  title       text not null,
  read_at     timestamptz,
  created_at  timestamptz not null default now(),
  constraint staff_notifications_title check (char_length(title) <= 160)
);

comment on table public.staff_notifications is
  'In-app notice. Email to staff is not sent from here.';

create or replace function public.refresh_auto_tasks()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare n int := 0;
begin
  if auth.uid() is not null
     and not (private.can_section('customers', true) or private.can_bookings(true) or private.can_section('customers', false) or private.can_bookings(false)) then
    raise exception 'not allowed';
  end if;

  insert into public.staff_tasks (title, detail, kind, assignee, due_on, contact_id, conversation_id)
  select 'No reply in 24 hours', 'The last message was from the customer and nobody has replied.',
         'lead_no_reply', ct.owner, current_date, c.contact_id, c.id
  from public.conversations c
  join public.contacts ct on ct.id = c.contact_id
  where c.status = 'open' and c.last_direction = 'in'
    and c.last_inbound_at < now() - interval '24 hours'
    and not exists (
      select 1 from public.staff_tasks t
      where t.kind = 'lead_no_reply' and t.contact_id = c.contact_id and t.status = 'open'
    );
  get diagnostics n = row_count;

  insert into public.staff_tasks (title, detail, kind, assignee, due_on, contact_id, booking_id)
  select 'Booking not paid yet', b.session_name || ' is still ' || b.status || '.',
         'booking_unpaid', ct.owner, current_date, b.contact_id, b.id
  from public.workshop_bookings b
  left join public.contacts ct on ct.id = b.contact_id
  where b.status in ('requested', 'confirmed')
    and b.created_at < now() - interval '24 hours'
    and b.contact_id is not null
    and not exists (
      select 1 from public.staff_tasks t
      where t.kind = 'booking_unpaid' and t.contact_id = b.contact_id and t.status = 'open'
    );

  insert into public.staff_tasks (title, detail, kind, assignee, due_on, contact_id, booking_id)
  select 'Ask how the workshop went', b.session_name || ' was yesterday.',
         'post_workshop_review', ct.owner, current_date, b.contact_id, b.id
  from public.workshop_bookings b
  left join public.contacts ct on ct.id = b.contact_id
  where b.status = 'paid' and b.session_date = current_date - 1 and b.contact_id is not null
    and not exists (
      select 1 from public.staff_tasks t
      where t.kind = 'post_workshop_review' and t.booking_id = b.id and t.status = 'open'
    );

  insert into public.staff_tasks (title, detail, kind, assignee, due_on, contact_id)
  select 'No rebooking in 45 days', 'Their last workshop was more than 45 days ago.',
         'no_rebook', c.owner, current_date, c.id
  from public.contacts c
  where c.last_workshop_at is not null
    and c.last_workshop_at < current_date - 45
    and c.next_booking_date is null
    and not exists (
      select 1 from public.staff_tasks t
      where t.kind = 'no_rebook' and t.contact_id = c.id and t.status = 'open'
    );

  insert into public.staff_notifications (staff_id, task_id, title)
  select t.assignee, t.id, t.title
  from public.staff_tasks t
  where t.assignee is not null and t.status = 'open'
    and t.created_at > now() - interval '5 minutes'
    and not exists (select 1 from public.staff_notifications n where n.task_id = t.id);
  return n;
end;
$$;

revoke all on function public.refresh_auto_tasks() from public, anon;
grant execute on function public.refresh_auto_tasks() to authenticated;

alter table public.staff_tasks enable row level security;
alter table public.staff_notifications enable row level security;

drop policy if exists staff_tasks_read on public.staff_tasks;
create policy staff_tasks_read on public.staff_tasks for select to authenticated
  using (
    assignee = auth.uid()
    or private.can_section('customers', false)
    or private.can_bookings(false)
  );
drop policy if exists staff_tasks_write on public.staff_tasks;
create policy staff_tasks_write on public.staff_tasks for insert to authenticated
  with check (
    assignee = auth.uid()
    or private.can_section('customers', true)
    or private.can_bookings(true)
  );
drop policy if exists staff_tasks_update on public.staff_tasks;
create policy staff_tasks_update on public.staff_tasks for update to authenticated
  using (
    assignee = auth.uid()
    or private.can_section('customers', true)
    or private.can_bookings(true)
  )
  with check (
    assignee = auth.uid()
    or private.can_section('customers', true)
    or private.can_bookings(true)
  );

drop policy if exists staff_notifications_read on public.staff_notifications;
create policy staff_notifications_read on public.staff_notifications for select to authenticated
  using (staff_id = auth.uid() or private.can_section('customers', false) or private.can_bookings(false));
drop policy if exists staff_notifications_update on public.staff_notifications;
create policy staff_notifications_update on public.staff_notifications for update to authenticated
  using (staff_id = auth.uid())
  with check (staff_id = auth.uid());

revoke all on public.staff_tasks from public, anon, authenticated;
grant select, insert, update on public.staff_tasks to authenticated;
revoke all on public.staff_notifications from public, anon, authenticated;
grant select, update (read_at) on public.staff_notifications to authenticated;

commit;
