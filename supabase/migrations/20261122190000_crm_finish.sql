-- Inbox finish: pause, reminders, files, knowledge, search, merge, PDPA.
-- Not applied. Safe to run more than once. Anon cannot read these tables.

begin;

alter table public.inbox_settings add column if not exists human_queue_only boolean not null default false;
alter table public.inbox_settings add column if not exists away_drafts boolean not null default false;

comment on column public.inbox_settings.human_queue_only is
  'When on, a bot-only chat stays out of the human queue until the customer asks for a person, a booking, or a price.';
comment on column public.inbox_settings.away_drafts is
  'Off by default. When on, Sabbath and after-hours replies are drafted for staff. They are never sent on their own.';
comment on column public.inbox_settings.automation_pause_minutes is
  'After a staff reply, automations wait this many minutes. Default 30.';

create table if not exists public.shared_files (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  path        text not null unique,
  kind        text not null default 'file',
  created_at  timestamptz not null default now(),
  constraint shared_files_title check (char_length(btrim(title)) between 1 and 80),
  constraint shared_files_kind check (kind in ('pdf', 'file', 'image'))
);

comment on table public.shared_files is
  'Timetable, price list and directions. The file bytes live in the private shared-files bucket.';

insert into storage.buckets (id, name, public)
values ('shared-files', 'shared-files', false)
on conflict (id) do nothing;

create table if not exists public.knowledge_articles (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  body       text not null,
  keywords   text,
  kind       text not null default 'faq',
  updated_at timestamptz not null default now(),
  constraint knowledge_articles_title check (char_length(btrim(title)) between 1 and 120),
  constraint knowledge_articles_kind check (kind in ('faq', 'schedule'))
);

create table if not exists public.knowledge_gaps (
  id          uuid primary key default gen_random_uuid(),
  question    text not null,
  conversation_id uuid,
  resolved    boolean not null default false,
  created_at  timestamptz not null default now(),
  constraint knowledge_gaps_q check (char_length(question) between 1 and 500)
);

comment on table public.knowledge_gaps is
  'A question the draft could not answer. Staff add it to knowledge. Nothing is sent.';

create table if not exists public.contact_merge_log (
  id          uuid primary key default gen_random_uuid(),
  kept_id     uuid not null,
  dropped_id  uuid not null,
  detail      jsonb not null default '{}',
  merged_by   uuid default auth.uid(),
  created_at  timestamptz not null default now()
);

create table if not exists public.data_requests (
  id          uuid primary key default gen_random_uuid(),
  contact_id  uuid not null,
  kind        text not null,
  status      text not null default 'open',
  created_at  timestamptz not null default now(),
  constraint data_requests_kind check (kind in ('export', 'delete')),
  constraint data_requests_status check (status in ('open', 'done'))
);

alter table public.conversations add column if not exists needs_human boolean not null default true;
alter table public.conversations add column if not exists bot_only boolean not null default false;
alter table public.conversations add column if not exists reminder_notified_at timestamptz;
alter table public.contacts add column if not exists opted_out_at timestamptz;

comment on column public.conversations.bot_only is
  'A bot is handling this chat. With human_queue_only on, it stays out of Unassigned and Assigned to me until needs_human is true.';
comment on column public.conversations.needs_human is
  'True after a handoff keyword, a booking or price question, or a question the knowledge draft could not answer.';

alter table public.messages add column if not exists search_vector tsvector
  generated always as (to_tsvector('simple', coalesce(body, ''))) stored;
create index if not exists messages_search_idx on public.messages using gin (search_vector);

create or replace function public.search_messages(p_query text)
returns table (message_id uuid, conversation_id uuid, contact_id uuid, body text, occurred_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select m.id, m.conversation_id, m.contact_id, left(m.body, 180), m.occurred_at
  from public.messages m
  where private.can_bookings(false)
    and private.not_marketing()
    and m.search_vector @@ plainto_tsquery('simple', left(coalesce(p_query, ''), 80))
  order by m.occurred_at desc
  limit 30;
$$;

revoke all on function public.search_messages(text) from public, anon;
grant execute on function public.search_messages(text) to authenticated;

create or replace function private.fill_template(p_body text, p_vars jsonb)
returns text
language sql
immutable
as $$
  select replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(coalesce(p_body, ''),
    '{first_name}', coalesce(p_vars->>'first_name', '')),
    '{last_name}', coalesce(p_vars->>'last_name', '')),
    '{child_name}', coalesce(p_vars->>'child_name', '')),
    '{workshop}', coalesce(p_vars->>'workshop', p_vars->>'next_workshop', '')),
    '{next_workshop}', coalesce(p_vars->>'next_workshop', p_vars->>'workshop', '')),
    '{date}', coalesce(p_vars->>'date', p_vars->>'workshop_date', '')),
    '{workshop_date}', coalesce(p_vars->>'workshop_date', p_vars->>'date', '')),
    '{price}', coalesce(p_vars->>'price', '')),
    '{seats_left}', coalesce(p_vars->>'seats_left', '')),
    '{booking_link}', coalesce(p_vars->>'booking_link', '')),
    '{link}', coalesce(p_vars->>'booking_link', ''));
$$;

create table if not exists public.enrolment_events (
  id           uuid primary key default gen_random_uuid(),
  enrolment_id uuid references public.event_enrolments(id) on delete cascade,
  contact_id   uuid,
  session_id   text,
  event        text not null,
  detail       text,
  created_at   timestamptz not null default now(),
  constraint enrolment_events_kind check (event in ('link_sent'))
);

comment on table public.enrolment_events is
  'Staff actions on an enrolment. link_sent is the booking card, not a payment.';

create or replace function public.log_link_sent(p_contact uuid, p_session text, p_detail text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare enrol uuid;
begin
  if auth.uid() is null or not private.can_bookings(false) or not private.not_marketing() then
    raise exception 'not allowed';
  end if;
  select id into enrol from public.event_enrolments
  where contact_id = p_contact and session_id = p_session
  limit 1;
  insert into public.enrolment_events (enrolment_id, contact_id, session_id, event, detail)
  values (enrol, p_contact, p_session, 'link_sent', left(coalesce(p_detail, ''), 300));
end;
$$;

revoke all on function public.log_link_sent(uuid, text, text) from public, anon;
grant execute on function public.log_link_sent(uuid, text, text) to authenticated;

create or replace function public.claim_due_reminders()
returns table (conversation_id uuid, title text)
language plpgsql
security definer
set search_path = public
as $$
declare row record;
begin
  if auth.uid() is null or not private.can_bookings(false) or not private.not_marketing() then
    return;
  end if;
  for row in
    select c.id, c.assigned_to, left(coalesce(c.last_message_preview, 'Reminder'), 120) as title
    from public.conversations c
    where c.snoozed_until is not null
      and c.snoozed_until <= now()
      and c.reminder_notified_at is null
      and (c.assigned_to is null or c.assigned_to = auth.uid())
  loop
    update public.conversations set reminder_notified_at = now() where id = row.id;
    if row.assigned_to is not null then
      insert into public.staff_notifications (staff_id, title)
      values (row.assigned_to, 'Reminder: ' || row.title);
    end if;
    conversation_id := row.id;
    title := row.title;
    return next;
  end loop;
end;
$$;

revoke all on function public.claim_due_reminders() from public, anon;
grant execute on function public.claim_due_reminders() to authenticated;

create or replace function private.mention_notice()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.staff_notifications (staff_id, title)
  values (new.staff_id, 'You were mentioned in a note');
  return new;
end;
$$;

drop trigger if exists mention_notice on public.message_mentions;
create trigger mention_notice after insert on public.message_mentions
  for each row execute function private.mention_notice();

create or replace view public.inbox_agent_stats
with (security_invoker = true) as
select c.assigned_to,
  count(*)::int as chats,
  count(*) filter (where c.status = 'closed')::int as resolved,
  round(avg(extract(epoch from (first_out.occurred_at - c.created_at))) / 60)::int as first_response_minutes,
  round(avg(extract(epoch from (c.updated_at - c.created_at))) filter (where c.status = 'closed') / 60)::int as resolution_minutes
from public.conversations c
left join lateral (
  select min(m.occurred_at) as occurred_at
  from public.messages m
  where m.conversation_id = c.id and m.direction = 'out' and m.sender_type = 'staff' and m.channel <> 'note'
) first_out on true
group by c.assigned_to;

comment on view public.inbox_agent_stats is
  'First response and resolution, per assignee. Message text is not in this view. Marketing cannot read messages, so the averages stay empty for that role.';

revoke all on public.inbox_agent_stats from anon, public;
grant select on public.inbox_agent_stats to authenticated;

create or replace function public.merge_contacts(p_keep uuid, p_drop uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not private.can_bookings(true) or not private.not_marketing() then
    raise exception 'not allowed';
  end if;
  if p_keep is null or p_drop is null or p_keep = p_drop then
    raise exception 'choose two different people';
  end if;
  update public.messages m
  set conversation_id = k.id
  from public.conversations d
  join public.conversations k on k.contact_id = p_keep and k.channel = d.channel
  where m.conversation_id = d.id and d.contact_id = p_drop;
  delete from public.conversations d
  using public.conversations k
  where d.contact_id = p_drop and k.contact_id = p_keep and k.channel = d.channel;
  update public.conversations set contact_id = p_keep where contact_id = p_drop;
  update public.messages set contact_id = p_keep where contact_id = p_drop;
  delete from public.event_enrolments e
  using public.event_enrolments k
  where e.contact_id = p_drop and k.contact_id = p_keep and k.session_id = e.session_id;
  update public.event_enrolments set contact_id = p_keep where contact_id = p_drop;
  update public.group_deals set contact_id = p_keep where contact_id = p_drop;
  update public.workshop_bookings set contact_id = p_keep where contact_id = p_drop;
  update public.workshop_bookings set booker_contact_id = p_keep where booker_contact_id = p_drop;
  update public.contacts k set tags = (
    select array(select distinct unnest(coalesce(k.tags, '{}') || coalesce(d.tags, '{}')))
    from public.contacts d where d.id = p_drop
  ) where k.id = p_keep;
  insert into public.contact_merge_log (kept_id, dropped_id, detail)
  values (p_keep, p_drop, jsonb_build_object('dropped', p_drop));
  delete from public.contacts where id = p_drop;
end;
$$;

revoke all on function public.merge_contacts(uuid, uuid) from public, anon;
grant execute on function public.merge_contacts(uuid, uuid) to authenticated;

alter table public.shared_files enable row level security;
alter table public.knowledge_articles enable row level security;
alter table public.knowledge_gaps enable row level security;
alter table public.contact_merge_log enable row level security;
alter table public.data_requests enable row level security;

drop policy if exists shared_files_read on public.shared_files;
create policy shared_files_read on public.shared_files for select to authenticated
  using (private.can_bookings(false) and private.not_marketing());
drop policy if exists shared_files_write on public.shared_files;
create policy shared_files_write on public.shared_files for all to authenticated
  using (private.can_bookings(true)) with check (private.can_bookings(true));

drop policy if exists knowledge_read on public.knowledge_articles;
create policy knowledge_read on public.knowledge_articles for select to authenticated
  using (private.can_bookings(false) or private.can_section('customers', false));
drop policy if exists knowledge_write on public.knowledge_articles;
create policy knowledge_write on public.knowledge_articles for all to authenticated
  using (private.can_bookings(true)) with check (private.can_bookings(true));

drop policy if exists gaps_read on public.knowledge_gaps;
create policy gaps_read on public.knowledge_gaps for select to authenticated
  using (private.can_bookings(false) and private.not_marketing());
drop policy if exists gaps_write on public.knowledge_gaps;
create policy gaps_write on public.knowledge_gaps for insert to authenticated
  with check (private.can_bookings(false) and private.not_marketing());

drop policy if exists merge_log_read on public.contact_merge_log;
create policy merge_log_read on public.contact_merge_log for select to authenticated
  using (private.can_bookings(false) and private.not_marketing());

drop policy if exists data_requests_staff on public.data_requests;
create policy data_requests_staff on public.data_requests for all to authenticated
  using (private.can_bookings(true) and private.not_marketing())
  with check (private.can_bookings(true) and private.not_marketing());

alter table public.enrolment_events enable row level security;
drop policy if exists enrolment_events_staff on public.enrolment_events;
create policy enrolment_events_staff on public.enrolment_events for all to authenticated
  using (private.can_bookings(false) and private.not_marketing())
  with check (private.can_bookings(false) and private.not_marketing());

insert into public.knowledge_articles (title, body, keywords, kind)
select * from (values
  ('Prices', 'Each workshop page shows the all-in price. Materials are included.', 'price cost how much', 'faq'),
  ('Location', 'The studio is in Kuala Lumpur. The pin is on the workshop page.', 'where location address', 'faq'),
  ('Parking', 'There is street parking near the studio. Come a few minutes early.', 'parking car', 'faq'),
  ('Ages', 'The workshop page lists who the session is for, including children''s classes.', 'age child kid', 'faq'),
  ('What to bring', 'An apron is at the studio. Wear clothes you can work in.', 'bring wear apron', 'faq'),
  ('Refunds', 'A paid seat can move to another date when that session has space.', 'refund cancel move', 'faq')
) as seed(title, body, keywords, kind)
where not exists (select 1 from public.knowledge_articles);

drop policy if exists shared_files_objects_read on storage.objects;
create policy shared_files_objects_read on storage.objects for select to authenticated
  using (bucket_id = 'shared-files' and private.can_bookings(false) and private.not_marketing());
drop policy if exists shared_files_objects_write on storage.objects;
create policy shared_files_objects_write on storage.objects for insert to authenticated
  with check (bucket_id = 'shared-files' and private.can_bookings(true));

revoke all on public.shared_files, public.knowledge_articles, public.knowledge_gaps, public.contact_merge_log, public.data_requests, public.enrolment_events from anon, public;
grant select, insert, update, delete on public.shared_files to authenticated;
grant select, insert, update, delete on public.knowledge_articles to authenticated;
grant select, insert, update on public.knowledge_gaps to authenticated;
grant select on public.contact_merge_log to authenticated;
grant select, insert, update on public.data_requests to authenticated;
grant select, insert on public.enrolment_events to authenticated;

create or replace function private.flag_needs_human()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.direction = 'in' and new.sender_type = 'customer' and new.conversation_id is not null
     and coalesce(new.body, '') ~* '\m(human|staff|person|manager|complaint|refund|book|enrol|price|how much)\M' then
    update public.conversations set needs_human = true where id = new.conversation_id;
  end if;
  return new;
end;
$$;

drop trigger if exists messages_flag_human on public.messages;
create trigger messages_flag_human after insert on public.messages
  for each row execute function private.flag_needs_human();

create or replace function public.refresh_knowledge_schedule()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare body text;
begin
  if auth.uid() is not null and not private.can_bookings(true) then
    raise exception 'not allowed';
  end if;
  select string_agg(title || ' · ' || to_char(starts_at at time zone 'Asia/Kuala_Lumpur', 'DD Mon HH24:MI'), E'\n' order by starts_at)
  into body
  from public.workshop_sessions
  where starts_at > now() - interval '1 day';
  delete from public.knowledge_articles where kind = 'schedule';
  insert into public.knowledge_articles (title, body, keywords, kind)
  values ('Workshop schedule', coalesce(body, 'No upcoming sessions yet.'), 'schedule workshop date', 'schedule');
end;
$$;

revoke all on function public.refresh_knowledge_schedule() from public, anon;
grant execute on function public.refresh_knowledge_schedule() to authenticated;

select public.refresh_knowledge_schedule();

-- Sabbath and after-hours replies stay a staff draft when away_drafts is on.
-- The toggle defaults off, so the existing queue behaviour is unchanged until David turns it on.
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
    v_body := private.fill_template(settings.sabbath_reply, v_vars);
    if settings.away_drafts then
      insert into public.messages (contact_id, conversation_id, channel, direction, sender_type, sender_name, body, source, occurred_at)
      values (person.id, conv.id, 'note', 'out', 'staff', 'Away draft', left('Away draft: ' || coalesce(v_body, ''), 4000), 'manual', p_message.occurred_at);
      update public.conversations set sabbath_replied_window = v_key where id = conv.id;
      return;
    end if;
    v_buttons := case when conv.welcome_sent_at is null then settings.welcome_buttons else '[]'::jsonb end;
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

commit;
