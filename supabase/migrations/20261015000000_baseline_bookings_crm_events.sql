-- Baseline of the live database objects that were applied from the loose SQL files
-- before supabase/migrations existed. Idempotent. Do not run this against production
-- until the go-live approval. Safe to re-run: the source files use IF NOT EXISTS.
-- Order: bookings, then customers, then the public events calendar.

-- ===== from supabase/bookings.sql =====
-- Workshop bookings from the website, and staff access to them and to trial requests.
-- Run once in the Supabase SQL Editor (project fudaosneozobacdalncv), after trial_leads.
--
-- The booking form on each dated workshop page inserts one row per booking (status
-- 'requested' until payment is switched on; Stripe will set 'paid'). anon may INSERT a
-- 'requested' row and nothing else. Staff whose role has the 'bookings' permission read
-- and update rows in admin.html → Bookings. Every new row calls the booking-notify Edge
-- Function, which emails and WhatsApps Sabrina the session's attendee list.
--
-- Before running: Supabase → Project Settings → Vault → add a secret named
-- booking_hook_secret (any long random string) and put the same value in the Edge
-- Function secret BOOKING_HOOK_SECRET.


create table if not exists public.workshop_bookings (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  session_id      text not null,
  format          text not null,
  session_name    text not null,
  session_when    text not null,
  session_date    date not null,
  cap             int,
  first_name      text not null,
  last_name       text not null,
  name            text not null,          -- first_name + ' ' + last_name, used in lists and reports
  phone           text not null,
  email           text not null,
  qty             int not null default 1,
  ticket          text not null default 'single',
  people          int not null default 1,
  amount          int not null default 0,
  dine            boolean not null default false,
  allergies       text,
  child_name      text,                    -- children's first names, comma-separated (all of them are in children)
  child_age       text,
  children        jsonb not null default '[]',   -- [{name, age, allergies}] for kids' workshops
  collector       text,
  photo_consent   text,
  consents        text[] not null default '{}',
  status          text not null default 'requested',
  source          text,
  utm_source      text,
  utm_medium      text,
  utm_campaign    text,
  utm_content     text,
  gclid           text,
  fbclid          text,
  landing_page    text,
  stripe_session  text,
  paid_at         timestamptz,
  notes           text,
  updated_at      timestamptz,
  updated_by      uuid,
  constraint wb_session_id_format check (session_id ~ '^[a-z0-9-]{3,80}$'),
  constraint wb_format_format check (format ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint wb_text_lens check (
    char_length(session_name) <= 200 and char_length(session_when) <= 80
    and char_length(btrim(first_name)) between 1 and 60 and char_length(btrim(last_name)) between 1 and 60
    and char_length(btrim(name)) between 3 and 121
    and char_length(email) <= 320 and email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    and (allergies is null or char_length(allergies) <= 1000)
    and (child_name is null or char_length(child_name) <= 400)
    and (child_age is null or char_length(child_age) <= 40)
    and (collector is null or char_length(collector) <= 120)
    and (source is null or char_length(source) <= 200)
    and (landing_page is null or char_length(landing_page) <= 500)
    and (notes is null or char_length(notes) <= 2000)
  ),
  constraint wb_utm_lens check (
    coalesce(char_length(utm_source), 0) <= 200 and coalesce(char_length(utm_medium), 0) <= 200
    and coalesce(char_length(utm_campaign), 0) <= 200 and coalesce(char_length(utm_content), 0) <= 200
    and coalesce(char_length(gclid), 0) <= 200 and coalesce(char_length(fbclid), 0) <= 200
  ),
  constraint wb_phone_format check (phone ~ '^[0-9+(). -]{8,40}$'),
  constraint wb_qty check (qty between 1 and 20 and people between 1 and 40 and amount between 0 and 100000),
  constraint wb_ticket check (ticket in ('single', 'pair')),
  constraint wb_photo check (photo_consent is null or photo_consent in ('yes', 'no', 'yes without name', 'yes with first name')),
  constraint wb_children check (jsonb_typeof(children) = 'array' and jsonb_array_length(children) <= 12 and char_length(children::text) <= 4000),
  constraint wb_status check (status in ('requested', 'confirmed', 'paid', 'cancelled', 'refunded'))
);

comment on table public.workshop_bookings is
  'Workshop bookings from the website. anon can insert requested rows only; staff with the bookings permission read and update.';

create index if not exists workshop_bookings_session_idx on public.workshop_bookings (session_id, created_at);
create index if not exists workshop_bookings_date_idx on public.workshop_bookings (session_date);

alter table public.workshop_bookings enable row level security;
alter table public.trial_leads enable row level security;

-- Staff access follows role_permissions, section 'bookings' (same model as the content sections)
create or replace function private.can_bookings(p_write boolean)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    join public.role_permissions rp on rp.role = p.role and rp.section = 'bookings'
    where p.id = auth.uid() and p.active and (case when p_write then rp.can_write else rp.can_read end)
  );
$$;
revoke all on function private.can_bookings(boolean) from public;
grant execute on function private.can_bookings(boolean) to authenticated;

drop policy if exists wb_public_insert on public.workshop_bookings;
create policy wb_public_insert on public.workshop_bookings for insert to anon, authenticated
  with check (status = 'requested' and stripe_session is null and paid_at is null and notes is null and updated_by is null);

drop policy if exists wb_staff_read on public.workshop_bookings;
create policy wb_staff_read on public.workshop_bookings for select to authenticated using (private.can_bookings(false));

drop policy if exists wb_staff_update on public.workshop_bookings;
create policy wb_staff_update on public.workshop_bookings for update to authenticated
  using (private.can_bookings(true)) with check (private.can_bookings(true));

drop policy if exists tl_staff_read on public.trial_leads;
create policy tl_staff_read on public.trial_leads for select to authenticated using (private.can_bookings(false));

drop policy if exists tl_staff_update on public.trial_leads;
create policy tl_staff_update on public.trial_leads for update to authenticated
  using (private.can_bookings(true)) with check (private.can_bookings(true));

revoke all on public.workshop_bookings from anon, authenticated;
grant insert on public.workshop_bookings to anon, authenticated;
grant select, update (status, notes, updated_at, updated_by) on public.workshop_bookings to authenticated;
grant select, update (status) on public.trial_leads to authenticated;

insert into public.role_permissions (role, section, can_read, can_write)
select 'admin'::user_role, 'bookings', true, true
where not exists (select 1 from public.role_permissions p where p.role = 'admin'::user_role and p.section = 'bookings');

-- Each new booking pings the booking-notify Edge Function (pg_net, asynchronous: the
-- insert never waits for or fails on the email/WhatsApp send)
create extension if not exists pg_net;

create or replace function private.notify_booking()
returns trigger language plpgsql security definer set search_path = public as $$
declare secret text;
begin
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'booking_hook_secret';
  if secret is null then return new; end if;
  perform net.http_post(
    url := 'https://fudaosneozobacdalncv.supabase.co/functions/v1/booking-notify',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', secret),
    body := jsonb_build_object('booking_id', new.id, 'event', tg_op, 'status', new.status)
  );
  return new;
end;
$$;

drop trigger if exists workshop_bookings_notify on public.workshop_bookings;
create trigger workshop_bookings_notify after insert on public.workshop_bookings
  for each row execute function private.notify_booking();


-- Check: anon should have INSERT only on workshop_bookings; admin should have a bookings permission
select grantee, string_agg(privilege_type, ', ') from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'workshop_bookings' and grantee in ('anon', 'authenticated') group by 1;
select role, section, can_read, can_write from public.role_permissions where section = 'bookings';

-- ===== from supabase/crm.sql =====
-- Customers (B2C CRM) and online payment. Run in the Supabase SQL Editor after bookings.sql.
-- Safe to run more than once.
--
-- One row per customer in public.contacts, matched by email (then phone). Every workshop
-- booking and every trial request creates or updates its customer through the triggers
-- below, so the CRM fills itself from the website: name, WhatsApp, email, children,
-- bookings, total paid, first source, marketing consent. Staff read and edit customers in
-- admin.html → Customers (role permission section 'customers').
--
-- Online payment: the create-checkout Edge Function inserts a 'pending' booking and opens
-- Stripe Checkout; the stripe-webhook function sets it to 'paid' (or 'expired' if the
-- customer leaves). Both use the service role, so anon still only inserts 'requested'.


-- ---------- customers ----------
create table if not exists public.contacts (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  first_name         text not null,
  last_name          text,
  email              text,
  phone              text,
  children           jsonb not null default '[]',      -- [{name, age}] as last given on a booking or trial
  tags               text[] not null default '{}',
  notes              text,
  marketing_consent  boolean not null default false,
  consent_at         timestamptz,
  first_source       text,                             -- e.g. meta/launch, from the first booking or trial
  first_seen         timestamptz not null default now(),
  last_activity      timestamptz not null default now(),
  bookings_count     int not null default 0,
  trials_count       int not null default 0,
  total_paid         int not null default 0,           -- RM, paid workshop bookings
  updated_at         timestamptz,
  updated_by         uuid,
  constraint contacts_email_lower check (email is null or email = lower(email)),
  constraint contacts_lens check (char_length(first_name) <= 60 and coalesce(char_length(last_name), 0) <= 60
    and coalesce(char_length(notes), 0) <= 5000 and char_length(children::text) <= 4000)
);
-- ---------- fuller customer profile (all optional; staff fill these in admin.html → Customers) ----------
alter table public.contacts
  -- who they are
  add column if not exists preferred_name     text,
  add column if not exists birthday           date,                -- for birthday offers; the year may be left as 1900 if unknown
  add column if not exists language           text,                -- English, Mandarin, Malay, Cantonese, Other
  add column if not exists contact_type       text not null default 'individual',  -- individual, parent, adult student, corporate, partner
  add column if not exists company            text,
  add column if not exists job_title          text,
  -- how to reach them
  add column if not exists phone_2            text,
  add column if not exists preferred_channel  text,                -- whatsapp, email, phone
  add column if not exists instagram          text,
  add column if not exists address            text,
  add column if not exists area               text,                -- neighbourhood, e.g. Mont Kiara, Bangsar, Sri Hartamas
  add column if not exists city               text,
  add column if not exists postcode           text,
  add column if not exists emergency_name     text,
  add column if not exists emergency_phone    text,
  add column if not exists emergency_relation text,
  -- what they like
  add column if not exists interests          text[] not null default '{}',  -- painting, watercolour, kids art, voice, piano, photo & video, baking, candles, crochet, corporate, birthdays
  add column if not exists skill_level        text,                -- beginner, some experience, intermediate, advanced
  add column if not exists preferred_days     text[] not null default '{}',
  add column if not exists preferred_times    text[] not null default '{}',  -- weekday mornings, weekday evenings, Sunday morning, Sunday afternoon
  add column if not exists dietary            text,                -- for Savor meals and Bake Lab
  add column if not exists photo_consent      text,                -- their usual choice: yes, no, yes without name
  -- where they are with us
  add column if not exists stage              text not null default 'lead',
  add column if not exists enrolled_programmes text[] not null default '{}',
  add column if not exists enrolled_since     date,
  add column if not exists monthly_fee        int,                 -- RM, while enrolled
  add column if not exists trial_date         date,
  add column if not exists trial_outcome      text,                -- enrolled, thinking, not for them, no-show
  add column if not exists voucher_code       text,                -- the RM50 trial voucher from a workshop
  add column if not exists voucher_redeemed   boolean not null default false,
  add column if not exists last_booking_date  date,
  add column if not exists next_booking_date  date,
  -- how they found us
  add column if not exists how_heard          text,                -- instagram, facebook, google, friend, walk-in, Savor, school, event, other
  add column if not exists referred_by        uuid references public.contacts(id) on delete set null,
  add column if not exists last_source        text,
  add column if not exists first_campaign     text,
  -- permissions
  add column if not exists email_consent      boolean not null default false,
  add column if not exists whatsapp_consent   boolean not null default false,
  add column if not exists unsubscribed_at    timestamptz,
  add column if not exists do_not_contact     boolean not null default false,
  add column if not exists data_deletion_requested date,
  -- feedback
  add column if not exists rating             int,                 -- 0–10: how likely to recommend us
  add column if not exists google_review      boolean not null default false,
  add column if not exists testimonial_ok     boolean not null default false,
  -- follow-up
  add column if not exists owner              uuid,                -- the staff member looking after them (profiles.id)
  add column if not exists follow_up_date     date,
  add column if not exists follow_up_note     text,
  add column if not exists archived           boolean not null default false;

alter table public.contacts drop constraint if exists contacts_choices;
alter table public.contacts add constraint contacts_choices check (
  contact_type in ('individual', 'parent', 'adult student', 'corporate', 'partner')
  and stage in ('lead', 'trial requested', 'trial booked', 'trial attended', 'workshop customer', 'enrolled', 'paused', 'former student', 'lost')
  and (rating is null or rating between 0 and 10)
  and (monthly_fee is null or monthly_fee between 0 and 100000)
  and (preferred_channel is null or preferred_channel in ('whatsapp', 'email', 'phone'))
);
alter table public.contacts drop constraint if exists contacts_more_lens;
alter table public.contacts add constraint contacts_more_lens check (
  char_length(coalesce(preferred_name,'') || coalesce(company,'') || coalesce(job_title,'') || coalesce(instagram,'')
    || coalesce(area,'') || coalesce(city,'') || coalesce(postcode,'') || coalesce(emergency_name,'') || coalesce(emergency_relation,'')
    || coalesce(language,'') || coalesce(skill_level,'') || coalesce(trial_outcome,'') || coalesce(voucher_code,'') || coalesce(how_heard,'')) <= 1500
  and coalesce(char_length(address), 0) <= 500 and coalesce(char_length(dietary), 0) <= 500
  and coalesce(char_length(follow_up_note), 0) <= 1000 and coalesce(char_length(last_source), 0) <= 200
);
create index if not exists contacts_stage_idx on public.contacts (stage);
create index if not exists contacts_follow_up_idx on public.contacts (follow_up_date) where follow_up_date is not null;

create unique index if not exists contacts_email_key on public.contacts (email) where email is not null;
create index if not exists contacts_phone_idx on public.contacts (phone);
create index if not exists contacts_last_activity_idx on public.contacts (last_activity desc);

alter table public.workshop_bookings add column if not exists contact_id uuid references public.contacts(id) on delete set null;
alter table public.workshop_bookings add column if not exists marketing_consent boolean not null default false;
alter table public.trial_leads add column if not exists contact_id uuid references public.contacts(id) on delete set null;
alter table public.trial_leads add column if not exists marketing_consent boolean not null default false;
create index if not exists workshop_bookings_contact_idx on public.workshop_bookings (contact_id);
create index if not exists trial_leads_contact_idx on public.trial_leads (contact_id);

-- Booking statuses: pending = sent to Stripe, waiting for payment; expired = left Stripe without paying
alter table public.workshop_bookings drop constraint if exists wb_status;
alter table public.workshop_bookings add constraint wb_status
  check (status in ('pending', 'requested', 'confirmed', 'paid', 'expired', 'cancelled', 'refunded'));

-- ---------- match or create the customer, then keep their totals current ----------
create or replace function private.upsert_contact(p_first text, p_last text, p_email text, p_phone text,
  p_source text, p_consent boolean, p_children jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare cid uuid; em text := nullif(lower(btrim(p_email)), '');
begin
  if em is not null then select id into cid from public.contacts where email = em; end if;
  if cid is null and nullif(btrim(p_phone), '') is not null then
    select id into cid from public.contacts where phone = btrim(p_phone) and (email is null or em is null) order by created_at limit 1;
  end if;
  if cid is null then
    insert into public.contacts (first_name, last_name, email, phone, first_source, last_source, marketing_consent, email_consent,
                                 whatsapp_consent, consent_at, children)
    values (coalesce(nullif(btrim(p_first), ''), '?'), nullif(btrim(p_last), ''), em, nullif(btrim(p_phone), ''), p_source, p_source,
            coalesce(p_consent, false), coalesce(p_consent, false), coalesce(p_consent, false), case when p_consent then now() end,
            coalesce(p_children, '[]'))
    returning id into cid;
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
      last_source = coalesce(p_source, last_source),
      consent_at = case when not marketing_consent and p_consent then now() else consent_at end,
      last_activity = now()
    where id = cid;
  end if;
  return cid;
end;
$$;

create or replace function private.refresh_contact(p_id uuid)
returns void language sql security definer set search_path = public as $$
  update public.contacts c set
    bookings_count = (select count(*) from public.workshop_bookings b where b.contact_id = p_id and b.status in ('requested', 'confirmed', 'paid')),
    total_paid     = coalesce((select sum(amount) from public.workshop_bookings b where b.contact_id = p_id and b.status = 'paid'), 0),
    trials_count   = (select count(*) from public.trial_leads t where t.contact_id = p_id),
    last_booking_date = (select max(session_date) from public.workshop_bookings b where b.contact_id = p_id
                         and b.status in ('requested', 'confirmed', 'paid') and b.session_date <= current_date),
    next_booking_date = (select min(session_date) from public.workshop_bookings b where b.contact_id = p_id
                         and b.status in ('requested', 'confirmed', 'paid') and b.session_date > current_date),
    -- the stage only moves forward by itself; staff set enrolled, paused, former student and lost
    stage = case
      when c.stage in ('lead', 'trial requested') and exists (select 1 from public.workshop_bookings b where b.contact_id = p_id and b.status = 'paid')
        then 'workshop customer'
      when c.stage = 'lead' and exists (select 1 from public.trial_leads t where t.contact_id = p_id) then 'trial requested'
      else c.stage end,
    contact_type = case when c.contact_type = 'individual' and jsonb_array_length(c.children) > 0 then 'parent' else c.contact_type end
  where c.id = p_id;
$$;

create or replace function private.booking_to_contact()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.contact_id is null then
    new.contact_id := private.upsert_contact(new.first_name, new.last_name, new.email, new.phone, new.source,
      new.marketing_consent, (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('name', k->>'name', 'age', k->>'age',
                              'school', k->>'school', 'allergies', k->>'allergies'))), '[]') from jsonb_array_elements(new.children) k));
  end if;
  return new;
end;
$$;
drop trigger if exists workshop_bookings_contact on public.workshop_bookings;
create trigger workshop_bookings_contact before insert on public.workshop_bookings
  for each row execute function private.booking_to_contact();

-- trial_leads keeps one name field: the first word is the first name; "For: Mia, age 7 (child of …)" adds a child
create or replace function private.trial_to_contact()
returns trigger language plpgsql security definer set search_path = public as $$
declare kid jsonb := '[]';
begin
  if new.message ~ 'For: [^,\n]+, age [^ \n]+ \(child of' then
    kid := jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'name', substring(new.message from 'For: ([^,\n]+), age'), 'age', substring(new.message from ', age ([^ \n]+) \(child of'),
      'school', substring(new.message from '\nSchool: ([^\n]+)'))));
  end if;
  if new.contact_id is null then
    new.contact_id := private.upsert_contact(split_part(btrim(new.parent_name), ' ', 1),
      nullif(btrim(substr(btrim(new.parent_name), char_length(split_part(btrim(new.parent_name), ' ', 1)) + 1)), ''),
      new.email, new.phone, coalesce(new.utm_source, new.ref_code), new.marketing_consent, '[]');
  end if;
  if jsonb_array_length(kid) > 0 then   -- several children arrive as several rows: add each one once
    update public.contacts set children = children || kid
    where id = new.contact_id and not children @> jsonb_build_array(jsonb_build_object('name', kid->0->>'name'));
  end if;
  return new;
end;
$$;
drop trigger if exists trial_leads_contact on public.trial_leads;
create trigger trial_leads_contact before insert on public.trial_leads
  for each row execute function private.trial_to_contact();

create or replace function private.contact_totals()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.contact_id is not null then perform private.refresh_contact(new.contact_id); end if;
  if tg_op = 'UPDATE' and old.contact_id is distinct from new.contact_id and old.contact_id is not null then
    perform private.refresh_contact(old.contact_id);
  end if;
  return null;
end;
$$;
drop trigger if exists workshop_bookings_totals on public.workshop_bookings;
create trigger workshop_bookings_totals after insert or update of status, amount, contact_id on public.workshop_bookings
  for each row execute function private.contact_totals();
drop trigger if exists trial_leads_totals on public.trial_leads;
create trigger trial_leads_totals after insert on public.trial_leads
  for each row execute function private.contact_totals();

-- Sabrina's report goes out for bookings she can act on: a WhatsApp request, or a payment
-- (not when someone is sent to Stripe and hasn't paid yet)
create or replace function private.notify_booking()
returns trigger language plpgsql security definer set search_path = public as $$
declare secret text;
begin
  if new.status not in ('requested', 'paid') then return new; end if;
  if tg_op = 'UPDATE' and old.status = new.status then return new; end if;
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'booking_hook_secret';
  if secret is null then return new; end if;
  perform net.http_post(
    url := 'https://fudaosneozobacdalncv.supabase.co/functions/v1/booking-notify',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', secret),
    body := jsonb_build_object('booking_id', new.id, 'event', tg_op, 'status', new.status)
  );
  return new;
end;
$$;
drop trigger if exists workshop_bookings_notify on public.workshop_bookings;
create trigger workshop_bookings_notify after insert or update of status on public.workshop_bookings
  for each row execute function private.notify_booking();

-- ---------- staff access: section 'customers' ----------
create or replace function private.can_section(p_section text, p_write boolean)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    join public.role_permissions rp on rp.role = p.role and rp.section = p_section
    where p.id = auth.uid() and p.active and (case when p_write then rp.can_write else rp.can_read end)
  );
$$;
revoke all on function private.can_section(text, boolean) from public;
grant execute on function private.can_section(text, boolean) to authenticated;

alter table public.contacts enable row level security;
drop policy if exists contacts_staff_read on public.contacts;
create policy contacts_staff_read on public.contacts for select to authenticated using (private.can_section('customers', false));
drop policy if exists contacts_staff_write on public.contacts;
create policy contacts_staff_write on public.contacts for update to authenticated
  using (private.can_section('customers', true)) with check (private.can_section('customers', true));
drop policy if exists contacts_staff_insert on public.contacts;
create policy contacts_staff_insert on public.contacts for insert to authenticated with check (private.can_section('customers', true));

-- Customers staff also see each customer's bookings and trials
drop policy if exists wb_customers_read on public.workshop_bookings;
create policy wb_customers_read on public.workshop_bookings for select to authenticated using (private.can_section('customers', false));
drop policy if exists tl_customers_read on public.trial_leads;
create policy tl_customers_read on public.trial_leads for select to authenticated using (private.can_section('customers', false));

revoke all on public.contacts from anon, authenticated;
grant select, insert on public.contacts to authenticated;
grant update (first_name, last_name, email, phone, children, tags, notes, marketing_consent, consent_at, updated_at, updated_by,
  preferred_name, birthday, language, contact_type, company, job_title, phone_2, preferred_channel, instagram, address, area, city,
  postcode, emergency_name, emergency_phone, emergency_relation, interests, skill_level, preferred_days, preferred_times, dietary,
  photo_consent, stage, enrolled_programmes, enrolled_since, monthly_fee, trial_date, trial_outcome, voucher_code, voucher_redeemed,
  how_heard, referred_by, email_consent, whatsapp_consent, unsubscribed_at, do_not_contact, data_deletion_requested, rating,
  google_review, testimonial_ok, owner, follow_up_date, follow_up_note, archived)
  on public.contacts to authenticated;
-- the website's insert-only grants: the new consent column (trial_leads grants insert column by column)
grant insert on public.workshop_bookings to anon, authenticated;
grant insert (marketing_consent) on public.trial_leads to anon;

insert into public.role_permissions (role, section, can_read, can_write)
select 'admin'::user_role, 'customers', true, true
where not exists (select 1 from public.role_permissions p where p.role = 'admin'::user_role and p.section = 'customers');

-- Customers from bookings and trials made before this ran
do $$
declare r record;
begin
  for r in select * from public.trial_leads where contact_id is null order by created_at loop
    update public.trial_leads set contact_id = private.upsert_contact(split_part(btrim(r.parent_name), ' ', 1),
      nullif(btrim(substr(btrim(r.parent_name), char_length(split_part(btrim(r.parent_name), ' ', 1)) + 1)), ''),
      r.email, r.phone, coalesce(r.utm_source, r.ref_code), false, '[]') where id = r.id;
  end loop;
  for r in select * from public.workshop_bookings where contact_id is null order by created_at loop
    update public.workshop_bookings set contact_id = private.upsert_contact(r.first_name, r.last_name, r.email, r.phone, r.source, false, '[]')
    where id = r.id;
  end loop;
end $$;
select private.refresh_contact(id) from public.contacts;


-- Check: anon must have no access to contacts; admin should have a customers permission
select grantee, string_agg(privilege_type, ', ') from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'contacts' and grantee in ('anon', 'authenticated') group by 1;
select role, section, can_read, can_write from public.role_permissions where section = 'customers';

-- ===== from supabase/events.sql =====
-- Events calendar: admin-managed events shown on the homepage "What's on"
-- calendar and the Workshops page. Run once in the Supabase SQL Editor.

create table if not exists public.events (
  id           uuid primary key default gen_random_uuid(),
  event_date   date not null,
  start_time   time not null,
  end_time     time,
  title        text not null,
  category     text not null default 'Workshop' check (category in ('Workshop', 'Performance', 'Event')),
  kind         text,                       -- e.g. Painting, Baking, Cooking (shown as "Painting workshop")
  description  text,
  allow_reserve boolean not null default true,
  visible      boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz,
  updated_by   uuid
);
alter table public.events enable row level security;

-- Same staff permissions + audit trail as the other content sections
do $$ begin
  perform private.reapply_section_rls('events', 'events');
exception when undefined_function then
  null;
end $$;
insert into public.role_permissions (role, section, can_read, can_write)
select r::user_role, 'events', true, true
from unnest(array['admin', 'marketing']) as r
where not exists (select 1 from public.role_permissions p where p.role = r::user_role and p.section = 'events');

-- Public, read-only view: visible events from yesterday onwards
create or replace view public.events_public as
  select id, event_date, start_time, end_time, title, category, kind, description, allow_reserve
  from public.events
  where visible and event_date >= current_date - 1
  order by event_date, start_time;

-- Revoke AFTER creating the view (Supabase grants full rights by default)
revoke all on public.events from anon;
revoke all on public.events_public from anon, authenticated;
grant select on public.events_public to anon, authenticated;

-- The October 2026 workshops already on the website
insert into public.events (event_date, start_time, end_time, title, category, kind, description)
select * from (values
  (date '2026-10-04', time '15:00', time '17:00', 'Textured canvas painting', 'Workshop', 'Painting', 'Build up texture on canvas with paint and mixed media — a relaxed, hands-on painting workshop for all ages.'),
  (date '2026-10-11', time '15:00', time '17:00', 'Plant-based cooking class', 'Workshop', 'Cooking', 'Cook simple, delicious plant-based dishes from scratch — a hands-on cooking workshop for all ages.'),
  (date '2026-10-18', time '15:00', time '17:00', 'Painting on canvas — lemon theme (Sip & Paint)', 'Workshop', 'Painting', 'A guided Sip & Paint session painting a lemon-themed canvas — no experience needed.'),
  (date '2026-10-25', time '15:00', time '17:00', 'Sourdough', 'Workshop', 'Baking', 'Learn the basics of sourdough bread and bake your own to take home.')
) v(event_date, start_time, end_time, title, category, kind, description)
where not exists (select 1 from public.events);


-- Check: should list 4 events, and anon/authenticated should have SELECT only
select event_date, start_time, title from public.events_public;
select grantee, string_agg(privilege_type, ', ') from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'events_public' and grantee in ('anon', 'authenticated') group by 1;
