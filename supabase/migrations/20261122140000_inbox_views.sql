-- Inbox saved views, and the stats the inbox filters read.
-- Not applied. Safe to run more than once. Does not seed saved views.

begin;

create or replace function private.can_see_customer_spend()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active and p.role <> 'marketing'::user_role
      and (
        p.role = 'admin'::user_role
        or exists (select 1 from public.finance_viewers f where f.staff_id = p.id)
        or exists (
          select 1 from public.role_permissions rp
          where rp.role = p.role and rp.section = 'bookings' and rp.can_read
        )
      )
  );
$$;

revoke all on function private.can_see_customer_spend() from public, anon;
grant execute on function private.can_see_customer_spend() to authenticated;

create or replace view public.customer_lifetime_stats
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
pay as (
  select booking_id, sum(amount_rm - refund_rm) as net, count(*) as n
  from public.payments
  group by booking_id
),
one as (
  select
    l.contact_id,
    b.id as booking_id,
    b.status,
    b.session_date,
    case
      when not private.can_see_customer_spend() then null
      when coalesce(pay.n, 0) > 0 then pay.net
      when b.status = 'paid' then b.amount::numeric
      else 0
    end as net_rm
  from links l
  join public.workshop_bookings b on b.id = l.booking_id
  left join pay on pay.booking_id = b.id
)
select
  c.id as contact_id,
  case when not private.can_see_customer_spend() then null else coalesce(sum(one.net_rm), 0) end as lifetime_spend_rm,
  count(distinct one.booking_id) filter (
    where one.status not in ('cancelled', 'refunded')
  )::int as bookings_count,
  count(distinct one.booking_id) filter (
    where one.session_date <= current_date and one.status in ('paid', 'confirmed')
  )::int as attended_count,
  count(distinct one.booking_id) filter (
    where one.session_date > current_date and one.status in ('requested', 'confirmed', 'paid', 'pending')
  )::int as upcoming_count,
  min(one.session_date) as first_booking_at,
  max(one.session_date) filter (
    where one.session_date <= current_date and one.status in ('paid', 'confirmed')
  ) as last_attended_at,
  case
    when not private.can_see_customer_spend() then null
    when count(distinct one.booking_id) filter (where one.status not in ('cancelled', 'refunded')) = 0 then null
    else round(
      coalesce(sum(one.net_rm), 0)
      / count(distinct one.booking_id) filter (where one.status not in ('cancelled', 'refunded')),
      2
    )
  end as avg_spend
from public.contacts c
left join one on one.contact_id = c.id
group by c.id;

comment on view public.customer_lifetime_stats is
  'Per customer, including a parent''s linked participants. security_invoker. Spend is null unless the viewer is admin, bookings, or a finance viewer. Marketing is excluded.';

revoke all on public.customer_lifetime_stats from public, anon;
grant select on public.customer_lifetime_stats to authenticated;

create table if not exists public.inbox_saved_views (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  owner       uuid references public.profiles(id) on delete cascade,
  shared      boolean not null default false,
  definition  jsonb not null default '{"view":"newest","filters":{}}',
  created_at  timestamptz not null default now(),
  constraint inbox_saved_views_name check (char_length(btrim(name)) between 1 and 80),
  constraint inbox_saved_views_def check (jsonb_typeof(definition) = 'object')
);

comment on table public.inbox_saved_views is
  'A named inbox view plus its filters. Personal unless shared. Default seeds are not stored here.';

alter table public.inbox_saved_views enable row level security;

drop policy if exists inbox_saved_views_read on public.inbox_saved_views;
create policy inbox_saved_views_read on public.inbox_saved_views for select to authenticated
  using (
    private.can_bookings(false)
    and private.not_marketing()
    and (owner = auth.uid() or shared)
  );
drop policy if exists inbox_saved_views_insert on public.inbox_saved_views;
create policy inbox_saved_views_insert on public.inbox_saved_views for insert to authenticated
  with check (
    private.can_bookings(false)
    and private.not_marketing()
    and owner = auth.uid()
  );
drop policy if exists inbox_saved_views_update on public.inbox_saved_views;
create policy inbox_saved_views_update on public.inbox_saved_views for update to authenticated
  using (owner = auth.uid() and private.not_marketing())
  with check (owner = auth.uid() and private.not_marketing());
drop policy if exists inbox_saved_views_delete on public.inbox_saved_views;
create policy inbox_saved_views_delete on public.inbox_saved_views for delete to authenticated
  using (owner = auth.uid() and private.not_marketing());

revoke all on public.inbox_saved_views from anon, public;
grant select, insert, update, delete on public.inbox_saved_views to authenticated;

commit;
