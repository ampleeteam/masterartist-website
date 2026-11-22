-- Group, corporate, birthday and school deals. A pipeline beside workshop bookings.
-- Run after 20261122030000_saved_segments.sql. Safe to run more than once.
-- Does not change workshop_bookings or prices.

begin;

create table if not exists public.group_deals (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  kind          text not null default 'other',
  stage         text not null default 'enquiry',
  value_rm      int not null default 0,
  expected_on   date,
  headcount     int,
  owner         uuid,
  contact_id    uuid references public.contacts(id) on delete set null,
  company       text,
  notes         text,
  lost_reason   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz,
  created_by    uuid,
  constraint group_deals_title check (char_length(btrim(title)) between 1 and 140),
  constraint group_deals_kind check (kind in ('team_building', 'birthday', 'school', 'other')),
  constraint group_deals_stage check (stage in ('enquiry', 'proposal_sent', 'negotiating', 'won', 'lost')),
  constraint group_deals_value check (value_rm between 0 and 1000000),
  constraint group_deals_head check (headcount is null or headcount between 1 and 500),
  constraint group_deals_notes check (notes is null or char_length(notes) <= 4000)
);

create index if not exists group_deals_stage_idx on public.group_deals (stage, expected_on);

comment on table public.group_deals is
  'Team-building, birthday and school enquiries. Notes are staff notes, not WhatsApp text and not medical records. A won deal is not itself a workshop booking.';

alter table public.staff_tasks add column if not exists deal_id uuid references public.group_deals(id) on delete set null;

alter table public.group_deals enable row level security;
drop policy if exists group_deals_read on public.group_deals;
create policy group_deals_read on public.group_deals for select to authenticated
  using (private.can_section('customers', false) or private.can_bookings(false));
drop policy if exists group_deals_insert on public.group_deals;
create policy group_deals_insert on public.group_deals for insert to authenticated
  with check (private.can_section('customers', true) or private.can_bookings(true));
drop policy if exists group_deals_update on public.group_deals;
create policy group_deals_update on public.group_deals for update to authenticated
  using (private.can_section('customers', true) or private.can_bookings(true))
  with check (private.can_section('customers', true) or private.can_bookings(true));
drop policy if exists group_deals_delete on public.group_deals;
create policy group_deals_delete on public.group_deals for delete to authenticated
  using (private.can_section('customers', true) or private.can_bookings(true));

revoke all on public.group_deals from public, anon, authenticated;
grant select, insert, update, delete on public.group_deals to authenticated;

commit;
