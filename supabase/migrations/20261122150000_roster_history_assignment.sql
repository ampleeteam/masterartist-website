-- Workshop history, the event roster, and inbox assignment rules.
-- Not applied. Safe to run more than once.

begin;

alter table public.workshop_bookings drop constraint if exists wb_status;
alter table public.workshop_bookings add constraint wb_status
  check (status in ('pending', 'requested', 'confirmed', 'paid', 'expired', 'cancelled', 'refunded', 'no_show', 'waitlist'));

alter table public.booking_participants add column if not exists attendance text;
alter table public.booking_participants add column if not exists amount_rm numeric;
alter table public.booking_participants drop constraint if exists booking_participants_attendance;
alter table public.booking_participants add constraint booking_participants_attendance
  check (attendance is null or attendance in ('attended', 'no_show'));

create or replace view public.customer_workshop_history
with (security_invoker = true) as
with links as (
  select c.id as contact_id, b.id as booking_id
  from public.contacts c
  join public.workshop_bookings b on b.contact_id = c.id or b.booker_contact_id = c.id
  union
  select g.guardian_contact_id, bp.booking_id
  from public.contact_guardians g
  join public.booking_participants bp on bp.participant_id = g.participant_id
  union
  select p.contact_id, bp.booking_id
  from public.participants p
  join public.booking_participants bp on bp.participant_id = p.id
  where p.contact_id is not null
),
names as (
  select bp.booking_id, string_agg(p.full_name, ', ' order by p.full_name) as attendees
  from public.booking_participants bp
  join public.participants p on p.id = bp.participant_id
  group by bp.booking_id
),
pay as (
  select booking_id, sum(amount_rm - refund_rm) as net, count(*) as n
  from public.payments
  group by booking_id
)
select
  l.contact_id,
  b.id as booking_id,
  b.session_id,
  coalesce(s.title, b.session_name) as title,
  coalesce(s.starts_at, b.session_date::timestamptz) as session_at,
  b.session_date,
  b.session_when,
  coalesce(names.attendees, b.child_name, b.name) as attendees,
  case
    when b.status = 'no_show' then 'no-show'
    when b.status = 'cancelled' then 'cancelled'
    when b.status = 'refunded' then 'refunded'
    when b.session_date > current_date and b.status in ('requested', 'confirmed', 'paid', 'pending') then 'upcoming'
    when b.session_date <= current_date and b.status in ('paid', 'confirmed') then 'attended'
    else b.status
  end as status_chip,
  case
    when not private.can_see_customer_spend() then null
    when coalesce(pay.n, 0) > 0 then pay.net
    when b.status = 'paid' then b.amount::numeric
    else 0
  end as amount_paid_rm
from links l
join public.workshop_bookings b on b.id = l.booking_id
left join public.workshop_sessions s on s.id = b.session_id
left join names on names.booking_id = b.id
left join pay on pay.booking_id = b.id;

comment on view public.customer_workshop_history is
  'Every workshop for a customer, including a parent''s linked children. security_invoker. Amounts are null for marketing.';

revoke all on public.customer_workshop_history from public, anon;
grant select on public.customer_workshop_history to authenticated;

create or replace view public.session_roster
with (security_invoker = true) as
with headcount as (
  select booking_id, count(*) as n from public.booking_participants group by booking_id
),
pay as (
  select booking_id, sum(amount_rm - refund_rm) as net, count(*) as n
  from public.payments group by booking_id
)
select
  b.session_id,
  b.id as booking_id,
  p.id as participant_id,
  p.full_name as participant_name,
  p.date_of_birth,
  case
    when p.date_of_birth is null then null
    else extract(year from age(coalesce(s.starts_at::date, b.session_date), p.date_of_birth))::int
  end as age_at_session,
  coalesce(booker.id, buyer.id) as booker_contact_id,
  coalesce(booker.preferred_name, booker.first_name, buyer.first_name) as booker_name,
  coalesce(booker.whatsapp_e164, booker.phone, buyer.whatsapp_e164, buyer.phone) as booker_phone,
  case
    when bp.attendance = 'no_show' or b.status = 'no_show' then 'no-show'
    when bp.attendance = 'attended' then 'attended'
    when b.status = 'waitlist' then 'waitlist'
    when b.status = 'cancelled' then 'cancelled'
    when b.status = 'refunded' then 'refunded'
    when b.status = 'paid' then 'paid'
    when b.status = 'confirmed' then 'confirmed'
    else 'pending payment'
  end as status,
  case
    when not private.can_see_customer_spend() then null
    when bp.amount_rm is not null then bp.amount_rm
    when coalesce(pay.n, 0) > 0 then round(pay.net / greatest(headcount.n, 1), 2)
    when b.status in ('paid', 'refunded') then round(b.amount::numeric / greatest(headcount.n, 1), 2)
    else 0
  end as amount_paid_rm,
  case when private.can_see_customer_spend() and headcount.n > 1 and bp.amount_rm is null then b.amount else null end as family_amount_rm,
  (h.participant_id is not null) as health_flag
from public.workshop_bookings b
join public.booking_participants bp on bp.booking_id = b.id
join public.participants p on p.id = bp.participant_id
left join public.workshop_sessions s on s.id = b.session_id
left join public.contacts booker on booker.id = b.booker_contact_id
left join public.contacts buyer on buyer.id = b.contact_id
left join headcount on headcount.booking_id = b.id
left join pay on pay.booking_id = b.id
left join public.participant_health h on h.participant_id = p.id
  and (coalesce(h.allergies, '') <> '' or coalesce(h.medical_notes, '') <> '' or coalesce(h.special_needs, '') <> '');

comment on view public.session_roster is
  'One row per attendee. security_invoker, so marketing cannot read health text. Amounts are null unless the viewer may see customer spend. The health column is only a flag.';

revoke all on public.session_roster from public, anon;
grant select on public.session_roster to authenticated;

create table if not exists public.staff_duty (
  staff_id  uuid primary key references public.profiles(id) on delete cascade,
  on_duty   boolean not null default true
);

create table if not exists public.assignment_rules (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null,
  match      text not null,
  staff_id   uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint assignment_rules_kind check (kind in ('category', 'source')),
  constraint assignment_rules_match check (char_length(btrim(match)) between 1 and 40)
);

create table if not exists public.staff_push_subscriptions (
  id        uuid primary key default gen_random_uuid(),
  staff_id  uuid not null references public.profiles(id) on delete cascade,
  endpoint  text not null unique,
  p256dh    text,
  auth      text,
  created_at timestamptz not null default now()
);

comment on table public.assignment_rules is
  'A workshop category or source that should go to one person, for example kids to Alysha. Everyone else is round-robin among staff who are on duty.';

alter table public.staff_duty enable row level security;
alter table public.assignment_rules enable row level security;
alter table public.staff_push_subscriptions enable row level security;

drop policy if exists staff_duty_read on public.staff_duty;
create policy staff_duty_read on public.staff_duty for select to authenticated
  using (private.can_bookings(false) and private.not_marketing());
drop policy if exists staff_duty_write on public.staff_duty;
create policy staff_duty_write on public.staff_duty for all to authenticated
  using (private.can_bookings(true) and private.not_marketing())
  with check (private.can_bookings(true) and private.not_marketing());

drop policy if exists assignment_rules_read on public.assignment_rules;
create policy assignment_rules_read on public.assignment_rules for select to authenticated
  using (private.can_bookings(false) and private.not_marketing());
drop policy if exists assignment_rules_write on public.assignment_rules;
create policy assignment_rules_write on public.assignment_rules for all to authenticated
  using (private.can_bookings(true) and private.not_marketing())
  with check (private.can_bookings(true) and private.not_marketing());

drop policy if exists staff_push_own on public.staff_push_subscriptions;
create policy staff_push_own on public.staff_push_subscriptions for all to authenticated
  using (staff_id = auth.uid()) with check (staff_id = auth.uid());

revoke all on public.staff_duty, public.assignment_rules, public.staff_push_subscriptions from anon, public;
grant select, insert, update, delete on public.staff_duty to authenticated;
grant select, insert, update, delete on public.assignment_rules to authenticated;
grant select, insert, update, delete on public.staff_push_subscriptions to authenticated;

create or replace function public.notify_staff(p_staff uuid, p_title text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not private.can_bookings(true) or not private.not_marketing() then
    raise exception 'not allowed';
  end if;
  insert into public.staff_notifications (staff_id, title)
  values (p_staff, left(btrim(p_title), 160));
end;
$$;

revoke all on function public.notify_staff(uuid, text) from public, anon;
grant execute on function public.notify_staff(uuid, text) to authenticated;

commit;
