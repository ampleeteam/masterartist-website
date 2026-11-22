-- Per-workshop ads, payments and costs. Run after workshop sessions.
-- Do not apply to production until go-live approval. Does not change prices on the website.

begin;

create table if not exists public.finance_viewers (
  staff_id   uuid primary key references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

do $$ begin
  alter table public.finance_viewers
    add constraint finance_viewers_staff_fk foreign key (staff_id) references public.profiles(id) on delete cascade;
exception when duplicate_object then
  null;
end $$;

comment on table public.finance_viewers is
  'Staff, other than admins, who may read workshop profit and loss.';

create or replace function private.can_see_finance()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active and (
      p.role = 'admin'::user_role
      or exists (select 1 from public.finance_viewers f where f.staff_id = p.id)
    )
  );
$$;

revoke all on function private.can_see_finance() from public, anon;
grant execute on function private.can_see_finance() to authenticated;

create table if not exists public.ad_entities (
  id         text primary key,
  name       text not null,
  account_id text not null default 'act_1612497836946260',
  created_at timestamptz not null default now()
);

create table if not exists public.ad_event_links (
  id          uuid primary key default gen_random_uuid(),
  ad_id       text not null references public.ad_entities(id) on delete cascade,
  format      text,
  session_id  text references public.workshop_sessions(id) on delete cascade,
  weight      numeric not null default 1,
  valid_from  date not null default current_date,
  valid_to    date,
  constraint ad_event_links_weight check (weight > 0 and weight <= 1),
  constraint ad_event_links_target check (format is not null or session_id is not null)
);

create table if not exists public.ad_daily_metrics (
  ad_id                      text not null references public.ad_entities(id) on delete cascade,
  day                        date not null,
  spend_rm                   numeric not null default 0,
  impressions                int not null default 0,
  clicks                     int not null default 0,
  wa_conversations_started   int not null default 0,
  leads                      int not null default 0,
  primary key (ad_id, day),
  constraint ad_daily_metrics_nonneg check (
    spend_rm >= 0 and impressions >= 0 and clicks >= 0 and wa_conversations_started >= 0 and leads >= 0
  )
);

create table if not exists public.payments (
  id            uuid primary key default gen_random_uuid(),
  booking_id    uuid references public.workshop_bookings(id) on delete set null,
  session_id    text references public.workshop_sessions(id) on delete set null,
  method        text not null,
  amount_rm     numeric not null,
  fee_rm        numeric not null default 0,
  refund_rm     numeric not null default 0,
  provider_ref  text not null unique,
  paid_at       timestamptz not null default now(),
  constraint payments_method check (method in ('stripe', 'cash', 'bank', 'other')),
  constraint payments_amounts check (amount_rm >= 0 and fee_rm >= 0 and refund_rm >= 0 and refund_rm <= amount_rm)
);

create table if not exists public.event_costs (
  id            uuid primary key default gen_random_uuid(),
  session_id    text not null references public.workshop_sessions(id) on delete cascade,
  category      text not null,
  amount_rm     numeric not null,
  description   text,
  receipt_path  text,
  uploaded_by   uuid not null default auth.uid(),
  created_at    timestamptz not null default now(),
  constraint event_costs_category check (category in ('materials', 'instructor', 'venue', 'overhead', 'food', 'printing', 'other')),
  constraint event_costs_amount check (amount_rm >= 0 and amount_rm <= 1000000)
);

create table if not exists public.cost_allocations (
  id          uuid primary key default gen_random_uuid(),
  cost_id     uuid not null references public.event_costs(id) on delete cascade,
  session_id  text not null references public.workshop_sessions(id) on delete cascade,
  weight      numeric not null default 1,
  constraint cost_allocations_weight check (weight > 0 and weight <= 1)
);

comment on table public.event_costs is
  'A cost for one workshop. Any active staff member can add their own row and a receipt photo.';

insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

drop policy if exists receipts_staff_insert on storage.objects;
create policy receipts_staff_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'receipts'
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.active)
  );
drop policy if exists receipts_finance_read on storage.objects;
create policy receipts_finance_read on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and (private.can_see_finance() or owner = auth.uid()));

alter table public.ad_entities enable row level security;
alter table public.ad_event_links enable row level security;
alter table public.ad_daily_metrics enable row level security;
alter table public.payments enable row level security;
alter table public.event_costs enable row level security;
alter table public.cost_allocations enable row level security;
alter table public.finance_viewers enable row level security;

drop policy if exists finance_read_ads on public.ad_entities;
create policy finance_read_ads on public.ad_entities for select to authenticated using (private.can_see_finance());
drop policy if exists finance_read_links on public.ad_event_links;
create policy finance_read_links on public.ad_event_links for select to authenticated using (private.can_see_finance());
drop policy if exists finance_read_metrics on public.ad_daily_metrics;
create policy finance_read_metrics on public.ad_daily_metrics for select to authenticated using (private.can_see_finance());
drop policy if exists finance_write_metrics on public.ad_daily_metrics;
create policy finance_write_metrics on public.ad_daily_metrics for insert to authenticated with check (private.can_see_finance());
drop policy if exists finance_read_payments on public.payments;
create policy finance_read_payments on public.payments for select to authenticated using (private.can_see_finance());
drop policy if exists finance_read_viewers on public.finance_viewers;
create policy finance_read_viewers on public.finance_viewers for select to authenticated using (private.can_see_finance());
drop policy if exists finance_viewers_admin_write on public.finance_viewers;
create policy finance_viewers_admin_write on public.finance_viewers for all to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active and p.role = 'admin'::user_role
  ))
  with check (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active and p.role = 'admin'::user_role
  ));

drop policy if exists event_costs_read on public.event_costs;
create policy event_costs_read on public.event_costs for select to authenticated
  using (private.can_see_finance() or uploaded_by = auth.uid());
drop policy if exists event_costs_insert on public.event_costs;
create policy event_costs_insert on public.event_costs for insert to authenticated
  with check (
    uploaded_by = auth.uid()
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.active)
  );

drop policy if exists cost_allocations_read on public.cost_allocations;
create policy cost_allocations_read on public.cost_allocations for select to authenticated using (private.can_see_finance());

grant select on public.ad_entities, public.ad_event_links, public.ad_daily_metrics, public.payments, public.finance_viewers to authenticated;
grant select, insert on public.event_costs to authenticated;
grant select on public.cost_allocations to authenticated;

create or replace view public.event_financials
with (security_invoker = true) as
select
  s.id as session_id,
  s.title,
  s.starts_at,
  s.capacity,
  coalesce(spend.ad_spend_rm, 0) as ad_spend_rm,
  coalesce(spend.conversations, 0) as wa_conversations,
  coalesce(spend.leads, 0) as leads,
  case when coalesce(spend.conversations, 0) = 0 then null else round(spend.ad_spend_rm / spend.conversations, 2) end as cost_per_conversation_rm,
  case when coalesce(spend.leads, 0) = 0 then null else round(spend.ad_spend_rm / spend.leads, 2) end as cpa_rm,
  coalesce(pay.revenue_rm, 0) as revenue_rm,
  coalesce(pay.fee_rm, 0) as fee_rm,
  coalesce(pay.refund_rm, 0) as refund_rm,
  coalesce(pay.revenue_rm, 0) - coalesce(pay.fee_rm, 0) - coalesce(pay.refund_rm, 0) as net_revenue_rm,
  case when coalesce(spend.ad_spend_rm, 0) = 0 then null
    else round((coalesce(pay.revenue_rm, 0) - coalesce(pay.fee_rm, 0) - coalesce(pay.refund_rm, 0)) / spend.ad_spend_rm, 2) end as roas,
  coalesce(costs.materials, 0) as cost_materials_rm,
  coalesce(costs.instructor, 0) as cost_instructor_rm,
  coalesce(costs.venue, 0) as cost_venue_rm,
  coalesce(costs.overhead, 0) as cost_overhead_rm,
  coalesce(costs.food, 0) as cost_food_rm,
  coalesce(costs.printing, 0) as cost_printing_rm,
  coalesce(costs.other, 0) as cost_other_rm,
  coalesce(spend.ad_spend_rm, 0) + coalesce(costs.total, 0) as total_cost_rm,
  (coalesce(pay.revenue_rm, 0) - coalesce(pay.fee_rm, 0) - coalesce(pay.refund_rm, 0))
    - (coalesce(spend.ad_spend_rm, 0) + coalesce(costs.total, 0)) as gross_profit_rm,
  case when coalesce(pay.revenue_rm, 0) - coalesce(pay.fee_rm, 0) - coalesce(pay.refund_rm, 0) = 0 then null
    else round((
      (coalesce(pay.revenue_rm, 0) - coalesce(pay.fee_rm, 0) - coalesce(pay.refund_rm, 0))
      - (coalesce(spend.ad_spend_rm, 0) + coalesce(costs.total, 0))
    ) / (coalesce(pay.revenue_rm, 0) - coalesce(pay.fee_rm, 0) - coalesce(pay.refund_rm, 0)), 4) end as margin,
  case when s.capacity is null or s.capacity = 0 then null
    else round(coalesce(filled.seats, 0)::numeric / s.capacity, 4) end as fill_rate
from public.workshop_sessions s
left join lateral (
  select
    coalesce(sum(m.spend_rm * l.weight), 0) as ad_spend_rm,
    coalesce(sum(m.wa_conversations_started), 0) as conversations,
    coalesce(sum(m.leads), 0) as leads
  from public.ad_event_links l
  join public.ad_daily_metrics m on m.ad_id = l.ad_id
  where (l.session_id = s.id or (l.session_id is null and l.format = s.format))
    and m.day >= l.valid_from
    and (l.valid_to is null or m.day <= l.valid_to)
) spend on true
left join lateral (
  select coalesce(sum(amount_rm), 0) as revenue_rm, coalesce(sum(fee_rm), 0) as fee_rm, coalesce(sum(refund_rm), 0) as refund_rm
  from public.payments p where p.session_id = s.id
) pay on true
left join lateral (
  select
    coalesce(sum(amount_rm) filter (where category = 'materials'), 0) as materials,
    coalesce(sum(amount_rm) filter (where category = 'instructor'), 0) as instructor,
    coalesce(sum(amount_rm) filter (where category = 'venue'), 0) as venue,
    coalesce(sum(amount_rm) filter (where category = 'overhead'), 0) as overhead,
    coalesce(sum(amount_rm) filter (where category = 'food'), 0) as food,
    coalesce(sum(amount_rm) filter (where category = 'printing'), 0) as printing,
    coalesce(sum(amount_rm) filter (where category = 'other'), 0) as other,
    coalesce(sum(amount_rm), 0) as total
  from public.event_costs c where c.session_id = s.id
) costs on true
left join lateral (
  select count(*) filter (where stage in ('paid', 'attended')) as seats
  from public.event_enrolments e where e.session_id = s.id
) filled on true
where private.can_see_finance();

comment on view public.event_financials is
  'Per-session profit and loss. security_invoker, so only admins and finance_viewers can read the underlying rows.';

revoke all on public.ad_entities, public.ad_event_links, public.ad_daily_metrics, public.payments, public.event_costs, public.cost_allocations, public.finance_viewers from anon, public;
revoke all on public.event_financials from public, anon;
grant select on public.event_financials to authenticated;

-- Admin-only extract for a separate finance system. finance_viewers do not receive this.
create or replace function public.finance_export()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ok boolean;
begin
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active and p.role = 'admin'::user_role
  ) into ok;
  if not coalesce(ok, false) then
    return jsonb_build_object('ok', false, 'reason', 'admin only');
  end if;
  return jsonb_build_object(
    'ok', true,
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'booking_id', p.booking_id, 'session_id', p.session_id,
        'method', p.method, 'amount_rm', p.amount_rm, 'fee_rm', p.fee_rm,
        'refund_rm', p.refund_rm, 'provider_ref', p.provider_ref, 'paid_at', p.paid_at
      ) order by p.paid_at desc)
      from public.payments p
    ), '[]'::jsonb),
    'costs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'session_id', c.session_id, 'category', c.category,
        'amount_rm', c.amount_rm, 'description', c.description,
        'receipt_path', c.receipt_path, 'uploaded_by', c.uploaded_by, 'created_at', c.created_at
      ) order by c.created_at desc)
      from public.event_costs c
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.finance_export() from public, anon;
grant execute on function public.finance_export() to authenticated;

commit;
