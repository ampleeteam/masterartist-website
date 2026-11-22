-- Workshop sessions from the website JSON, and one enrolment row per customer and session.
-- Run after the shared inbox migration. Safe to run more than once.
-- Do not apply to production until go-live approval. Does not delete bookings.

begin;

create table if not exists public.workshop_sessions (
  id           text primary key,
  format       text not null,
  title        text not null,
  starts_at    timestamptz not null,
  ends_at      timestamptz,
  room         text,
  capacity     int,
  price_rm     int not null default 0,
  status       text not null default 'scheduled',
  instructor   text,
  updated_at   timestamptz not null default now(),
  constraint workshop_sessions_status check (status in ('scheduled', 'cancelled', 'completed')),
  constraint workshop_sessions_cap check (capacity is null or capacity between 0 and 500),
  constraint workshop_sessions_price check (price_rm between 0 and 100000)
);

comment on table public.workshop_sessions is
  'One row per dated workshop. id matches the session id in assets/sessions.json.';

create table if not exists public.event_enrolments (
  id               uuid primary key default gen_random_uuid(),
  contact_id       uuid not null references public.contacts(id) on delete cascade,
  session_id       text not null references public.workshop_sessions(id) on delete cascade,
  conversation_id  uuid references public.conversations(id) on delete set null,
  stage            text not null default 'enquired',
  source           text,
  updated_at       timestamptz not null default now(),
  constraint event_enrolments_stage check (stage in ('enquired', 'interested', 'enrolled', 'paid', 'attended', 'cancelled')),
  constraint event_enrolments_pair unique (contact_id, session_id)
);

comment on table public.event_enrolments is
  'Where a customer is with one workshop. The inbox shows this as the event chip. It is not a payment.';

create index if not exists event_enrolments_conversation_idx on public.event_enrolments (conversation_id);

create or replace function public.sync_workshop_sessions(p jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  row jsonb;
  n int := 0;
  v_start timestamptz;
  v_end timestamptz;
begin
  if auth.uid() is not null and not (private.can_bookings(true) or private.can_section('customers', true)) then
    raise exception 'Not allowed to sync sessions';
  end if;
  if jsonb_typeof(p) = 'object' then p := coalesce(p->'sessions', '[]'::jsonb); end if;
  if jsonb_typeof(p) <> 'array' then return 0; end if;
  for row in select value from jsonb_array_elements(p) loop
    v_start := ((row->>'date') || ' ' || coalesce(row->>'time', '00:00'))::timestamp at time zone 'Asia/Kuala_Lumpur';
    v_end := case when nullif(row->>'end', '') is null then null
      else ((row->>'date') || ' ' || (row->>'end'))::timestamp at time zone 'Asia/Kuala_Lumpur' end;
    insert into public.workshop_sessions (id, format, title, starts_at, ends_at, capacity, price_rm, status)
    values (
      row->>'id',
      coalesce(row->>'format', 'workshop'),
      coalesce(nullif(row->>'theme', ''), row->>'name', row->>'id'),
      v_start,
      v_end,
      nullif(row->>'cap', '')::int,
      coalesce(nullif(row->>'price', '')::int, 0),
      'scheduled'
    )
    on conflict (id) do update set
      format = excluded.format,
      title = excluded.title,
      starts_at = excluded.starts_at,
      ends_at = excluded.ends_at,
      capacity = excluded.capacity,
      price_rm = excluded.price_rm,
      updated_at = now();
    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke all on function public.sync_workshop_sessions(jsonb) from public, anon;
grant execute on function public.sync_workshop_sessions(jsonb) to authenticated;

alter table public.workshop_sessions enable row level security;
alter table public.event_enrolments enable row level security;

drop policy if exists workshop_sessions_read on public.workshop_sessions;
create policy workshop_sessions_read on public.workshop_sessions for select to authenticated
  using (private.can_section('customers', false) or private.can_bookings(false));
drop policy if exists workshop_sessions_write on public.workshop_sessions;
create policy workshop_sessions_write on public.workshop_sessions for all to authenticated
  using (private.can_bookings(true) or private.can_section('customers', true))
  with check (private.can_bookings(true) or private.can_section('customers', true));

drop policy if exists event_enrolments_read on public.event_enrolments;
create policy event_enrolments_read on public.event_enrolments for select to authenticated
  using (private.can_section('customers', false) or private.can_bookings(false));
drop policy if exists event_enrolments_write on public.event_enrolments;
create policy event_enrolments_write on public.event_enrolments for all to authenticated
  using (private.can_bookings(true) or private.can_section('customers', true))
  with check (private.can_bookings(true) or private.can_section('customers', true));

grant select, insert, update on public.workshop_sessions to authenticated;
grant select, insert, update on public.event_enrolments to authenticated;

commit;
