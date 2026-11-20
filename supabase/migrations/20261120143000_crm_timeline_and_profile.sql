-- Customer profile, family, and conversation timeline.
-- Run in the Supabase SQL Editor (project fudaosneozobacdalncv) AFTER
-- supabase/bookings.sql and supabase/crm.sql. Safe to run more than once.
-- Do not run it from the website deploy, and do not put secrets in it.
--
-- The customer record is public.contacts (planning name: crm_contacts).
-- This file only adds columns and tables. It does not delete or rewrite
-- existing names, notes, bookings, or the children jsonb already stored.
--
-- Who can see what
--   WhatsApp and other channel messages: bookings staff, and never the marketing
--     role. Staff notes on the same table are visible to customers staff too.
--     anon has no access. A later webhook should call private.ingest_message
--     with the service role (not the anon key).
--   child allergies, medical notes, special needs, emergency contact:
--     admin, and any role except marketing that has bookings read.
--     marketing cannot read those rows even if someone grants them bookings.

begin;

create extension if not exists pgcrypto;

-- Views are recreated at the end. Drop first so column changes can re-run.
drop view if exists public.contact_timeline;
drop view if exists public.contact_booking_stats;

-- ---------- phone numbers: match WhatsApp on E.164, Malaysia +60 ----------
create or replace function public.normalise_my_phone(p text)
returns text
language plpgsql
immutable
as $$
declare d text;
begin
  if p is null then return null; end if;
  d := regexp_replace(p, '[^0-9+]', '', 'g');
  if d = '' or d = '+' then return null; end if;
  if left(d, 1) = '+' then d := substring(d from 2); end if;
  if left(d, 2) = '00' then d := substring(d from 3); end if;
  if left(d, 1) = '0' then d := '60' || substring(d from 2); end if;
  -- 1xxxxxxxx without a country code is a Malaysian mobile
  if d ~ '^1[0-9]{8,9}$' then d := '60' || d; end if;
  if d !~ '^[0-9]{8,15}$' then return null; end if;
  return '+' || d;
end;
$$;

comment on function public.normalise_my_phone(text) is
  'Strip a phone number to E.164. Malaysian numbers (012…, 60…, bare 1…) become +60…. Other country codes that already include a code are kept.';

-- ---------- customer profile: HubSpot-style fields that fit a workshop studio ----------
alter table public.contacts
  add column if not exists gender text,
  add column if not exists state text,
  add column if not exists country text default 'Malaysia',
  add column if not exists phone_e164 text,
  add column if not exists whatsapp_e164 text,
  add column if not exists lifecycle_stage text not null default 'lead',
  add column if not exists lead_status text not null default 'new',
  add column if not exists original_source text,
  add column if not exists source_detail text,
  add column if not exists utm_source text,
  add column if not exists utm_medium text,
  add column if not exists utm_campaign text,
  add column if not exists utm_content text,
  add column if not exists utm_term text,
  add column if not exists meta_ad_id text,
  add column if not exists fbclid text,
  add column if not exists gclid text,
  add column if not exists first_page text,
  add column if not exists first_referrer text,
  add column if not exists last_contacted_at timestamptz,
  add column if not exists last_inbound_at timestamptz,
  add column if not exists times_contacted int not null default 0,
  add column if not exists first_conversion_at timestamptz,
  add column if not exists first_conversion_event text,
  add column if not exists recent_conversion_at timestamptz,
  add column if not exists recent_conversion_event text,
  add column if not exists became_customer_at timestamptz,
  add column if not exists workshops_attended int not null default 0,
  add column if not exists formats_attended text[] not null default '{}',
  add column if not exists last_workshop_at date,
  add column if not exists last_workshop_name text,
  add column if not exists no_show_count int not null default 0,
  add column if not exists email_consent_at timestamptz,
  add column if not exists email_consent_source text,
  add column if not exists whatsapp_consent_at timestamptz,
  add column if not exists whatsapp_consent_source text,
  add column if not exists unsubscribed boolean not null default false,
  add column if not exists facebook text,
  add column if not exists tiktok text,
  add column if not exists credit_balance int not null default 0,
  add column if not exists referral_code text,
  add column if not exists skill_by_format jsonb not null default '{}',
  add column if not exists is_organiser boolean not null default false,
  add column if not exists voucher_role text,
  add column if not exists birthday_enquiry boolean not null default false,
  add column if not exists academy_status text,
  add column if not exists waiver_accepted_at timestamptz,
  add column if not exists custom_fields jsonb not null default '{}';

alter table public.contacts drop constraint if exists contacts_crm_choices;
alter table public.contacts add constraint contacts_crm_choices check (
  (gender is null or gender in ('female', 'male', 'non-binary', 'prefer not to say'))
  and lifecycle_stage in ('subscriber', 'lead', 'marketing qualified', 'sales qualified', 'customer', 'repeat customer', 'evangelist', 'other')
  and lead_status in ('new', 'open', 'in progress', 'attempted to contact', 'connected', 'unqualified', 'bad timing')
  and (original_source is null or original_source in ('paid social', 'organic social', 'organic search', 'direct', 'referral', 'email', 'offline', 'whatsapp'))
  and (voucher_role is null or voucher_role in ('purchaser', 'recipient', 'both'))
  and (academy_status is null or academy_status in ('none', 'trial', 'member', 'paused', 'former'))
  and credit_balance between 0 and 1000000
  and times_contacted >= 0
  and no_show_count >= 0
  and workshops_attended >= 0
  and jsonb_typeof(skill_by_format) = 'object'
  and jsonb_typeof(custom_fields) = 'object'
);

alter table public.contacts drop constraint if exists contacts_crm_lens;
alter table public.contacts add constraint contacts_crm_lens check (
  coalesce(char_length(state), 0) <= 80
  and coalesce(char_length(country), 0) <= 80
  and coalesce(char_length(source_detail), 0) <= 200
  and coalesce(char_length(facebook), 0) <= 160
  and coalesce(char_length(tiktok), 0) <= 160
  and coalesce(char_length(referral_code), 0) <= 40
  and coalesce(char_length(first_page), 0) <= 500
  and coalesce(char_length(first_referrer), 0) <= 500
  and coalesce(char_length(meta_ad_id), 0) <= 80
  and coalesce(char_length(email_consent_source), 0) <= 80
  and coalesce(char_length(whatsapp_consent_source), 0) <= 80
  and coalesce(char_length(first_conversion_event), 0) <= 200
  and coalesce(char_length(recent_conversion_event), 0) <= 200
  and coalesce(char_length(last_workshop_name), 0) <= 200
  and coalesce(char_length(utm_source), 0) <= 200
  and coalesce(char_length(utm_medium), 0) <= 200
  and coalesce(char_length(utm_campaign), 0) <= 200
  and coalesce(char_length(utm_content), 0) <= 200
  and coalesce(char_length(utm_term), 0) <= 200
  and coalesce(char_length(fbclid), 0) <= 200
  and coalesce(char_length(gclid), 0) <= 200
  and char_length(custom_fields::text) <= 8000
  and char_length(skill_by_format::text) <= 2000
);

create index if not exists contacts_phone_e164_idx on public.contacts (phone_e164);
create index if not exists contacts_whatsapp_e164_idx on public.contacts (whatsapp_e164);
create index if not exists contacts_phone2_e164_idx on public.contacts (public.normalise_my_phone(phone_2));
create unique index if not exists contacts_referral_code_key on public.contacts (lower(referral_code)) where referral_code is not null;

comment on table public.contacts is
  'CRM customers (crm_contacts). One person, matched by email then normalised phone. Children live in participants, not only in the children jsonb.';
comment on column public.contacts.phone_e164 is 'E.164 form of phone, maintained by the derive trigger. Use this to match WhatsApp.';
comment on column public.contacts.whatsapp_e164 is 'WhatsApp number in E.164. Defaults to phone_e164 when left blank.';
comment on column public.contacts.lifecycle_stage is 'HubSpot-style stage. The older stage column is the studio pipeline and is kept.';
comment on column public.contacts.credit_balance is 'Academy credit in RM.';
comment on column public.contacts.skill_by_format is 'Object of format name to beginner, intermediate, or advanced.';
comment on column public.contacts.custom_fields is 'Future properties. A JSON object, never a list.';
comment on column public.contacts.children is 'Legacy list copied from bookings. The family editor also keeps a simplified copy. Allergies live in participant_health.';

-- Keep phone_e164 / consent timestamps in step with what staff and the website save.
create or replace function private.contacts_derive()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.phone_e164 := public.normalise_my_phone(new.phone);
  if new.whatsapp_e164 is null or btrim(new.whatsapp_e164) = '' then
    new.whatsapp_e164 := new.phone_e164;
  else
    new.whatsapp_e164 := public.normalise_my_phone(new.whatsapp_e164);
  end if;
  if new.email_consent and new.email_consent_at is null then
    new.email_consent_at := now();
  end if;
  if new.email_consent and new.email_consent_source is null then
    new.email_consent_source := 'staff';
  end if;
  if new.whatsapp_consent and new.whatsapp_consent_at is null then
    new.whatsapp_consent_at := now();
  end if;
  if new.whatsapp_consent and new.whatsapp_consent_source is null then
    new.whatsapp_consent_source := 'staff';
  end if;
  if new.unsubscribed and new.unsubscribed_at is null then
    new.unsubscribed_at := now();
  end if;
  if new.skill_by_format is null or jsonb_typeof(new.skill_by_format) <> 'object' then
    new.skill_by_format := '{}'::jsonb;
  end if;
  if new.custom_fields is null or jsonb_typeof(new.custom_fields) <> 'object' then
    new.custom_fields := '{}'::jsonb;
  end if;
  return new;
end;
$$;

drop trigger if exists contacts_derive on public.contacts;
create trigger contacts_derive before insert or update on public.contacts
  for each row execute function private.contacts_derive();

-- ---------- family: a child is a participant, and may also be a contact ----------
create table if not exists public.participants (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  contact_id      uuid references public.contacts(id) on delete set null,
  full_name       text not null,
  nickname        text,
  date_of_birth   date,
  age_years       int,
  school          text,
  photo_consent   text,
  pickup_names    text,
  created_by      uuid,
  updated_at      timestamptz,
  updated_by      uuid,
  constraint participants_name_len check (char_length(btrim(full_name)) between 1 and 120),
  constraint participants_nick_len check (nickname is null or char_length(nickname) <= 80),
  constraint participants_school_len check (school is null or char_length(school) <= 160),
  constraint participants_pickup_len check (pickup_names is null or char_length(pickup_names) <= 500),
  constraint participants_age check (age_years is null or age_years between 0 and 100),
  constraint participants_photo check (photo_consent is null or photo_consent in ('yes', 'no', 'yes without name', 'yes with first name'))
);

comment on table public.participants is
  'A child or other attendee. contact_id is set when they also have their own customer record. Medical notes are in participant_health.';
comment on column public.participants.contact_id is 'Set when this participant is also a row in contacts.';
comment on column public.participants.pickup_names is 'People allowed to collect this child.';

-- Allergies, medical notes, and special needs. Not readable by the marketing role.
create table if not exists public.participant_health (
  participant_id  uuid primary key references public.participants(id) on delete cascade,
  allergies       text,
  medical_notes   text,
  special_needs   text,
  emergency_name  text,
  emergency_phone text,
  updated_at      timestamptz,
  updated_by      uuid,
  constraint participant_health_lens check (
    coalesce(char_length(allergies), 0) <= 2000
    and coalesce(char_length(medical_notes), 0) <= 2000
    and coalesce(char_length(special_needs), 0) <= 2000
    and coalesce(char_length(emergency_name), 0) <= 120
    and coalesce(char_length(emergency_phone), 0) <= 40
  )
);

comment on table public.participant_health is
  'Child allergies, medical notes, special needs, and emergency contact. Admin and bookings staff only. The marketing role cannot read this table.';

create table if not exists public.contact_guardians (
  id                   uuid primary key default gen_random_uuid(),
  participant_id       uuid not null references public.participants(id) on delete cascade,
  guardian_contact_id  uuid not null references public.contacts(id) on delete cascade,
  relationship         text not null default 'guardian',
  is_primary           boolean not null default false,
  pays                 boolean not null default false,
  receives_messages    boolean not null default false,
  created_at           timestamptz not null default now(),
  constraint contact_guardians_pair unique (participant_id, guardian_contact_id),
  constraint contact_guardians_rel check (relationship in ('mother', 'father', 'guardian', 'other'))
);

create unique index if not exists contact_guardians_one_primary
  on public.contact_guardians (participant_id) where is_primary;
create index if not exists contact_guardians_guardian_idx on public.contact_guardians (guardian_contact_id);
create index if not exists participants_contact_idx on public.participants (contact_id);

comment on table public.contact_guardians is
  'Links a participant to one or more parent or guardian contacts. is_primary is the person the studio calls first. pays and receives_messages say who is billed and who gets WhatsApp.';

create or replace function private.guardian_one_primary()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_primary then
    update public.contact_guardians set is_primary = false
    where participant_id = new.participant_id and id is distinct from new.id and is_primary;
  end if;
  return new;
end;
$$;

drop trigger if exists contact_guardians_one_primary on public.contact_guardians;
create trigger contact_guardians_one_primary before insert or update of is_primary on public.contact_guardians
  for each row execute function private.guardian_one_primary();

-- ---------- messages: live webhook, history sync, export file, and staff notes ----------
create table if not exists public.messages (
  id                   uuid primary key default gen_random_uuid(),
  contact_id           uuid not null references public.contacts(id) on delete cascade,
  channel              text not null,
  direction            text not null,
  sender_type          text not null,
  sender_name          text,
  body                 text,
  media                jsonb not null default '[]',
  provider_message_id  text,
  status               text,
  source               text not null,
  occurred_at          timestamptz not null default now(),
  raw                  jsonb,
  phone_e164           text,
  staff_id             uuid,
  created_at           timestamptz not null default now(),
  created_by           uuid,
  constraint messages_channel check (channel in ('whatsapp', 'email', 'website', 'instagram', 'facebook', 'note')),
  constraint messages_direction check (direction in ('in', 'out')),
  constraint messages_sender check (sender_type in ('customer', 'staff', 'bot', 'system')),
  constraint messages_status check (status is null or status in ('sent', 'delivered', 'read', 'failed')),
  constraint messages_source check (source in ('live', 'history_sync', 'export_import', 'manual')),
  constraint messages_body_len check (body is null or char_length(body) <= 8000),
  constraint messages_name_len check (sender_name is null or char_length(sender_name) <= 120),
  constraint messages_media_arr check (jsonb_typeof(media) = 'array' and char_length(media::text) <= 8000),
  constraint messages_provider_unique unique (provider_message_id)
);

comment on table public.messages is
  'One row per WhatsApp, email, social, or staff note. provider_message_id dedupes webhook retries, 360dialog history sync, and a second import of the same export file. sender_type bot is an automated message (confirmation, reminder, thank-you).';
comment on column public.messages.provider_message_id is 'wamid from 360dialog, or waexport:<sha256> for an imported chat file. Null only for staff notes. Unique so a re-import does nothing.';
comment on column public.messages.source is 'live = webhook, history_sync = 360dialog coexistence history, export_import = WhatsApp Export chat .txt, manual = staff note.';

create index if not exists messages_contact_occurred_idx on public.messages (contact_id, occurred_at desc);
create index if not exists messages_phone_idx on public.messages (phone_e164);

-- A message we could not attach because it had no usable phone number. Not dropped.
create table if not exists public.unmatched_messages (
  id                   uuid primary key default gen_random_uuid(),
  created_at           timestamptz not null default now(),
  phone_raw            text,
  phone_e164           text,
  channel              text,
  direction            text,
  sender_type          text,
  sender_name          text,
  body                 text,
  media                jsonb not null default '[]',
  provider_message_id  text,
  status               text,
  source               text,
  occurred_at          timestamptz,
  raw                  jsonb,
  reason               text,
  resolved_contact_id  uuid references public.contacts(id) on delete set null,
  resolved_at          timestamptz
);

create unique index if not exists unmatched_provider_idx
  on public.unmatched_messages (provider_message_id) where provider_message_id is not null;
create index if not exists unmatched_open_idx
  on public.unmatched_messages (phone_e164) where resolved_at is null;

comment on table public.unmatched_messages is
  'Queue for messages that had no phone we could turn into +60… and no contact id. private.ingest_message writes here instead of dropping the row. attach_unmatched_messages files them onto a customer.';

-- ---------- booking events on the same timeline ----------
create table if not exists public.workshop_booking_events (
  id           uuid primary key default gen_random_uuid(),
  booking_id   uuid not null references public.workshop_bookings(id) on delete cascade,
  contact_id   uuid references public.contacts(id) on delete set null,
  event        text not null,
  occurred_at  timestamptz not null default now(),
  detail       text,
  constraint workshop_booking_events_event check (event in ('pending', 'requested', 'confirmed', 'paid', 'expired', 'cancelled', 'refunded', 'no_show')),
  constraint workshop_booking_events_detail_len check (detail is null or char_length(detail) <= 300)
);

create index if not exists workshop_booking_events_contact_idx
  on public.workshop_booking_events (contact_id, occurred_at desc);
create index if not exists workshop_booking_events_booking_idx
  on public.workshop_booking_events (booking_id, occurred_at);

alter table public.workshop_bookings drop constraint if exists wb_status;
alter table public.workshop_bookings add constraint wb_status
  check (status in ('pending', 'requested', 'confirmed', 'paid', 'expired', 'cancelled', 'refunded', 'no_show'));

alter table public.workshop_bookings
  add column if not exists booker_contact_id uuid references public.contacts(id) on delete set null;

create index if not exists workshop_bookings_booker_idx on public.workshop_bookings (booker_contact_id);

comment on column public.workshop_bookings.booker_contact_id is
  'Who pays and whose customer record the booking belongs to. Often a parent. contact_id stays the CRM match (usually the same person).';
comment on column public.workshop_bookings.people is
  'How many people attend. The attendees themselves are booking_participants rows; the payer is booker_contact_id.';

create table if not exists public.booking_participants (
  booking_id      uuid not null references public.workshop_bookings(id) on delete cascade,
  participant_id  uuid not null references public.participants(id) on delete cascade,
  primary key (booking_id, participant_id)
);

comment on table public.booking_participants is
  'Who attends a booking, which can be a different person from the booker who pays.';

-- Booker defaults to the matched customer. Named so it runs after workshop_bookings_contact.
create or replace function private.booking_set_booker()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.booker_contact_id is null then
    new.booker_contact_id := new.contact_id;
  end if;
  return new;
end;
$$;

drop trigger if exists workshop_bookings_payer on public.workshop_bookings;
create trigger workshop_bookings_payer before insert or update of contact_id, booker_contact_id
  on public.workshop_bookings
  for each row execute function private.booking_set_booker();

create or replace function private.ensure_participant(
  p_guardian uuid,
  p_name text,
  p_age int,
  p_school text,
  p_photo text,
  p_allergies text,
  p_dob date
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := left(btrim(coalesce(p_name, '')), 120);
  v_photo text := nullif(btrim(coalesce(p_photo, '')), '');
  v_school text := left(nullif(btrim(coalesce(p_school, '')), ''), 160);
  v_allergy text := left(nullif(btrim(coalesce(p_allergies, '')), ''), 2000);
  pid uuid;
  v_primary boolean;
begin
  if p_guardian is null or v_name = '' then return null; end if;
  if v_photo is not null and v_photo not in ('yes', 'no', 'yes without name', 'yes with first name') then
    v_photo := null;
  end if;
  if p_age is not null and (p_age < 0 or p_age > 100) then
    p_age := null;
  end if;
  select p.id into pid
  from public.participants p
  join public.contact_guardians g on g.participant_id = p.id
  where g.guardian_contact_id = p_guardian and lower(p.full_name) = lower(v_name)
  limit 1;
  if pid is null then
    insert into public.participants (full_name, date_of_birth, age_years, school, photo_consent)
    values (v_name, p_dob, p_age, v_school, v_photo)
    returning id into pid;
  end if;
  select exists (
    select 1 from public.contact_guardians g where g.participant_id = pid and g.is_primary
  ) into v_primary;
  insert into public.contact_guardians (participant_id, guardian_contact_id, relationship, is_primary, pays, receives_messages)
  values (pid, p_guardian, 'guardian', not v_primary, not v_primary, true)
  on conflict (participant_id, guardian_contact_id) do nothing;
  if v_allergy is not null then
    insert into public.participant_health (participant_id, allergies)
    values (pid, v_allergy)
    on conflict (participant_id) do update
      set allergies = coalesce(public.participant_health.allergies, excluded.allergies);
  end if;
  return pid;
end;
$$;

create or replace function private.link_booking_participants(p_booking uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  b public.workshop_bookings%rowtype;
  kid jsonb;
  v_age int;
  v_dob date;
  pid uuid;
begin
  select * into b from public.workshop_bookings where id = p_booking;
  if b.id is null or b.contact_id is null then return; end if;
  for kid in select value from jsonb_array_elements(coalesce(b.children, '[]'::jsonb)) loop
    begin
      v_age := substring(coalesce(kid->>'age', '') from '^[0-9]{1,2}')::int;
    exception when others then
      v_age := null;
    end;
    v_dob := null;
    if coalesce(kid->>'dob', '') ~ '^\d{4}-\d{2}-\d{2}$' then
      begin
        v_dob := (kid->>'dob')::date;
      exception when others then
        v_dob := null;
      end;
    end if;
    begin
      pid := private.ensure_participant(
        b.contact_id, kid->>'name', v_age, kid->>'school', kid->>'photo', kid->>'allergies', v_dob
      );
      if pid is not null then
        insert into public.booking_participants (booking_id, participant_id) values (b.id, pid)
        on conflict do nothing;
      end if;
    exception when others then
      raise warning 'participant skipped on booking %: %', b.id, sqlerrm;
    end;
  end loop;
end;
$$;

create or replace function private.trg_link_booking_participants()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform private.link_booking_participants(new.id);
  return new;
exception when others then
  raise warning 'link participants skipped for booking %: %', new.id, sqlerrm;
  return new;
end;
$$;

drop trigger if exists workshop_bookings_link_parts on public.workshop_bookings;
create trigger workshop_bookings_link_parts after insert on public.workshop_bookings
  for each row execute function private.trg_link_booking_participants();

create or replace function private.trg_booking_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then
    return new;
  end if;
  insert into public.workshop_booking_events (booking_id, contact_id, event, occurred_at, detail)
  values (
    new.id,
    coalesce(new.booker_contact_id, new.contact_id),
    new.status,
    case
      when new.status = 'paid' then coalesce(new.paid_at, now())
      when tg_op = 'INSERT' then coalesce(new.created_at, now())
      else now()
    end,
    left(new.session_name || ' · ' || coalesce(new.session_when, ''), 300)
  );
  return new;
end;
$$;

drop trigger if exists workshop_bookings_events on public.workshop_bookings;
create trigger workshop_bookings_events after insert or update of status on public.workshop_bookings
  for each row execute function private.trg_booking_event();

create or replace function private.touch_contact_on_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.contacts set
    last_activity = greatest(last_activity, new.occurred_at),
    last_inbound_at = case
      when new.direction = 'in' and new.sender_type = 'customer'
        then greatest(coalesce(last_inbound_at, new.occurred_at), new.occurred_at)
      else last_inbound_at end,
    last_contacted_at = case
      when new.direction = 'out' and new.sender_type in ('staff', 'bot') and new.channel <> 'note'
        then greatest(coalesce(last_contacted_at, new.occurred_at), new.occurred_at)
      else last_contacted_at end,
    times_contacted = times_contacted + case
      when new.direction = 'out' and new.sender_type in ('staff', 'bot') and new.channel <> 'note' then 1
      else 0 end
  where id = new.contact_id;
  return null;
end;
$$;

drop trigger if exists messages_touch_contact on public.messages;
create trigger messages_touch_contact after insert on public.messages
  for each row execute function private.touch_contact_on_message();

-- ---------- match, create, or queue. Used later by the 360dialog webhook ----------
create or replace function private.ingest_message(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cid uuid := nullif(p->>'contact_id', '')::uuid;
  v_phone text := public.normalise_my_phone(p->>'phone');
  v_provider text := nullif(btrim(coalesce(p->>'provider_message_id', '')), '');
  v_existing uuid;
  v_existing_contact uuid;
  v_id uuid;
  v_queue uuid;
  v_media jsonb := coalesce(p->'media', '[]'::jsonb);
  v_at timestamptz := coalesce((p->>'occurred_at')::timestamptz, now());
  v_create boolean := coalesce((p->>'create_contact')::boolean, true);
begin
  if jsonb_typeof(v_media) <> 'array' then v_media := '[]'::jsonb; end if;
  if v_provider is not null then
    select id, contact_id into v_existing, v_existing_contact
    from public.messages where provider_message_id = v_provider;
    if v_existing is not null then
      return jsonb_build_object('message_id', v_existing, 'contact_id', v_existing_contact, 'queued', false, 'duplicate', true);
    end if;
  end if;
  if v_cid is null and v_phone is not null then
    perform pg_advisory_xact_lock(hashtext(v_phone)::bigint);
    select id into v_cid from public.contacts
    where phone_e164 = v_phone or whatsapp_e164 = v_phone or public.normalise_my_phone(phone_2) = v_phone
    order by created_at
    limit 1;
    if v_cid is null and v_create then
      insert into public.contacts (
        first_name, phone, whatsapp_e164, lifecycle_stage, lead_status, original_source, source_detail, tags
      ) values (
        'WhatsApp contact', v_phone, v_phone, 'lead', 'new', 'whatsapp', 'unmatched message', array['needs review']
      ) returning id into v_cid;
    end if;
  end if;
  if v_cid is null then
    insert into public.unmatched_messages (
      phone_raw, phone_e164, channel, direction, sender_type, sender_name, body, media,
      provider_message_id, status, source, occurred_at, raw, reason
    ) values (
      left(p->>'phone', 40), v_phone, p->>'channel', p->>'direction', p->>'sender_type',
      left(p->>'sender_name', 120), left(p->>'body', 8000), v_media, v_provider, p->>'status',
      p->>'source', v_at, p->'raw',
      case when v_phone is null then 'no usable phone number' else 'no matching customer' end
    )
    on conflict (provider_message_id) where provider_message_id is not null do nothing
    returning id into v_queue;
    return jsonb_build_object('message_id', null, 'contact_id', null, 'queued', true, 'unmatched_id', v_queue, 'duplicate', false);
  end if;
  insert into public.messages (
    contact_id, channel, direction, sender_type, sender_name, body, media, provider_message_id,
    status, source, occurred_at, raw, phone_e164
  ) values (
    v_cid, p->>'channel', p->>'direction', p->>'sender_type', left(nullif(btrim(p->>'sender_name'), ''), 120),
    left(nullif(p->>'body', ''), 8000), v_media, v_provider, nullif(p->>'status', ''), p->>'source', v_at,
    p->'raw', v_phone
  ) returning id into v_id;
  return jsonb_build_object('message_id', v_id, 'contact_id', v_cid, 'queued', false, 'duplicate', false);
end;
$$;

comment on function private.ingest_message(jsonb) is
  'Service-role entry for the future 360dialog webhook and history sync. Matches +60 phone, creates a customer tagged needs review, or queues the row. Dedupes on provider_message_id. Not granted to anon or staff.';

-- ---------- staff: a note, a chat export, filing the queue ----------
create or replace function private.can_message(p_write boolean)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select private.can_bookings(p_write) or private.can_section('customers', p_write);
$$;

-- Security definer so the check does not depend on whether this login can read profiles.
create or replace function private.not_marketing()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'marketing'::user_role
  );
$$;

create or replace function private.can_read_child_health()
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
        or exists (
          select 1 from public.role_permissions rp
          where rp.role = p.role and rp.section = 'bookings' and rp.can_read
        )
      )
  );
$$;

create or replace function private.can_write_child_health()
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
        or exists (
          select 1 from public.role_permissions rp
          where rp.role = p.role and rp.section = 'bookings' and rp.can_write
        )
      )
  );
$$;

create or replace function public.add_contact_note(p_contact_id uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare mid uuid; v text := nullif(btrim(p_body), '');
begin
  if auth.uid() is null or not private.can_message(true) then
    raise exception 'not allowed';
  end if;
  if v is null then raise exception 'write a note first'; end if;
  if char_length(v) > 4000 then raise exception 'note is too long'; end if;
  if not exists (select 1 from public.contacts where id = p_contact_id) then
    raise exception 'customer not found';
  end if;
  insert into public.messages (contact_id, channel, direction, sender_type, body, source, occurred_at, staff_id, created_by)
  values (p_contact_id, 'note', 'out', 'staff', v, 'manual', now(), auth.uid(), auth.uid())
  returning id into mid;
  return mid;
end;
$$;

create or replace function public.import_whatsapp_export(p_contact_id uuid, p_our_name text, p_lines jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  line jsonb;
  n int := 0;
  skipped int := 0;
  v_sender text;
  v_body text;
  v_at timestamptz;
  v_out boolean;
  v_system boolean;
  v_id text;
  v_media jsonb;
  v_key text;
begin
  if auth.uid() is null or not private.can_bookings(true) or not private.not_marketing() then
    raise exception 'not allowed';
  end if;
  if p_contact_id is null or not exists (select 1 from public.contacts where id = p_contact_id) then
    raise exception 'customer not found';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'lines must be a list';
  end if;
  if jsonb_array_length(p_lines) > 5000 then
    raise exception 'too many lines (max 5000 at a time)';
  end if;
  for line in select value from jsonb_array_elements(p_lines) loop
    v_sender := left(btrim(coalesce(line->>'sender', '')), 120);
    v_body := left(coalesce(line->>'body', ''), 8000);
    v_media := coalesce(line->'media', '[]'::jsonb);
    if jsonb_typeof(v_media) <> 'array' then v_media := '[]'::jsonb; end if;
    v_system := coalesce(line->>'system', '') = 'true';
    begin
      v_at := (line->>'occurred_at')::timestamptz;
    exception when others then
      skipped := skipped + 1;
      continue;
    end;
    if v_at is null or (btrim(coalesce(v_body, '')) = '' and v_media = '[]'::jsonb) then
      skipped := skipped + 1;
      continue;
    end if;
    v_out := lower(v_sender) = 'you'
      or (nullif(btrim(coalesce(p_our_name, '')), '') is not null and lower(v_sender) = lower(btrim(p_our_name)));
    v_key := p_contact_id::text || '|' || to_char(v_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')
      || '|' || lower(v_sender) || '|' || coalesce(v_body, '');
    v_id := 'waexport:' || encode(digest(v_key, 'sha256'), 'hex');
    insert into public.messages (
      contact_id, channel, direction, sender_type, sender_name, body, media,
      provider_message_id, source, occurred_at, phone_e164, created_by,
      staff_id
    )
    select p_contact_id, 'whatsapp',
      case when v_system then 'in' when v_out then 'out' else 'in' end,
      case when v_system then 'system' when v_out then 'staff' else 'customer' end,
      nullif(v_sender, ''), nullif(btrim(v_body), ''), v_media,
      v_id, 'export_import', v_at,
      (select c.whatsapp_e164 from public.contacts c where c.id = p_contact_id),
      auth.uid(),
      case when v_out and not v_system then auth.uid() else null end
    where not exists (select 1 from public.messages m where m.provider_message_id = v_id);
    if found then n := n + 1; else skipped := skipped + 1; end if;
  end loop;
  return jsonb_build_object('inserted', n, 'skipped', skipped);
end;
$$;

create or replace function public.attach_unmatched_messages(p_contact_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  n int := 0;
  v_phone text;
  v_wa text;
begin
  if auth.uid() is null or not private.can_bookings(true) or not private.not_marketing() then
    raise exception 'not allowed';
  end if;
  select phone_e164, whatsapp_e164 into v_phone, v_wa from public.contacts where id = p_contact_id;
  if v_phone is null and v_wa is null then return 0; end if;
  for r in
    select * from public.unmatched_messages
    where resolved_at is null and phone_e164 is not null and phone_e164 in (v_phone, v_wa)
  loop
    perform private.ingest_message(jsonb_build_object(
      'contact_id', p_contact_id,
      'phone', r.phone_e164,
      'channel', r.channel,
      'direction', r.direction,
      'sender_type', r.sender_type,
      'sender_name', r.sender_name,
      'body', r.body,
      'media', r.media,
      'provider_message_id', r.provider_message_id,
      'status', r.status,
      'source', r.source,
      'occurred_at', r.occurred_at,
      'raw', r.raw,
      'create_contact', false
    ));
    update public.unmatched_messages
      set resolved_contact_id = p_contact_id, resolved_at = now()
      where id = r.id;
    n := n + 1;
  end loop;
  return n;
end;
$$;

create or replace function public.remove_participant(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not private.can_message(true) then
    raise exception 'not allowed';
  end if;
  delete from public.participants where id = p_id;
end;
$$;

-- ---------- totals, including workshops attended and lifecycle ----------
create or replace function private.refresh_contact(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_paid int;
begin
  if p_id is null then return; end if;
  select count(*) into v_paid from public.workshop_bookings b
  where b.status = 'paid' and (b.contact_id = p_id or b.booker_contact_id = p_id);
  update public.contacts c set
    bookings_count = (
      select count(*) from public.workshop_bookings b
      where b.contact_id = p_id and b.status in ('requested', 'confirmed', 'paid')
    ),
    total_paid = coalesce((
      select sum(amount) from public.workshop_bookings b
      where (b.contact_id = p_id or b.booker_contact_id = p_id) and b.status = 'paid'
    ), 0),
    trials_count = (select count(*) from public.trial_leads t where t.contact_id = p_id),
    last_booking_date = (
      select max(session_date) from public.workshop_bookings b
      where (b.contact_id = p_id or b.booker_contact_id = p_id)
        and b.status in ('requested', 'confirmed', 'paid') and b.session_date <= current_date
    ),
    next_booking_date = (
      select min(session_date) from public.workshop_bookings b
      where (b.contact_id = p_id or b.booker_contact_id = p_id)
        and b.status in ('requested', 'confirmed', 'paid') and b.session_date > current_date
    ),
    workshops_attended = (
      select count(distinct b.id) from public.workshop_bookings b
      where b.status = 'paid' and b.session_date <= current_date
        and (
          b.contact_id = p_id or b.booker_contact_id = p_id
          or exists (
            select 1 from public.booking_participants bp
            join public.participants p on p.id = bp.participant_id
            left join public.contact_guardians g on g.participant_id = p.id
            where bp.booking_id = b.id and (p.contact_id = p_id or g.guardian_contact_id = p_id)
          )
        )
    ),
    no_show_count = (
      select count(*) from public.workshop_bookings b
      where b.status = 'no_show' and (b.contact_id = p_id or b.booker_contact_id = p_id)
    ),
    last_workshop_at = (
      select max(b.session_date) from public.workshop_bookings b
      where b.status = 'paid' and b.session_date <= current_date
        and (b.contact_id = p_id or b.booker_contact_id = p_id)
    ),
    last_workshop_name = (
      select b.session_name from public.workshop_bookings b
      where b.status = 'paid' and b.session_date <= current_date
        and (b.contact_id = p_id or b.booker_contact_id = p_id)
      order by b.session_date desc limit 1
    ),
    formats_attended = coalesce((
      select array_agg(f order by f) from (
        select distinct b.format as f from public.workshop_bookings b
        where b.status in ('paid', 'confirmed', 'requested')
          and (b.contact_id = p_id or b.booker_contact_id = p_id)
      ) s
    ), '{}'),
    became_customer_at = coalesce(c.became_customer_at, (
      select min(coalesce(b.paid_at, b.created_at)) from public.workshop_bookings b
      where b.status = 'paid' and (b.contact_id = p_id or b.booker_contact_id = p_id)
    )),
    lifecycle_stage = case
      when c.lifecycle_stage in ('evangelist', 'other') then c.lifecycle_stage
      when v_paid >= 2 then 'repeat customer'
      when v_paid >= 1 and c.lifecycle_stage in ('subscriber', 'lead', 'marketing qualified', 'sales qualified', 'customer', 'repeat customer')
        then 'customer'
      else c.lifecycle_stage
    end,
    stage = case
      when c.stage in ('lead', 'trial requested') and v_paid >= 1 then 'workshop customer'
      when c.stage = 'lead' and exists (select 1 from public.trial_leads t where t.contact_id = p_id) then 'trial requested'
      else c.stage
    end,
    contact_type = case
      when c.contact_type = 'individual' and jsonb_array_length(c.children) > 0 then 'parent'
      else c.contact_type
    end
  where c.id = p_id;
end;
$$;

create or replace function private.contact_totals()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' and new.contact_id is not null then
    update public.contacts set
      first_conversion_at = coalesce(first_conversion_at, new.created_at),
      first_conversion_event = coalesce(first_conversion_event,
        case when tg_table_name = 'trial_leads' then 'trial request' else 'workshop booking: ' || new.session_name end),
      recent_conversion_at = case
        when recent_conversion_at is null or recent_conversion_at <= new.created_at then new.created_at
        else recent_conversion_at end,
      recent_conversion_event = case
        when recent_conversion_at is null or recent_conversion_at <= new.created_at then
          case when tg_table_name = 'trial_leads' then 'trial request' else 'workshop booking: ' || new.session_name end
        else recent_conversion_event end
    where id = new.contact_id;
  end if;
  if new.contact_id is not null then perform private.refresh_contact(new.contact_id); end if;
  if tg_op = 'UPDATE' and old.contact_id is distinct from new.contact_id and old.contact_id is not null then
    perform private.refresh_contact(old.contact_id);
  end if;
  if tg_table_name = 'workshop_bookings' and new.booker_contact_id is not null
     and new.booker_contact_id is distinct from new.contact_id then
    perform private.refresh_contact(new.booker_contact_id);
  end if;
  return null;
end;
$$;

-- Website bookings that opt in record the consent source as the website, not staff.
create or replace function private.upsert_contact(p_first text, p_last text, p_email text, p_phone text,
  p_source text, p_consent boolean, p_children jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare cid uuid; em text := nullif(lower(btrim(p_email)), '');
begin
  if em is not null then select id into cid from public.contacts where email = em; end if;
  if cid is null and nullif(btrim(p_phone), '') is not null then
    select id into cid from public.contacts
    where (phone = btrim(p_phone) or phone_e164 = public.normalise_my_phone(p_phone) or whatsapp_e164 = public.normalise_my_phone(p_phone))
      and (email is null or em is null)
    order by created_at limit 1;
  end if;
  if cid is null then
    insert into public.contacts (
      first_name, last_name, email, phone, first_source, last_source, marketing_consent, email_consent,
      whatsapp_consent, consent_at, children, email_consent_at, email_consent_source, whatsapp_consent_at, whatsapp_consent_source
    ) values (
      coalesce(nullif(btrim(p_first), ''), '?'), nullif(btrim(p_last), ''), em, nullif(btrim(p_phone), ''), p_source, p_source,
      coalesce(p_consent, false), coalesce(p_consent, false), coalesce(p_consent, false), case when p_consent then now() end,
      coalesce(p_children, '[]'),
      case when p_consent then now() end, case when p_consent then 'website' end,
      case when p_consent then now() end, case when p_consent then 'website' end
    ) returning id into cid;
  else
    update public.contacts set
      first_name = coalesce(nullif(btrim(p_first), ''), first_name),
      last_name = coalesce(nullif(btrim(p_last), ''), last_name),
      email = coalesce(email, em),
      phone = coalesce(nullif(btrim(p_phone), ''), phone),
      children = case when jsonb_array_length(coalesce(p_children, '[]')) > 0 then p_children else children end,
      marketing_consent = marketing_consent or coalesce(p_consent, false),
      email_consent = email_consent or coalesce(p_consent, false),
      whatsapp_consent = whatsapp_consent or coalesce(p_consent, false),
      email_consent_at = case when (email_consent or coalesce(p_consent, false)) and email_consent_at is null then now() else email_consent_at end,
      email_consent_source = case when not email_consent and coalesce(p_consent, false) and email_consent_source is null then 'website' else email_consent_source end,
      whatsapp_consent_at = case when (whatsapp_consent or coalesce(p_consent, false)) and whatsapp_consent_at is null then now() else whatsapp_consent_at end,
      whatsapp_consent_source = case when not whatsapp_consent and coalesce(p_consent, false) and whatsapp_consent_source is null then 'website' else whatsapp_consent_source end,
      last_source = coalesce(p_source, last_source),
      consent_at = case when not marketing_consent and p_consent then now() else consent_at end,
      last_activity = now()
    where id = cid;
  end if;
  return cid;
end;
$$;

-- ---------- row level security ----------
grant usage on schema private to authenticated;

revoke all on function public.normalise_my_phone(text) from public, anon;
grant execute on function public.normalise_my_phone(text) to authenticated;

revoke all on function private.can_message(boolean) from public;
grant execute on function private.can_message(boolean) to authenticated;
revoke all on function private.not_marketing() from public;
grant execute on function private.not_marketing() to authenticated;
revoke all on function private.can_read_child_health() from public;
grant execute on function private.can_read_child_health() to authenticated;
revoke all on function private.can_write_child_health() from public;
grant execute on function private.can_write_child_health() to authenticated;

revoke all on function private.ingest_message(jsonb) from public, anon, authenticated;
revoke all on function private.ensure_participant(uuid, text, int, text, text, text, date) from public, anon, authenticated;
revoke all on function private.link_booking_participants(uuid) from public, anon, authenticated;

grant execute on function private.contacts_derive() to anon, authenticated;
grant execute on function private.booking_set_booker() to anon, authenticated;
grant execute on function private.trg_link_booking_participants() to anon, authenticated;
grant execute on function private.trg_booking_event() to anon, authenticated;
grant execute on function private.touch_contact_on_message() to authenticated;
grant execute on function private.guardian_one_primary() to authenticated;

revoke all on function public.add_contact_note(uuid, text) from public, anon;
grant execute on function public.add_contact_note(uuid, text) to authenticated;
revoke all on function public.import_whatsapp_export(uuid, text, jsonb) from public, anon;
grant execute on function public.import_whatsapp_export(uuid, text, jsonb) to authenticated;
revoke all on function public.attach_unmatched_messages(uuid) from public, anon;
grant execute on function public.attach_unmatched_messages(uuid) to authenticated;
revoke all on function public.remove_participant(uuid) from public, anon;
grant execute on function public.remove_participant(uuid) to authenticated;

alter table public.participants enable row level security;
alter table public.participant_health enable row level security;
alter table public.contact_guardians enable row level security;
alter table public.messages enable row level security;
alter table public.unmatched_messages enable row level security;
alter table public.workshop_booking_events enable row level security;
alter table public.booking_participants enable row level security;

drop policy if exists participants_staff_read on public.participants;
create policy participants_staff_read on public.participants for select to authenticated
  using (private.can_message(false));
drop policy if exists participants_staff_write on public.participants;
create policy participants_staff_write on public.participants for insert to authenticated
  with check (private.can_message(true));
drop policy if exists participants_staff_update on public.participants;
create policy participants_staff_update on public.participants for update to authenticated
  using (private.can_message(true)) with check (private.can_message(true));

drop policy if exists participant_health_read on public.participant_health;
create policy participant_health_read on public.participant_health for select to authenticated
  using (private.can_read_child_health());
drop policy if exists participant_health_write on public.participant_health;
create policy participant_health_write on public.participant_health for insert to authenticated
  with check (private.can_write_child_health());
drop policy if exists participant_health_update on public.participant_health;
create policy participant_health_update on public.participant_health for update to authenticated
  using (private.can_write_child_health()) with check (private.can_write_child_health());

drop policy if exists guardians_staff_read on public.contact_guardians;
create policy guardians_staff_read on public.contact_guardians for select to authenticated
  using (private.can_message(false));
drop policy if exists guardians_staff_insert on public.contact_guardians;
create policy guardians_staff_insert on public.contact_guardians for insert to authenticated
  with check (private.can_message(true));
drop policy if exists guardians_staff_update on public.contact_guardians;
create policy guardians_staff_update on public.contact_guardians for update to authenticated
  using (private.can_message(true)) with check (private.can_message(true));
drop policy if exists guardians_staff_delete on public.contact_guardians;
create policy guardians_staff_delete on public.contact_guardians for delete to authenticated
  using (private.can_message(true));

-- WhatsApp, email, and social threads: bookings staff, never the marketing role.
-- Staff notes on the same table stay visible to anyone who can open Customers.
drop policy if exists messages_staff_read on public.messages;
create policy messages_staff_read on public.messages for select to authenticated
  using (
    (channel = 'note' and private.can_message(false))
    or (channel <> 'note' and private.can_bookings(false) and private.not_marketing())
  );
drop policy if exists messages_staff_insert on public.messages;
create policy messages_staff_insert on public.messages for insert to authenticated
  with check (
    (
      source = 'manual' and channel = 'note' and direction = 'out' and sender_type = 'staff'
      and staff_id = auth.uid() and private.can_message(true)
    )
    or (
      source = 'export_import' and channel = 'whatsapp' and sender_type in ('customer', 'staff', 'system')
      and private.can_bookings(true)
      and private.not_marketing()
    )
  );

drop policy if exists unmatched_staff_read on public.unmatched_messages;
create policy unmatched_staff_read on public.unmatched_messages for select to authenticated
  using (private.can_bookings(false) and private.not_marketing());

drop policy if exists booking_events_staff_read on public.workshop_booking_events;
create policy booking_events_staff_read on public.workshop_booking_events for select to authenticated
  using (private.can_message(false));

drop policy if exists booking_participants_read on public.booking_participants;
create policy booking_participants_read on public.booking_participants for select to authenticated
  using (private.can_message(false));
drop policy if exists booking_participants_write on public.booking_participants;
create policy booking_participants_write on public.booking_participants for insert to authenticated
  with check (private.can_message(true));
drop policy if exists booking_participants_delete on public.booking_participants;
create policy booking_participants_delete on public.booking_participants for delete to authenticated
  using (private.can_message(true));

revoke all on public.participants from public, anon, authenticated;
grant select, insert, update on public.participants to authenticated;
revoke all on public.participant_health from public, anon, authenticated;
grant select, insert, update on public.participant_health to authenticated;
revoke all on public.contact_guardians from public, anon, authenticated;
grant select, insert, update, delete on public.contact_guardians to authenticated;
revoke all on public.messages from public, anon, authenticated;
grant select, insert on public.messages to authenticated;
revoke all on public.unmatched_messages from public, anon, authenticated;
grant select on public.unmatched_messages to authenticated;
revoke all on public.workshop_booking_events from public, anon, authenticated;
grant select on public.workshop_booking_events to authenticated;
revoke all on public.booking_participants from public, anon, authenticated;
grant select, insert, delete on public.booking_participants to authenticated;

grant update (
  gender, state, country, whatsapp_e164, lifecycle_stage, lead_status, original_source, source_detail,
  utm_source, utm_medium, utm_campaign, utm_content, utm_term, meta_ad_id, fbclid, gclid, first_page, first_referrer,
  email_consent_at, email_consent_source, whatsapp_consent_at, whatsapp_consent_source, unsubscribed,
  facebook, tiktok, credit_balance, referral_code, skill_by_format, is_organiser, voucher_role, birthday_enquiry,
  academy_status, waiver_accepted_at, custom_fields
) on public.contacts to authenticated;

-- ---------- backfill, without overwriting anything staff have already set ----------
update public.contacts set
  email_consent_at = coalesce(email_consent_at, consent_at, created_at),
  email_consent_source = coalesce(email_consent_source, 'existing record')
where email_consent and email_consent_at is null;

update public.contacts set
  whatsapp_consent_at = coalesce(whatsapp_consent_at, consent_at, created_at),
  whatsapp_consent_source = coalesce(whatsapp_consent_source, 'existing record')
where whatsapp_consent and whatsapp_consent_at is null;

update public.contacts set unsubscribed = true
where unsubscribed_at is not null and not unsubscribed;

update public.contacts set phone_e164 = public.normalise_my_phone(phone)
where phone is not null and (phone_e164 is null or phone_e164 is distinct from public.normalise_my_phone(phone));

update public.contacts set whatsapp_e164 = phone_e164
where whatsapp_e164 is null and phone_e164 is not null;

update public.contacts set source_detail = left(first_source, 200)
where source_detail is null and first_source is not null;

update public.contacts c set
  utm_source = coalesce(c.utm_source, b.utm_source),
  utm_medium = coalesce(c.utm_medium, b.utm_medium),
  utm_campaign = coalesce(c.utm_campaign, b.utm_campaign),
  utm_content = coalesce(c.utm_content, b.utm_content),
  fbclid = coalesce(c.fbclid, b.fbclid),
  gclid = coalesce(c.gclid, b.gclid),
  first_page = coalesce(c.first_page, b.landing_page)
from (
  select distinct on (contact_id)
    contact_id, utm_source, utm_medium, utm_campaign, utm_content, fbclid, gclid, landing_page
  from public.workshop_bookings
  where contact_id is not null
  order by contact_id, created_at
) b
where c.id = b.contact_id
  and (c.utm_source is null or c.fbclid is null or c.gclid is null or c.first_page is null);

update public.contacts c set
  utm_term = coalesce(c.utm_term, t.utm_term),
  first_referrer = coalesce(c.first_referrer, t.referrer)
from (
  select distinct on (contact_id) contact_id, utm_term, referrer
  from public.trial_leads
  where contact_id is not null
  order by contact_id, created_at
) t
where c.id = t.contact_id and (c.utm_term is null or c.first_referrer is null);

update public.workshop_bookings set booker_contact_id = contact_id
where booker_contact_id is null and contact_id is not null;

insert into public.workshop_booking_events (booking_id, contact_id, event, occurred_at, detail)
select b.id, coalesce(b.booker_contact_id, b.contact_id), 'requested', b.created_at,
       left(b.session_name || ' · ' || coalesce(b.session_when, ''), 300)
from public.workshop_bookings b
where not exists (
  select 1 from public.workshop_booking_events e where e.booking_id = b.id and e.event = 'requested'
);

insert into public.workshop_booking_events (booking_id, contact_id, event, occurred_at, detail)
select b.id, coalesce(b.booker_contact_id, b.contact_id), b.status,
       coalesce(b.paid_at, b.updated_at, b.created_at),
       left(b.session_name || ' · ' || coalesce(b.session_when, ''), 300)
from public.workshop_bookings b
where b.status <> 'requested'
  and b.status in ('pending', 'confirmed', 'paid', 'expired', 'cancelled', 'refunded', 'no_show')
  and not exists (
    select 1 from public.workshop_booking_events e where e.booking_id = b.id and e.event = b.status
  );

-- Copy existing children jsonb into participant rows. The jsonb is left in place.
do $$
declare r record; kid jsonb; v_age int; v_dob date;
begin
  for r in select id, children from public.contacts where jsonb_typeof(children) = 'array' and jsonb_array_length(children) > 0 loop
    for kid in select value from jsonb_array_elements(r.children) loop
      begin
        v_age := substring(coalesce(kid->>'age', '') from '^[0-9]{1,2}')::int;
      exception when others then v_age := null;
      end;
      v_dob := null;
      if coalesce(kid->>'dob', '') ~ '^\d{4}-\d{2}-\d{2}$' then
        begin v_dob := (kid->>'dob')::date; exception when others then v_dob := null; end;
      end if;
      perform private.ensure_participant(r.id, kid->>'name', v_age, kid->>'school', kid->>'photo', kid->>'allergies', v_dob);
    end loop;
  end loop;
  for r in select id from public.workshop_bookings where contact_id is not null and jsonb_array_length(coalesce(children, '[]'::jsonb)) > 0 loop
    perform private.link_booking_participants(r.id);
  end loop;
end $$;

with conv as (
  select contact_id, created_at, 'workshop booking: ' || session_name as event,
         (status = 'paid') as paid, paid_at
  from public.workshop_bookings where contact_id is not null
  union all
  select contact_id, created_at, 'trial request', false, null
  from public.trial_leads where contact_id is not null
),
agg as (
  select contact_id,
    (array_agg(created_at order by created_at))[1] as first_at,
    (array_agg(event order by created_at))[1] as first_event,
    (array_agg(created_at order by created_at desc))[1] as recent_at,
    (array_agg(event order by created_at desc))[1] as recent_event,
    min(paid_at) filter (where paid) as became_at
  from conv group by contact_id
)
update public.contacts c set
  first_conversion_at = coalesce(c.first_conversion_at, a.first_at),
  first_conversion_event = coalesce(c.first_conversion_event, a.first_event),
  recent_conversion_at = coalesce(c.recent_conversion_at, a.recent_at),
  recent_conversion_event = coalesce(c.recent_conversion_event, a.recent_event),
  became_customer_at = coalesce(c.became_customer_at, a.became_at)
from agg a
where c.id = a.contact_id;

select private.refresh_contact(id) from public.contacts;

-- ---------- one timeline, and booking totals, both honours row security ----------
create view public.contact_timeline
with (security_invoker = true) as
select
  m.contact_id,
  m.occurred_at,
  'message'::text as kind,
  m.channel,
  m.direction,
  m.sender_type,
  m.sender_name,
  m.body,
  m.media,
  m.status,
  m.source,
  m.staff_id,
  m.id as message_id,
  null::uuid as booking_id,
  null::text as booking_event
from public.messages m
union
select
  e.contact_id,
  e.occurred_at,
  'booking'::text,
  'website'::text,
  'out'::text,
  'system'::text,
  null::text,
  e.detail,
  '[]'::jsonb,
  null::text,
  'live'::text,
  null::uuid,
  null::uuid,
  e.booking_id,
  e.event
from public.workshop_booking_events e
where e.contact_id is not null
union
select
  p.contact_id,
  e.occurred_at,
  'booking'::text,
  'website'::text,
  'out'::text,
  'system'::text,
  null::text,
  e.detail,
  '[]'::jsonb,
  null::text,
  'live'::text,
  null::uuid,
  null::uuid,
  e.booking_id,
  e.event
from public.workshop_booking_events e
join public.booking_participants bp on bp.booking_id = e.booking_id
join public.participants p on p.id = bp.participant_id
where p.contact_id is not null
union
select
  g.guardian_contact_id,
  e.occurred_at,
  'booking'::text,
  'website'::text,
  'out'::text,
  'system'::text,
  null::text,
  e.detail,
  '[]'::jsonb,
  null::text,
  'live'::text,
  null::uuid,
  null::uuid,
  e.booking_id,
  e.event
from public.workshop_booking_events e
join public.booking_participants bp on bp.booking_id = e.booking_id
join public.contact_guardians g on g.participant_id = bp.participant_id;

comment on view public.contact_timeline is
  'Messages and booking events for one customer, oldest context included. security_invoker so staff only see rows their role allows.';

create view public.contact_booking_stats
with (security_invoker = true) as
select
  c.id as contact_id,
  count(distinct b.id) filter (
    where b.status in ('requested', 'confirmed', 'paid', 'pending', 'no_show')
  )::int as total_bookings,
  coalesce(sum(b.amount) filter (where b.status = 'paid'), 0)::int as total_revenue_rm,
  max(b.session_date) filter (
    where b.status in ('requested', 'confirmed', 'paid', 'no_show')
  ) as last_booking_date,
  count(distinct b.id) filter (
    where b.status = 'paid' and b.session_date <= current_date
  )::int as workshops_attended,
  count(distinct b.id) filter (where b.status = 'no_show')::int as no_show_count,
  max(b.session_date) filter (
    where b.status = 'paid' and b.session_date <= current_date
  ) as last_workshop_at
from public.contacts c
left join public.workshop_bookings b
  on b.contact_id = c.id or b.booker_contact_id = c.id
group by c.id;

comment on view public.contact_booking_stats is
  'Bookings, revenue in RM, workshops attended, and no-shows for a customer. Computed, so it stays right if a status changes.';

revoke all on public.contact_timeline from public, anon, authenticated;
grant select on public.contact_timeline to authenticated;
revoke all on public.contact_booking_stats from public, anon, authenticated;
grant select on public.contact_booking_stats to authenticated;

commit;

-- Checks. anon should not appear. authenticated should not be able to update messages.
select table_name, grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('messages', 'participant_health', 'participants', 'contact_guardians', 'unmatched_messages', 'workshop_booking_events')
  and grantee in ('anon', 'authenticated')
group by table_name, grantee
order by table_name, grantee;
