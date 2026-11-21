-- Shared inbox: conversations, saved replies, template queue, sabbath and welcome rules.
-- Run in the Supabase SQL Editor after 20261120143000_crm_timeline_and_profile.sql.
-- Safe to run more than once. Does not delete customers or messages.
-- Do not run this from the website deploy. 360dialog is not called from here.

begin;

-- ---------- inbox rules the studio can edit ----------
create table if not exists public.inbox_settings (
  id                         int primary key default 1,
  automation_pause_minutes   int not null default 30,
  sabbath_start_dow          int not null default 5,          -- Friday (Sunday = 0)
  sabbath_start_time         time not null default '19:00',
  sabbath_end_dow            int not null default 6,          -- Saturday
  sabbath_end_time           time not null default '19:30',
  sabbath_reply              text not null,
  welcome_reply              text not null,
  welcome_buttons            jsonb not null default '["Painting","Baking","Kids","Crochet/Yarn","Other"]',
  updated_at                 timestamptz,
  constraint inbox_settings_one check (id = 1),
  constraint inbox_settings_pause check (automation_pause_minutes between 0 and 24 * 60),
  constraint inbox_settings_dow check (sabbath_start_dow between 0 and 6 and sabbath_end_dow between 0 and 6),
  constraint inbox_settings_buttons check (jsonb_typeof(welcome_buttons) = 'array')
);

create or replace function private.inbox_copy_ok(p text)
returns boolean
language sql
immutable
as $$
  select p is null or (
    p !~* 'sip and paint'
    and p !~* 'cheaper than'
    and p !~* '\mhrdc\M'
    and p !~* 'plant-based'
    and p !~* 'plant based'
  );
$$;

alter table public.inbox_settings drop constraint if exists inbox_settings_brand;
alter table public.inbox_settings add constraint inbox_settings_brand check (
  private.inbox_copy_ok(sabbath_reply) and private.inbox_copy_ok(welcome_reply)
);

insert into public.inbox_settings (id, sabbath_reply, welcome_reply)
values (
  1,
  'Thank you for writing to Master Artist. The studio rests from Friday evening until Saturday evening. Someone will reply on Saturday night or Sunday.',
  'Hello {first_name}, welcome to Master Artist. Tell us what you would like to try and we will reply with the next session.'
)
on conflict (id) do nothing;

comment on table public.inbox_settings is
  'Inbox rules. Sabbath window defaults to Friday 19:00 through Saturday 19:30, Asia/Kuala_Lumpur. Copy must not use the banned phrases.';

alter table public.contacts add column if not exists ctwa_clid text;
alter table public.contacts add column if not exists automation_paused_until timestamptz;
comment on column public.contacts.ctwa_clid is 'Click-to-WhatsApp click id from the inbound webhook referral, when Meta sends one.';
comment on column public.contacts.automation_paused_until is 'Set when a staff member messages this customer. Automations wait until this time.';

-- ---------- one conversation per customer and channel ----------
create table if not exists public.conversations (
  id                       uuid primary key default gen_random_uuid(),
  contact_id               uuid not null references public.contacts(id) on delete cascade,
  channel                  text not null,
  status                   text not null default 'open',
  assigned_to              uuid,
  last_message_at          timestamptz,
  last_message_preview     text,
  last_direction           text,
  last_inbound_at          timestamptz,
  unread_count             int not null default 0,
  automation_paused_until  timestamptz,
  welcome_sent_at          timestamptz,
  sabbath_replied_window   text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz,
  constraint conversations_channel check (channel in ('whatsapp', 'email', 'website', 'instagram', 'facebook', 'note')),
  constraint conversations_status check (status in ('open', 'closed')),
  constraint conversations_direction check (last_direction is null or last_direction in ('in', 'out')),
  constraint conversations_pair unique (contact_id, channel)
);

create index if not exists conversations_recent_idx on public.conversations (last_message_at desc nulls last);
create index if not exists conversations_assigned_idx on public.conversations (assigned_to) where status = 'open';

comment on table public.conversations is
  'Shared inbox thread. One row per customer and channel. Message bodies stay in public.messages.';

alter table public.messages add column if not exists conversation_id uuid references public.conversations(id) on delete set null;
alter table public.messages add column if not exists buttons jsonb not null default '[]';
alter table public.messages drop constraint if exists messages_buttons_arr;
alter table public.messages add constraint messages_buttons_arr check (jsonb_typeof(buttons) = 'array');
create index if not exists messages_conversation_idx on public.messages (conversation_id, occurred_at);

-- ---------- saved replies, mentions, approved templates, send queue ----------
create table if not exists public.saved_replies (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  shortcut    text not null,
  body        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz,
  created_by  uuid,
  constraint saved_replies_title check (char_length(btrim(title)) between 1 and 80),
  constraint saved_replies_shortcut check (shortcut ~ '^/[a-z0-9-]{1,40}$'),
  constraint saved_replies_body check (char_length(body) between 1 and 2000 and private.inbox_copy_ok(body)),
  constraint saved_replies_shortcut_key unique (shortcut)
);

create table if not exists public.message_mentions (
  id          uuid primary key default gen_random_uuid(),
  message_id  uuid not null references public.messages(id) on delete cascade,
  staff_id    uuid not null,
  created_at  timestamptz not null default now(),
  constraint message_mentions_pair unique (message_id, staff_id)
);
comment on table public.message_mentions is
  'Staff @mentioned on an internal note. TODO: deliver a notification. This table only stores the mention.';

insert into public.saved_replies (title, shortcut, body) values
  ('Hold a seat', '/hold', 'Hello {first_name}, I can hold a seat for {workshop} on {date}.'),
  ('Sunday sessions', '/sunday', 'Hello {first_name}, Sunday sessions are on the website. Tell me which one you would like.')
on conflict (shortcut) do nothing;

create table if not exists public.message_templates (
  id        uuid primary key default gen_random_uuid(),
  name      text not null,
  language  text not null default 'en',
  body      text not null,
  kind      text not null default 'utility',
  buttons   jsonb not null default '[]',
  active    boolean not null default true,
  constraint message_templates_name unique (name),
  constraint message_templates_kind check (kind in ('utility', 'marketing')),
  constraint message_templates_body check (char_length(body) between 1 and 2000 and private.inbox_copy_ok(body)),
  constraint message_templates_buttons check (jsonb_typeof(buttons) = 'array')
);

insert into public.message_templates (name, language, kind, body) values
  ('booking_confirmed', 'en', 'utility', 'Hello {first_name}, you are confirmed for {workshop} on {date}. We look forward to seeing you at Master Artist.'),
  ('reminder_2day', 'en', 'utility', 'Hello {first_name}, a reminder that {workshop} is on {date}.'),
  ('reminder_dayof', 'en', 'utility', 'Hello {first_name}, {workshop} is this morning ({date}). See you at the studio.'),
  ('post_workshop', 'en', 'marketing', 'Hello {first_name}, thank you for coming to {workshop}. We hope you enjoyed it.')
on conflict (name) do nothing;

create table if not exists public.outbound_queue (
  id              uuid primary key default gen_random_uuid(),
  contact_id      uuid references public.contacts(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  booking_id      uuid references public.workshop_bookings(id) on delete cascade,
  message_id      uuid references public.messages(id) on delete set null,
  template_name   text,
  language        text not null default 'en',
  kind            text not null,
  body            text,
  buttons         jsonb not null default '[]',
  variables       jsonb not null default '{}',
  scheduled_at    timestamptz not null,
  status          text not null default 'queued',
  skip_reason     text,
  provider_ref    text,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz,
  constraint outbound_queue_kind check (kind in (
    'booking_confirmed', 'reminder_2day', 'reminder_dayof', 'post_workshop',
    'sabbath_reply', 'welcome', 'staff_reply', 'manual_template'
  )),
  constraint outbound_queue_status check (status in ('queued', 'sent', 'failed', 'skipped')),
  constraint outbound_queue_vars check (jsonb_typeof(variables) = 'object' and jsonb_typeof(buttons) = 'array')
);

create unique index if not exists outbound_queue_booking_kind_idx
  on public.outbound_queue (booking_id, kind) where booking_id is not null;
create index if not exists outbound_queue_due_idx
  on public.outbound_queue (scheduled_at) where status = 'queued';

comment on table public.outbound_queue is
  'Scheduler-ready WhatsApp sends. fetch_due_outbound lists what is due. The 360dialog call itself is not in this database; a later worker uses the provider adapter.';

-- ---------- conversation helpers ----------
create or replace function private.ensure_conversation(p_contact uuid, p_channel text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare cid uuid;
begin
  if p_contact is null or p_channel is null then return null; end if;
  insert into public.conversations (contact_id, channel)
  values (p_contact, p_channel)
  on conflict (contact_id, channel) do update set updated_at = coalesce(public.conversations.updated_at, now())
  returning id into cid;
  return cid;
end;
$$;

create or replace function private.fill_template(p_body text, p_vars jsonb)
returns text
language sql
immutable
as $$
  select replace(replace(replace(replace(coalesce(p_body, ''),
    '{first_name}', coalesce(p_vars->>'first_name', '')),
    '{last_name}', coalesce(p_vars->>'last_name', '')),
    '{workshop}', coalesce(p_vars->>'workshop', '')),
    '{date}', coalesce(p_vars->>'date', ''));
$$;

create or replace function private.kl_week_key(p_at timestamptz)
returns int
language sql
stable
as $$
  select extract(dow from timezone('Asia/Kuala_Lumpur', p_at))::int * 1440
    + extract(hour from timezone('Asia/Kuala_Lumpur', p_at))::int * 60
    + extract(minute from timezone('Asia/Kuala_Lumpur', p_at))::int;
$$;

create or replace function private.in_sabbath(p_at timestamptz)
returns boolean
language plpgsql
stable
set search_path = public
as $$
declare
  s public.inbox_settings%rowtype;
  now_key int;
  start_key int;
  end_key int;
begin
  select * into s from public.inbox_settings where id = 1;
  if s.id is null then return false; end if;
  now_key := private.kl_week_key(p_at);
  start_key := s.sabbath_start_dow * 1440 + extract(hour from s.sabbath_start_time)::int * 60 + extract(minute from s.sabbath_start_time)::int;
  end_key := s.sabbath_end_dow * 1440 + extract(hour from s.sabbath_end_time)::int * 60 + extract(minute from s.sabbath_end_time)::int;
  if start_key = end_key then return false; end if;
  if start_key < end_key then return now_key >= start_key and now_key < end_key; end if;
  return now_key >= start_key or now_key < end_key;
end;
$$;

create or replace function private.sabbath_window_key(p_at timestamptz)
returns text
language sql
stable
as $$
  select case when private.in_sabbath(p_at) then to_char(
    (timezone('Asia/Kuala_Lumpur', p_at))::date
      - case when extract(dow from timezone('Asia/Kuala_Lumpur', p_at))::int = 6 then 1 else 0 end,
    'YYYY-MM-DD') else null end;
$$;

create or replace function public.automation_allowed(p_conversation uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists (
    select 1 from public.conversations c
    where c.id = p_conversation and c.automation_paused_until > now()
  ) and not exists (
    select 1 from public.contacts ct
    join public.conversations c on c.contact_id = ct.id
    where c.id = p_conversation and ct.automation_paused_until > now()
  );
$$;

create or replace function private.queue_message(
  p_contact uuid,
  p_conversation uuid,
  p_booking uuid,
  p_kind text,
  p_template text,
  p_body text,
  p_buttons jsonb,
  p_vars jsonb,
  p_when timestamptz,
  p_skip text,
  p_message uuid default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  qid uuid;
  mid uuid := p_message;
  v_status text := case when p_skip is null then 'queued' else 'skipped' end;
begin
  if p_booking is not null and exists (
    select 1 from public.outbound_queue q where q.booking_id = p_booking and q.kind = p_kind
  ) then
    return null;
  end if;
  if mid is null and p_skip is null and p_body is not null then
    insert into public.messages (
      contact_id, conversation_id, channel, direction, sender_type, sender_name, body, buttons,
      source, occurred_at, status
    ) values (
      p_contact, p_conversation, 'whatsapp', 'out', 'bot', 'Master Artist', left(p_body, 8000),
      coalesce(p_buttons, '[]'::jsonb), 'live', now(), null
    ) returning id into mid;
  end if;
  insert into public.outbound_queue (
    contact_id, conversation_id, booking_id, message_id, template_name, kind, body, buttons,
    variables, scheduled_at, status, skip_reason
  ) values (
    p_contact, p_conversation, p_booking, mid, p_template, p_kind, p_body, coalesce(p_buttons, '[]'::jsonb),
    coalesce(p_vars, '{}'::jsonb), coalesce(p_when, now()), v_status, p_skip
  ) returning id into qid;
  return qid;
exception when unique_violation then
  return null;
end;
$$;

create or replace function private.capture_click_to_whatsapp(p_contact uuid, p_raw jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctwa text;
  v_ad text;
begin
  if p_contact is null or p_raw is null then return; end if;
  v_ctwa := coalesce(p_raw->'referral'->>'ctwa_clid', p_raw->>'ctwa_clid');
  v_ad := coalesce(p_raw->'referral'->>'source_id', p_raw->>'source_id', p_raw->>'ad_id', p_raw->>'source_ad_id', p_raw->>'meta_ad_id');
  update public.contacts set
    ctwa_clid = coalesce(ctwa_clid, nullif(v_ctwa, '')),
    meta_ad_id = coalesce(meta_ad_id, nullif(v_ad, '')),
    tags = case
      when nullif(v_ad, '') is not null and not tags @> array['source ad'] then tags || array['source ad']
      else tags end
  where id = p_contact
    and (v_ctwa is not null or v_ad is not null);
end;
$$;

create or replace function private.maybe_auto_reply(p_message public.messages)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  conv public.conversations%rowtype;
  settings public.inbox_settings%rowtype;
  person public.contacts%rowtype;
  v_key text;
  v_skip text;
  v_buttons jsonb;
  v_body text;
  v_vars jsonb;
  v_prior int;
begin
  if p_message.source is distinct from 'live' or p_message.direction is distinct from 'in'
     or p_message.sender_type is distinct from 'customer' or p_message.channel is distinct from 'whatsapp' then
    return;
  end if;
  select * into conv from public.conversations where id = p_message.conversation_id;
  if conv.id is null then return; end if;
  select * into settings from public.inbox_settings where id = 1;
  select * into person from public.contacts where id = p_message.contact_id;
  perform private.capture_click_to_whatsapp(person.id, p_message.raw);
  v_vars := jsonb_build_object('first_name', coalesce(person.preferred_name, person.first_name, ''));
  v_key := private.sabbath_window_key(p_message.occurred_at);
  v_skip := case when public.automation_allowed(conv.id) then null else 'automation paused' end;
  if v_key is not null and conv.sabbath_replied_window is distinct from v_key then
    v_buttons := case when conv.welcome_sent_at is null then settings.welcome_buttons else '[]'::jsonb end;
    v_body := private.fill_template(settings.sabbath_reply, v_vars);
    perform private.queue_message(person.id, conv.id, null, 'sabbath_reply', null, v_body, v_buttons, v_vars, p_message.occurred_at, v_skip);
    update public.conversations set
      sabbath_replied_window = v_key,
      welcome_sent_at = coalesce(welcome_sent_at, p_message.occurred_at)
    where id = conv.id;
    return;
  end if;
  if conv.welcome_sent_at is null then
    select count(*) into v_prior from public.messages m
    where m.conversation_id = conv.id and m.direction = 'out' and m.id <> p_message.id;
    if v_prior = 0 then
      v_body := private.fill_template(settings.welcome_reply, v_vars);
      perform private.queue_message(person.id, conv.id, null, 'welcome', null, v_body, settings.welcome_buttons, v_vars, p_message.occurred_at, v_skip);
      update public.conversations set welcome_sent_at = p_message.occurred_at where id = conv.id;
    end if;
  end if;
end;
$$;

create or replace function private.messages_before_conversation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.conversation_id is null and new.contact_id is not null then
    new.conversation_id := private.ensure_conversation(new.contact_id, new.channel);
  end if;
  if new.buttons is null then new.buttons := '[]'::jsonb; end if;
  return new;
end;
$$;

drop trigger if exists messages_before_conversation on public.messages;
create trigger messages_before_conversation before insert on public.messages
  for each row execute function private.messages_before_conversation();

create or replace function private.messages_after_conversation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare mins int;
begin
  if new.conversation_id is null then return null; end if;
  update public.conversations c set
    last_message_at = case when c.last_message_at is null or new.occurred_at >= c.last_message_at then new.occurred_at else c.last_message_at end,
    last_message_preview = case when c.last_message_at is null or new.occurred_at >= c.last_message_at then left(coalesce(new.body, ''), 140) else c.last_message_preview end,
    last_direction = case when c.last_message_at is null or new.occurred_at >= c.last_message_at then new.direction else c.last_direction end,
    last_inbound_at = case
      when new.direction = 'in' and new.sender_type = 'customer'
        then greatest(coalesce(c.last_inbound_at, new.occurred_at), new.occurred_at)
      else c.last_inbound_at end,
    unread_count = c.unread_count + case
      when new.direction = 'in' and new.sender_type = 'customer' and new.source = 'live' then 1 else 0 end,
    status = case
      when c.status = 'closed' and new.direction = 'in' and new.sender_type = 'customer' and new.source = 'live' then 'open'
      else c.status end,
    updated_at = now()
  where c.id = new.conversation_id;

  if new.direction = 'out' and new.sender_type = 'staff' and new.channel <> 'note' then
    select automation_pause_minutes into mins from public.inbox_settings where id = 1;
    mins := coalesce(mins, 30);
    update public.conversations set automation_paused_until = now() + (mins * interval '1 minute') where id = new.conversation_id;
    update public.contacts set automation_paused_until = now() + (mins * interval '1 minute') where id = new.contact_id;
  end if;

  if new.source = 'live' and new.direction = 'in' and new.sender_type = 'customer' and new.channel = 'whatsapp' then
    perform private.maybe_auto_reply(new);
  end if;
  return null;
end;
$$;

drop trigger if exists messages_after_conversation on public.messages;
create trigger messages_after_conversation after insert on public.messages
  for each row execute function private.messages_after_conversation();

-- Booking templates: on confirm, and on paid if it never passed through confirmed.
create or replace function private.enqueue_booking_templates(p_booking uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  b public.workshop_bookings%rowtype;
  person public.contacts%rowtype;
  conv uuid;
  vars jsonb;
  v_date text;
  v_when_2 timestamptz;
  v_when_day timestamptz;
  v_when_after timestamptz;
  v_skip text;
  v_phone text;
  tpl record;
begin
  select * into b from public.workshop_bookings where id = p_booking;
  if b.id is null or b.contact_id is null then return; end if;
  if b.status not in ('confirmed', 'paid') then return; end if;
  select * into person from public.contacts where id = b.contact_id;
  v_phone := coalesce(person.whatsapp_e164, person.phone_e164);
  conv := private.ensure_conversation(b.contact_id, 'whatsapp');
  v_date := to_char(b.session_date, 'DD Mon YYYY');
  vars := jsonb_build_object(
    'first_name', coalesce(person.preferred_name, person.first_name, ''),
    'last_name', coalesce(person.last_name, ''),
    'workshop', b.session_name,
    'date', v_date
  );
  v_when_2 := ((b.session_date - 2) + time '09:00') at time zone 'Asia/Kuala_Lumpur';
  v_when_day := (b.session_date + time '09:00') at time zone 'Asia/Kuala_Lumpur';
  v_when_after := ((b.session_date + 1) + time '09:00') at time zone 'Asia/Kuala_Lumpur';
  for tpl in
    select * from (values
      ('booking_confirmed', 'booking_confirmed', now()),
      ('reminder_2day', 'reminder_2day', v_when_2),
      ('reminder_dayof', 'reminder_dayof', v_when_day),
      ('post_workshop', 'post_workshop', v_when_after)
    ) as t(kind, template_name, scheduled_at)
  loop
    v_skip := null;
    if v_phone is null then v_skip := 'no whatsapp number';
    elsif tpl.kind = 'post_workshop' and not (person.whatsapp_consent or person.marketing_consent) then
      v_skip := 'no marketing opt-in';
    elsif tpl.scheduled_at < now() - interval '6 hours' and tpl.kind <> 'booking_confirmed' then
      v_skip := 'missed window';
    end if;
    perform private.queue_message(
      b.contact_id, conv, b.id, tpl.kind, tpl.template_name,
      private.fill_template((select body from public.message_templates where name = tpl.template_name), vars),
      '[]'::jsonb, vars,
      case when v_skip is null and tpl.scheduled_at < now() then now() else tpl.scheduled_at end,
      v_skip
    );
  end loop;
end;
$$;

create or replace function private.trg_enqueue_booking_templates()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('confirmed', 'paid') and (tg_op = 'INSERT' or old.status is distinct from new.status)
     and not (tg_op = 'UPDATE' and old.status in ('confirmed', 'paid')) then
    perform private.enqueue_booking_templates(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists workshop_bookings_templates on public.workshop_bookings;
create trigger workshop_bookings_templates after insert or update of status on public.workshop_bookings
  for each row execute function private.trg_enqueue_booking_templates();

create or replace function public.fetch_due_outbound(p_limit int default 50)
returns setof public.outbound_queue
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and (not private.can_bookings(false) or not private.not_marketing()) then
    return;
  end if;
  return query
  select q.*
  from public.outbound_queue q
  left join public.conversations c on c.id = q.conversation_id
  left join public.contacts ct on ct.id = q.contact_id
  where q.status = 'queued'
    and q.scheduled_at <= now()
    and (c.automation_paused_until is null or c.automation_paused_until <= now())
    and (ct.automation_paused_until is null or ct.automation_paused_until <= now())
  order by q.scheduled_at
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;

comment on function public.fetch_due_outbound(int) is
  'Rows the WhatsApp worker should send. Skips anything whose conversation or customer is inside automation_paused_until. Does not call 360dialog.';

create or replace function public.send_conversation_message(
  p_conversation uuid,
  p_body text,
  p_template text,
  p_as_note boolean,
  p_mentions uuid[]
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  conv public.conversations%rowtype;
  person public.contacts%rowtype;
  tpl public.message_templates%rowtype;
  v_body text;
  v_last timestamptz;
  v_vars jsonb;
  mid uuid;
  mentioned uuid;
  staff_name text;
begin
  if auth.uid() is null or not private.can_bookings(true) or not private.not_marketing() then
    raise exception 'not allowed';
  end if;
  select * into conv from public.conversations where id = p_conversation;
  if conv.id is null then raise exception 'conversation not found'; end if;
  select * into person from public.contacts where id = conv.contact_id;
  select full_name into staff_name from public.profiles where id = auth.uid();
  if coalesce(p_as_note, false) then
    v_body := nullif(btrim(coalesce(p_body, '')), '');
    if v_body is null then raise exception 'write a note first'; end if;
    if not private.inbox_copy_ok(v_body) then raise exception 'that wording is not used by the studio'; end if;
    insert into public.messages (contact_id, conversation_id, channel, direction, sender_type, sender_name, body, source, occurred_at, staff_id, created_by)
    values (conv.contact_id, conv.id, 'note', 'out', 'staff', coalesce(staff_name, 'Staff'), left(v_body, 4000), 'manual', now(), auth.uid(), auth.uid())
    returning id into mid;
    if p_mentions is not null then
      foreach mentioned in array p_mentions loop
        insert into public.message_mentions (message_id, staff_id) values (mid, mentioned)
        on conflict (message_id, staff_id) do nothing;
        -- TODO: notify this staff member. The mention is stored; delivery is not wired yet.
      end loop;
    end if;
    return mid;
  end if;
  if nullif(btrim(coalesce(p_template, '')), '') is not null then
    select * into tpl from public.message_templates where name = p_template and active;
    if tpl.id is null then raise exception 'template not found'; end if;
    v_vars := jsonb_build_object('first_name', coalesce(person.preferred_name, person.first_name, ''), 'last_name', coalesce(person.last_name, ''));
    v_body := private.fill_template(tpl.body, v_vars);
    insert into public.messages (
      contact_id, conversation_id, channel, direction, sender_type, sender_name, body, buttons, source, occurred_at, staff_id, created_by
    ) values (
      conv.contact_id, conv.id, conv.channel, 'out', 'staff', coalesce(staff_name, 'Staff'), left(v_body, 4000),
      coalesce(tpl.buttons, '[]'::jsonb), 'live', now(), auth.uid(), auth.uid()
    ) returning id into mid;
    perform private.queue_message(conv.contact_id, conv.id, null, 'manual_template', tpl.name, v_body, tpl.buttons, v_vars, now(), null, mid);
    return mid;
  end if;
  v_body := nullif(btrim(coalesce(p_body, '')), '');
  if v_body is null then raise exception 'write a message first'; end if;
  if not private.inbox_copy_ok(v_body) then raise exception 'that wording is not used by the studio'; end if;
  if conv.channel = 'whatsapp' then
    select max(occurred_at) into v_last from public.messages
    where conversation_id = conv.id and direction = 'in' and sender_type = 'customer' and channel = 'whatsapp';
    if v_last is null or v_last < now() - interval '24 hours' then
      raise exception 'The 24-hour window is closed. Send an approved template.';
    end if;
  end if;
  insert into public.messages (
    contact_id, conversation_id, channel, direction, sender_type, sender_name, body, source, occurred_at, staff_id, created_by
  ) values (
    conv.contact_id, conv.id, conv.channel, 'out', 'staff', coalesce(staff_name, 'Staff'), left(v_body, 4000), 'live', now(), auth.uid(), auth.uid()
  ) returning id into mid;
  perform private.queue_message(conv.contact_id, conv.id, null, 'staff_reply', null, v_body, '[]'::jsonb, '{}'::jsonb, now(), null, mid);
  return mid;
end;
$$;

-- ---------- access: bookings staff, not the marketing role, and not anon ----------
grant usage on schema private to authenticated;

revoke all on function private.inbox_copy_ok(text) from public;
revoke all on function private.ensure_conversation(uuid, text) from public, anon, authenticated;
revoke all on function private.fill_template(text, jsonb) from public;
revoke all on function private.kl_week_key(timestamptz) from public;
revoke all on function private.in_sabbath(timestamptz) from public;
revoke all on function private.sabbath_window_key(timestamptz) from public;
revoke all on function private.queue_message(uuid, uuid, uuid, text, text, text, jsonb, jsonb, timestamptz, text, uuid) from public, anon, authenticated;
revoke all on function private.capture_click_to_whatsapp(uuid, jsonb) from public, anon, authenticated;
revoke all on function private.maybe_auto_reply(public.messages) from public, anon, authenticated;
revoke all on function private.messages_before_conversation() from public;
revoke all on function private.messages_after_conversation() from public;
revoke all on function private.enqueue_booking_templates(uuid) from public, anon, authenticated;
revoke all on function private.trg_enqueue_booking_templates() from public;

grant execute on function private.messages_before_conversation() to anon, authenticated;
grant execute on function private.messages_after_conversation() to anon, authenticated;
grant execute on function private.trg_enqueue_booking_templates() to anon, authenticated;

revoke all on function public.automation_allowed(uuid) from public, anon;
grant execute on function public.automation_allowed(uuid) to authenticated;
revoke all on function public.fetch_due_outbound(int) from public, anon;
grant execute on function public.fetch_due_outbound(int) to authenticated;
revoke all on function public.send_conversation_message(uuid, text, text, boolean, uuid[]) from public, anon;
grant execute on function public.send_conversation_message(uuid, text, text, boolean, uuid[]) to authenticated;

alter table public.conversations enable row level security;
alter table public.saved_replies enable row level security;
alter table public.message_mentions enable row level security;
alter table public.message_templates enable row level security;
alter table public.outbound_queue enable row level security;
alter table public.inbox_settings enable row level security;

drop policy if exists conversations_read on public.conversations;
create policy conversations_read on public.conversations for select to authenticated
  using (private.can_bookings(false) and private.not_marketing());
drop policy if exists conversations_update on public.conversations;
create policy conversations_update on public.conversations for update to authenticated
  using (private.can_bookings(true) and private.not_marketing())
  with check (private.can_bookings(true) and private.not_marketing());

drop policy if exists saved_replies_read on public.saved_replies;
create policy saved_replies_read on public.saved_replies for select to authenticated
  using (private.can_bookings(false) and private.not_marketing());
drop policy if exists saved_replies_write on public.saved_replies;
create policy saved_replies_write on public.saved_replies for insert to authenticated
  with check (private.can_bookings(true) and private.not_marketing());
drop policy if exists saved_replies_update on public.saved_replies;
create policy saved_replies_update on public.saved_replies for update to authenticated
  using (private.can_bookings(true) and private.not_marketing())
  with check (private.can_bookings(true) and private.not_marketing());
drop policy if exists saved_replies_delete on public.saved_replies;
create policy saved_replies_delete on public.saved_replies for delete to authenticated
  using (private.can_bookings(true) and private.not_marketing());

drop policy if exists mentions_read on public.message_mentions;
create policy mentions_read on public.message_mentions for select to authenticated
  using (private.can_bookings(false) and private.not_marketing());

drop policy if exists templates_read on public.message_templates;
create policy templates_read on public.message_templates for select to authenticated
  using (private.can_bookings(false) and private.not_marketing());
drop policy if exists templates_write on public.message_templates;
create policy templates_write on public.message_templates for update to authenticated
  using (private.can_bookings(true) and private.not_marketing())
  with check (private.can_bookings(true) and private.not_marketing());

drop policy if exists queue_read on public.outbound_queue;
create policy queue_read on public.outbound_queue for select to authenticated
  using (private.can_bookings(false) and private.not_marketing());

drop policy if exists inbox_settings_read on public.inbox_settings;
create policy inbox_settings_read on public.inbox_settings for select to authenticated
  using (private.can_bookings(false) and private.not_marketing());
drop policy if exists inbox_settings_write on public.inbox_settings;
create policy inbox_settings_write on public.inbox_settings for update to authenticated
  using (private.can_bookings(true) and private.not_marketing())
  with check (private.can_bookings(true) and private.not_marketing());

revoke all on public.conversations from public, anon, authenticated;
grant select, update (assigned_to, status, unread_count) on public.conversations to authenticated;
revoke all on public.saved_replies from public, anon, authenticated;
grant select, insert, update, delete on public.saved_replies to authenticated;
revoke all on public.message_mentions from public, anon, authenticated;
grant select on public.message_mentions to authenticated;
revoke all on public.message_templates from public, anon, authenticated;
grant select, update on public.message_templates to authenticated;
revoke all on public.outbound_queue from public, anon, authenticated;
grant select on public.outbound_queue to authenticated;
revoke all on public.inbox_settings from public, anon, authenticated;
grant select, update (
  automation_pause_minutes, sabbath_start_dow, sabbath_start_time, sabbath_end_dow, sabbath_end_time,
  sabbath_reply, welcome_reply, welcome_buttons, updated_at
) on public.inbox_settings to authenticated;

-- Threads for messages that already exist. Unread stays 0 so old history is not a pile of badges.
insert into public.conversations (contact_id, channel, last_message_at, last_message_preview, last_direction, last_inbound_at, unread_count)
select distinct on (m.contact_id, m.channel)
  m.contact_id, m.channel, m.occurred_at, left(coalesce(m.body, ''), 140), m.direction,
  (select max(i.occurred_at) from public.messages i
    where i.contact_id = m.contact_id and i.channel = m.channel and i.direction = 'in' and i.sender_type = 'customer'),
  0
from public.messages m
order by m.contact_id, m.channel, m.occurred_at desc
on conflict (contact_id, channel) do nothing;

update public.messages m set conversation_id = c.id
from public.conversations c
where m.conversation_id is null and c.contact_id = m.contact_id and c.channel = m.channel;

commit;

select table_name, grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('conversations', 'outbound_queue', 'saved_replies', 'inbox_settings')
  and grantee in ('anon', 'authenticated')
group by table_name, grantee
order by table_name, grantee;
