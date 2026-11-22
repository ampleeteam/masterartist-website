-- Case fields on the same conversation as the chat. Keyword rules, ref links, call logs,
-- and ad ids on bookings. Run after workshop sessions. Safe to run more than once.
-- Do not apply to production until go-live approval.

begin;

alter table public.conversations drop constraint if exists conversations_status;
alter table public.conversations add constraint conversations_status
  check (status in ('open', 'pending', 'closed'));

alter table public.conversations add column if not exists priority text not null default 'normal';
alter table public.conversations drop constraint if exists conversations_priority;
alter table public.conversations add constraint conversations_priority
  check (priority in ('low', 'normal', 'high'));

comment on column public.conversations.priority is 'Case priority on the same row as the chat. There is no separate cases table.';
comment on column public.conversations.assigned_to is 'Staff member who owns this chat and case.';

alter table public.contacts add column if not exists ref_code text;
comment on column public.contacts.ref_code is 'Last wa.me or ad ref code captured for this customer.';

alter table public.workshop_bookings add column if not exists meta_ad_id text;
alter table public.workshop_bookings add column if not exists ctwa_clid text;

alter table public.messages drop constraint if exists messages_channel;
alter table public.messages add constraint messages_channel
  check (channel in ('whatsapp', 'email', 'website', 'instagram', 'facebook', 'note', 'call'));

create table if not exists public.keyword_rules (
  id          uuid primary key default gen_random_uuid(),
  phrase      text not null,
  action      text not null,
  value       text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  constraint keyword_rules_phrase check (char_length(btrim(phrase)) between 1 and 80),
  constraint keyword_rules_action check (action in ('tag', 'set_stage', 'assign'))
);

alter table public.keyword_rules add column if not exists reply text;
alter table public.keyword_rules drop constraint if exists keyword_rules_reply;
alter table public.keyword_rules add constraint keyword_rules_reply
  check (reply is null or char_length(reply) <= 1000);

comment on table public.keyword_rules is
  'Inbox rules beside inbox_settings. A matching phrase can tag, set an enrolment stage, or assign. A reply is queued for staff. Nothing is delivered until WhatsApp sending is switched on.';

alter table public.conversations add column if not exists entry_kind text;
alter table public.conversations add column if not exists entry_label text;
alter table public.conversations add column if not exists source_type text;
alter table public.conversations add column if not exists source_id text;
alter table public.conversations add column if not exists source_url text;
alter table public.conversations add column if not exists headline text;
alter table public.conversations add column if not exists referral_body text;
alter table public.conversations add column if not exists referral_media_type text;
alter table public.conversations add column if not exists referral_media_url text;
alter table public.conversations add column if not exists campaign_name text;
alter table public.conversations add column if not exists intent text;
alter table public.conversations add column if not exists attributed_at timestamptz;
alter table public.conversations add column if not exists greeting_sent_at timestamptz;
alter table public.conversations add column if not exists away_sent_at timestamptz;
alter table public.conversations drop constraint if exists conversations_entry_kind;
alter table public.conversations add constraint conversations_entry_kind
  check (entry_kind is null or entry_kind in ('ad', 'ref', 'direct', 'call'));

comment on column public.conversations.attributed_at is
  'Set on the first inbound message. Later ads and ref codes do not overwrite it.';

alter table public.inbox_settings add column if not exists timezone text not null default 'Asia/Kuala_Lumpur';
alter table public.inbox_settings add column if not exists business_hours jsonb;
alter table public.inbox_settings add column if not exists greeting_enabled boolean not null default true;
alter table public.inbox_settings add column if not exists away_enabled boolean not null default true;

create table if not exists public.ad_mappings (
  source_id     text primary key,
  session_id    text references public.workshop_sessions(id) on delete set null,
  campaign_name text,
  headline      text,
  created_at    timestamptz not null default now()
);

comment on table public.ad_mappings is
  'Click-to-WhatsApp source_id to a workshop session. One studio, no organisation column.';

create table if not exists public.assignment_cursor (
  id           int primary key default 1,
  last_user_id uuid,
  constraint assignment_cursor_one check (id = 1)
);

insert into public.assignment_cursor (id) values (1) on conflict (id) do nothing;

comment on table public.assignment_cursor is
  'Round-robin pointer for new chats. Staff ids are profiles.id.';

alter table public.messages add column if not exists wa_call_id text;
create unique index if not exists messages_wa_call_id_uidx on public.messages (wa_call_id) where wa_call_id is not null;

create table if not exists public.ref_links (
  code        text primary key,
  label       text not null,
  session_id  text references public.workshop_sessions(id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint ref_links_code check (code ~ '^[a-z0-9-]{2,40}$')
);

comment on table public.ref_links is
  'Tracked codes used on wa.me links. capture_click_to_whatsapp stores the code on the customer.';

create or replace function private.capture_click_to_whatsapp(p_contact uuid, p_raw jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctwa text;
  v_ad text;
  v_ref text;
begin
  if p_contact is null or p_raw is null then return; end if;
  v_ctwa := coalesce(p_raw->'referral'->>'ctwa_clid', p_raw->>'ctwa_clid');
  v_ad := coalesce(p_raw->'referral'->>'source_id', p_raw->>'source_id', p_raw->>'ad_id', p_raw->>'source_ad_id', p_raw->>'meta_ad_id');
  v_ref := coalesce(
    p_raw->>'ref',
    p_raw->>'ref_code',
    substring(coalesce(p_raw->>'body', p_raw->>'text', '') from 'ref=([a-z0-9-]{2,40})'),
    lower(substring(coalesce(p_raw->>'body', p_raw->>'text', '') from 'ref:\s*([a-z0-9][a-z0-9-]{1,40})'))
  );
  update public.contacts set
    ctwa_clid = coalesce(ctwa_clid, nullif(v_ctwa, '')),
    meta_ad_id = coalesce(meta_ad_id, nullif(v_ad, '')),
    ref_code = coalesce(nullif(v_ref, ''), ref_code),
    tags = case
      when nullif(v_ad, '') is not null and not tags @> array['source ad'] then tags || array['source ad']
      else tags end
  where id = p_contact
    and (v_ctwa is not null or v_ad is not null or nullif(v_ref, '') is not null);
end;
$$;

create or replace function public.ingest_whatsapp_webhook(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return private.ingest_message(p);
end;
$$;

revoke all on function public.ingest_whatsapp_webhook(jsonb) from public, anon, authenticated;

do $$ begin
  grant execute on function public.ingest_whatsapp_webhook(jsonb) to service_role;
exception when undefined_object then
  null;
end $$;

alter table public.keyword_rules enable row level security;
alter table public.ref_links enable row level security;
alter table public.ad_mappings enable row level security;
alter table public.assignment_cursor enable row level security;

drop policy if exists keyword_rules_read on public.keyword_rules;
create policy keyword_rules_read on public.keyword_rules for select to authenticated
  using (private.can_bookings(false) or private.can_section('customers', false));
drop policy if exists keyword_rules_write on public.keyword_rules;
create policy keyword_rules_write on public.keyword_rules for all to authenticated
  using (private.can_bookings(true)) with check (private.can_bookings(true));

drop policy if exists ref_links_read on public.ref_links;
create policy ref_links_read on public.ref_links for select to authenticated
  using (private.can_bookings(false) or private.can_section('customers', false));
drop policy if exists ref_links_write on public.ref_links;
create policy ref_links_write on public.ref_links for all to authenticated
  using (private.can_bookings(true)) with check (private.can_bookings(true));

drop policy if exists ad_mappings_read on public.ad_mappings;
create policy ad_mappings_read on public.ad_mappings for select to authenticated
  using (private.can_bookings(false) or private.can_section('customers', false));
drop policy if exists ad_mappings_write on public.ad_mappings;
create policy ad_mappings_write on public.ad_mappings for all to authenticated
  using (private.can_bookings(true)) with check (private.can_bookings(true));

drop policy if exists assignment_cursor_read on public.assignment_cursor;
create policy assignment_cursor_read on public.assignment_cursor for select to authenticated
  using (private.can_bookings(false));
drop policy if exists assignment_cursor_write on public.assignment_cursor;
create policy assignment_cursor_write on public.assignment_cursor for all to authenticated
  using (private.can_bookings(true)) with check (private.can_bookings(true));

grant select, insert, update, delete on public.keyword_rules to authenticated;
grant select, insert, update, delete on public.ref_links to authenticated;
grant select, insert, update, delete on public.ad_mappings to authenticated;
grant select, update on public.assignment_cursor to authenticated;

commit;
