-- Many ads can point at one workshop, event, format or group booking.
-- A chat keeps the first touch and the latest touch. Not applied.
-- Safe to run more than once. Anon may insert a click, and cannot read other clicks.

begin;

create table if not exists public.ad_links (
  id            uuid primary key default gen_random_uuid(),
  platform      text not null,
  account_id    text,
  campaign_id   text,
  campaign_name text,
  adset_id      text,
  adset_name    text,
  ad_id         text,
  ad_name       text,
  creative_label text,
  creative_url  text,
  ref_code      text unique,
  utm_campaign  text,
  utm_content   text,
  target_type   text not null default 'general',
  target_id     text,
  active_from   date,
  active_to     date,
  landing_url   text,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  constraint ad_links_platform check (platform in ('meta', 'google', 'tiktok', 'other')),
  constraint ad_links_target check (target_type in ('session', 'event', 'group_booking', 'format', 'general')),
  constraint ad_links_ref check (ref_code is null or ref_code ~ '^MA-[A-Z0-9-]{4,32}$')
);

comment on table public.ad_links is
  'One row per ad. Several rows may share the same target_id. ref_code is the short code appended to wa.me text.';

create table if not exists public.click_refs (
  id            uuid primary key default gen_random_uuid(),
  ref_code      text,
  gclid         text,
  wbraid        text,
  gbraid        text,
  ttclid        text,
  fbclid        text,
  utm_source    text,
  utm_medium    text,
  utm_campaign  text,
  utm_content   text,
  landing_page  text,
  created_at    timestamptz not null default now()
);

comment on table public.click_refs is
  'A website click, kept so a later WhatsApp ref code can be matched back to the ad click.';

create table if not exists public.attribution_events (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid,
  contact_id       uuid,
  method           text not null,
  ad_link_id       uuid references public.ad_links(id) on delete set null,
  target_type      text,
  target_id        text,
  note             text,
  created_at       timestamptz not null default now(),
  constraint attribution_events_method check (method in ('ad_referral', 'ref_code', 'utm_click', 'keyword_ai', 'manual'))
);

alter table public.conversations add column if not exists first_platform text;
alter table public.conversations add column if not exists first_ad_link_id uuid references public.ad_links(id) on delete set null;
alter table public.conversations add column if not exists first_campaign text;
alter table public.conversations add column if not exists first_ad text;
alter table public.conversations add column if not exists first_method text;
alter table public.conversations add column if not exists last_platform text;
alter table public.conversations add column if not exists last_ad_link_id uuid references public.ad_links(id) on delete set null;
alter table public.conversations add column if not exists last_campaign text;
alter table public.conversations add column if not exists last_ad text;
alter table public.conversations add column if not exists last_method text;
alter table public.conversations add column if not exists fbclid text;
alter table public.conversations add column if not exists gclid text;
alter table public.conversations add column if not exists wbraid text;
alter table public.conversations add column if not exists gbraid text;
alter table public.conversations add column if not exists ttclid text;

alter table public.contacts add column if not exists last_ad_link_id uuid references public.ad_links(id) on delete set null;
alter table public.contacts add column if not exists gclid text;
alter table public.contacts add column if not exists ttclid text;

create table if not exists public.conversion_uploads (
  id          uuid primary key default gen_random_uuid(),
  platform    text not null,
  click_id    text,
  event_name  text not null,
  enabled     boolean not null default false,
  created_at  timestamptz not null default now()
);

comment on table public.conversion_uploads is
  'Stub only. Sending conversions to Meta or Google stays off until a later go-live. No API keys live here.';

alter table public.ad_links enable row level security;
alter table public.click_refs enable row level security;
alter table public.attribution_events enable row level security;
alter table public.conversion_uploads enable row level security;

drop policy if exists ad_links_read on public.ad_links;
create policy ad_links_read on public.ad_links for select to authenticated
  using (private.can_bookings(false) or private.can_section('customers', false));
drop policy if exists ad_links_write on public.ad_links;
create policy ad_links_write on public.ad_links for all to authenticated
  using (private.can_bookings(true)) with check (private.can_bookings(true));

drop policy if exists click_refs_insert on public.click_refs;
create policy click_refs_insert on public.click_refs for insert to anon, authenticated
  with check (true);
drop policy if exists click_refs_read on public.click_refs;
create policy click_refs_read on public.click_refs for select to authenticated
  using (private.can_bookings(false));

drop policy if exists attribution_events_read on public.attribution_events;
create policy attribution_events_read on public.attribution_events for select to authenticated
  using (private.can_bookings(false) or private.can_section('customers', false));
drop policy if exists attribution_events_write on public.attribution_events;
create policy attribution_events_write on public.attribution_events for insert to authenticated
  with check (private.can_bookings(true));

drop policy if exists conversion_uploads_staff on public.conversion_uploads;
create policy conversion_uploads_staff on public.conversion_uploads for select to authenticated
  using (private.can_see_finance());

revoke all on public.ad_links, public.click_refs, public.attribution_events, public.conversion_uploads from anon, public;
grant select, insert, update, delete on public.ad_links to authenticated;
grant insert on public.click_refs to anon, authenticated;
grant select on public.click_refs to authenticated;
grant select, insert on public.attribution_events to authenticated;
grant select on public.conversion_uploads to authenticated;

create or replace view public.ad_funnel
with (security_invoker = true) as
select
  l.id as ad_link_id,
  l.platform,
  l.campaign_name,
  l.ad_name,
  l.ref_code,
  l.target_type,
  l.target_id,
  count(distinct c.id) as chats,
  count(distinct e.id) filter (where e.stage = 'enquired') as enquired,
  count(distinct e.id) filter (where e.stage in ('enrolled', 'paid', 'attended')) as booked,
  count(distinct e.id) filter (where e.stage = 'paid') as paid,
  count(distinct e.id) filter (where e.stage = 'attended') as attended,
  case when l.platform = 'meta' then spend.spend_rm else null end as spend_rm
from public.ad_links l
left join public.conversations c on c.last_ad_link_id = l.id or c.first_ad_link_id = l.id
left join public.event_enrolments e on e.conversation_id = c.id
left join lateral (
  select sum(m.spend_rm) as spend_rm
  from public.ad_daily_metrics m
  where l.platform = 'meta' and m.ad_id = l.ad_id
) spend on true
group by l.id, l.platform, l.campaign_name, l.ad_name, l.ref_code, l.target_type, l.target_id, spend.spend_rm;

comment on view public.ad_funnel is
  'Chats through attended for each ad. Spend is only filled when ads-sync has Meta numbers. Google and TikTok spend stay null until those imports exist.';

revoke all on public.ad_funnel from public, anon;
grant select on public.ad_funnel to authenticated;

commit;
