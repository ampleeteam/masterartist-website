-- Email campaigns and flows through Resend. Schema and queue only.
-- Run after 20261122040000_group_deals.sql. Safe to run more than once.
-- No message is sent by this file. The sender refuses to run until RESEND_API_KEY
-- and EMAIL_SEND_ENABLED are set, which they are not.

begin;

create table if not exists public.email_settings (
  id               int primary key default 1,
  from_address     text not null default 'Master Artist <news@masterartist.co>',
  postal_address   text not null default '38-2, Jalan 28/70A, Desa Sri Hartamas, 50480 Kuala Lumpur',
  batch_size       int not null default 100,
  max_per_minute   int not null default 60,
  constraint email_settings_one check (id = 1),
  constraint email_settings_batch check (batch_size between 1 and 100),
  constraint email_settings_rate check (max_per_minute between 1 and 600)
);

insert into public.email_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.email_templates (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  subject     text not null,
  preheader   text,
  body_html   text not null,
  body_text   text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz,
  constraint email_templates_name check (name ~ '^[a-z0-9-]{2,60}$'),
  constraint email_templates_subject check (char_length(subject) between 1 and 160 and private.inbox_copy_ok(subject)),
  constraint email_templates_html check (char_length(body_html) between 1 and 20000 and private.inbox_copy_ok(body_html))
);

insert into public.email_templates (name, subject, preheader, body_html, body_text)
select v.name, v.subject, v.preheader, v.body_html, v.body_text
from (values
  ('welcome', 'Welcome to Master Artist', 'Workshops, classes and what to try first',
   '<p>Hello {first_name},</p><p>Welcome. Tell us what you would like to try and we will write back with the next session.</p><p><a href="{unsubscribe_url}">Email preferences</a></p>',
   'Hello {first_name}, welcome to Master Artist. Email preferences: {unsubscribe_url}'),
  ('before-workshop', 'See you at {workshop}', 'What to know before you arrive',
   '<p>Hello {first_name},</p><p>You are booked for {workshop} on {date}. Arrive a few minutes early. Materials are ready.</p><p><a href="{unsubscribe_url}">Email preferences</a></p>',
   'Hello {first_name}, you are booked for {workshop} on {date}. Email preferences: {unsubscribe_url}'),
  ('after-workshop', 'Thank you for coming', 'We hope you enjoyed {workshop}',
   '<p>Hello {first_name},</p><p>Thank you for coming to {workshop}. We hope you enjoyed it.</p><p><a href="{unsubscribe_url}">Email preferences</a></p>',
   'Hello {first_name}, thank you for coming to {workshop}. Email preferences: {unsubscribe_url}'),
  ('review-request', 'How was {workshop}?', 'A short note helps other families',
   '<p>Hello {first_name},</p><p>If you have a minute, tell us how {workshop} went. A Google review helps another family decide.</p><p><a href="{unsubscribe_url}">Email preferences</a></p>',
   'Hello {first_name}, how was {workshop}? Email preferences: {unsubscribe_url}'),
  ('win-back-45', 'It has been a while', 'Sunday workshops are open',
   '<p>Hello {first_name},</p><p>It has been a while since your last workshop. The next dates are on the website whenever you would like to come back.</p><p><a href="{unsubscribe_url}">Email preferences</a></p>',
   'Hello {first_name}, it has been a while. Email preferences: {unsubscribe_url}'),
  ('birthday-offer', 'A birthday coming up', 'A workshop makes a good party',
   '<p>Hello {first_name},</p><p>A birthday is coming up in your family. If you would like a small workshop for it, reply to this email and we will send times.</p><p><a href="{unsubscribe_url}">Email preferences</a></p>',
   'Hello {first_name}, a birthday is coming up. Email preferences: {unsubscribe_url}')
) as v(name, subject, preheader, body_html, body_text)
where not exists (select 1 from public.email_templates t where t.name = v.name);

create table if not exists public.email_campaigns (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  slug          text not null unique,
  segment_id    uuid references public.saved_segments(id) on delete set null,
  template_id   uuid references public.email_templates(id) on delete set null,
  status        text not null default 'draft',
  scheduled_at  timestamptz,
  sent_at       timestamptz,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  constraint email_campaigns_name check (char_length(btrim(name)) between 1 and 120),
  constraint email_campaigns_slug check (slug ~ '^[a-z0-9-]{2,60}$'),
  constraint email_campaigns_status check (status in ('draft', 'scheduled', 'sending', 'sent', 'cancelled'))
);

create table if not exists public.email_flows (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  trigger     text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  constraint email_flows_trigger check (trigger in ('new_lead', 'booking_confirmed', 'post_workshop', 'review_request', 'winback_45', 'child_birthday'))
);

create table if not exists public.email_flow_steps (
  id           uuid primary key default gen_random_uuid(),
  flow_id      uuid not null references public.email_flows(id) on delete cascade,
  step_order   int not null,
  delay_days   int not null default 0,
  template_id  uuid references public.email_templates(id) on delete set null,
  unique (flow_id, step_order),
  constraint email_flow_steps_delay check (delay_days between 0 and 365)
);

create table if not exists public.email_flow_enrollments (
  id            uuid primary key default gen_random_uuid(),
  flow_id       uuid not null references public.email_flows(id) on delete cascade,
  contact_id    uuid not null references public.contacts(id) on delete cascade,
  status        text not null default 'active',
  next_step     int not null default 1,
  next_step_at  timestamptz,
  created_at    timestamptz not null default now(),
  unique (flow_id, contact_id),
  constraint email_flow_enrollments_status check (status in ('active', 'done', 'stopped'))
);

create table if not exists public.email_suppressions (
  id          uuid primary key default gen_random_uuid(),
  email       text not null unique,
  reason      text not null,
  created_at  timestamptz not null default now(),
  constraint email_suppressions_reason check (reason in ('bounce', 'complaint', 'unsubscribe', 'do_not_contact', 'manual')),
  constraint email_suppressions_email check (email = lower(email) and char_length(email) <= 320)
);

create table if not exists public.email_queue (
  id              uuid primary key default gen_random_uuid(),
  contact_id      uuid references public.contacts(id) on delete cascade,
  campaign_id     uuid references public.email_campaigns(id) on delete set null,
  flow_id         uuid references public.email_flows(id) on delete set null,
  template_id     uuid references public.email_templates(id) on delete set null,
  to_email        text,
  subject         text,
  variables       jsonb not null default '{}',
  scheduled_at    timestamptz not null default now(),
  status          text not null default 'queued',
  skip_reason     text,
  resend_id       text,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz,
  constraint email_queue_status check (status in ('queued', 'sent', 'failed', 'skipped', 'suppressed')),
  constraint email_queue_vars check (jsonb_typeof(variables) = 'object')
);

create index if not exists email_queue_due_idx on public.email_queue (scheduled_at) where status = 'queued';

comment on table public.email_queue is
  'Same idea as outbound_queue, for email only. The sender does nothing until Resend DNS and EMAIL_SEND_ENABLED are set.';

create table if not exists public.email_events (
  id           uuid primary key default gen_random_uuid(),
  contact_id   uuid references public.contacts(id) on delete cascade,
  campaign_id  uuid references public.email_campaigns(id) on delete set null,
  queue_id     uuid references public.email_queue(id) on delete set null,
  kind         text not null,
  url          text,
  occurred_at  timestamptz not null default now(),
  constraint email_events_kind check (kind in ('delivered', 'opened', 'clicked', 'bounced', 'unsubscribed', 'complained')),
  constraint email_events_url check (url is null or char_length(url) <= 500)
);

create index if not exists email_events_contact_idx on public.email_events (contact_id, occurred_at desc);

comment on table public.email_events is
  'Resend events for the customer timeline: delivered, opened, clicked, bounced, unsubscribed, complained. Not WhatsApp text.';

-- Seed the six flows with one step each. Review request is a second step on the after-workshop flow.
insert into public.email_flows (name, trigger)
select v.name, v.trigger from (values
  ('Welcome series', 'new_lead'),
  ('Before the workshop', 'booking_confirmed'),
  ('After the workshop', 'post_workshop'),
  ('45-day win-back', 'winback_45'),
  ('Birthday offer', 'child_birthday')
) as v(name, trigger)
where not exists (select 1 from public.email_flows f where f.trigger = v.trigger);

insert into public.email_flow_steps (flow_id, step_order, delay_days, template_id)
select f.id, 1, 0, t.id
from public.email_flows f
join public.email_templates t on t.name = case f.trigger
  when 'new_lead' then 'welcome'
  when 'booking_confirmed' then 'before-workshop'
  when 'post_workshop' then 'after-workshop'
  when 'winback_45' then 'win-back-45'
  when 'child_birthday' then 'birthday-offer'
end
where not exists (select 1 from public.email_flow_steps s where s.flow_id = f.id and s.step_order = 1);

insert into public.email_flow_steps (flow_id, step_order, delay_days, template_id)
select f.id, 2, 2, t.id
from public.email_flows f
join public.email_templates t on t.name = 'review-request'
where f.trigger = 'post_workshop'
  and not exists (select 1 from public.email_flow_steps s where s.flow_id = f.id and s.step_order = 2);

create or replace function private.email_allowed(p_contact uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare c public.contacts%rowtype;
begin
  select * into c from public.contacts where id = p_contact;
  if c.id is null or c.email is null then return 'no email'; end if;
  if not c.email_consent then return 'no consent'; end if;
  if c.unsubscribed then return 'unsubscribed'; end if;
  if c.do_not_contact then return 'do not contact'; end if;
  if exists (select 1 from public.email_suppressions s where s.email = lower(c.email)) then return 'suppressed'; end if;
  return null;
end;
$$;

create or replace function public.enqueue_email_campaign(p_campaign uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  camp public.email_campaigns%rowtype;
  tpl public.email_templates%rowtype;
  r record;
  n int := 0;
  why text;
  when_at timestamptz;
begin
  if auth.uid() is null or not (
    private.can_section('email', true) or private.can_section('customers', true)
  ) then
    raise exception 'not allowed';
  end if;
  select * into camp from public.email_campaigns where id = p_campaign;
  if camp.id is null or camp.segment_id is null or camp.template_id is null then
    raise exception 'campaign needs a list and a template';
  end if;
  select * into tpl from public.email_templates where id = camp.template_id;
  when_at := coalesce(camp.scheduled_at, now());
  for r in select * from public.segment_contacts(camp.segment_id) loop
    why := private.email_allowed(r.contact_id);
    insert into public.email_queue (contact_id, campaign_id, template_id, to_email, subject, variables, scheduled_at, status, skip_reason)
    select c.id, camp.id, tpl.id, lower(c.email), tpl.subject,
      jsonb_build_object('first_name', coalesce(c.preferred_name, c.first_name, ''), 'unsubscribe_url',
        'https://masterartist.co/email/preferences/?token=' || c.email_token::text),
      when_at,
      case when why is null then 'queued' else 'skipped' end,
      why
    from public.contacts c where c.id = r.contact_id;
    n := n + 1;
  end loop;
  update public.email_campaigns set status = 'scheduled', scheduled_at = when_at where id = camp.id and status = 'draft';
  return n;
end;
$$;

comment on function public.enqueue_email_campaign(uuid) is
  'Fills email_queue from a saved list. Opted-in addresses only. Does not call Resend.';

create or replace function public.enroll_email_flow(p_trigger text, p_contact uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare f public.email_flows%rowtype;
begin
  if private.email_allowed(p_contact) is not null then return; end if;
  select * into f from public.email_flows where trigger = p_trigger and active limit 1;
  if f.id is null then return; end if;
  insert into public.email_flow_enrollments (flow_id, contact_id, next_step, next_step_at)
  values (f.id, p_contact, 1, now())
  on conflict (flow_id, contact_id) do nothing;
end;
$$;

create or replace function public.queue_due_flow_steps()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare e record; step public.email_flow_steps%rowtype; why text; n int := 0;
begin
  for e in
    select * from public.email_flow_enrollments
    where status = 'active' and next_step_at <= now()
  loop
    select * into step from public.email_flow_steps where flow_id = e.flow_id and step_order = e.next_step;
    if step.id is null then
      update public.email_flow_enrollments set status = 'done' where id = e.id;
      continue;
    end if;
    why := private.email_allowed(e.contact_id);
    insert into public.email_queue (contact_id, flow_id, template_id, to_email, subject, variables, scheduled_at, status, skip_reason)
    select c.id, e.flow_id, step.template_id, lower(c.email), t.subject,
      jsonb_build_object('first_name', coalesce(c.preferred_name, c.first_name, ''), 'unsubscribe_url',
        'https://masterartist.co/email/preferences/?token=' || c.email_token::text),
      now(), case when why is null then 'queued' else 'skipped' end, why
    from public.contacts c
    left join public.email_templates t on t.id = step.template_id
    where c.id = e.contact_id;
    update public.email_flow_enrollments set
      next_step = e.next_step + 1,
      next_step_at = now() + make_interval(days => coalesce((
        select s.delay_days from public.email_flow_steps s where s.flow_id = e.flow_id and s.step_order = e.next_step + 1
      ), 0))
    where id = e.id;
    n := n + 1;
  end loop;
  return n;
end;
$$;

create or replace function public.fetch_due_email(p_limit int default 100)
returns setof public.email_queue
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and not (
    private.can_section('email', false) or private.can_section('customers', false)
  ) then
    return;
  end if;
  return query
  select q.* from public.email_queue q
  where q.status = 'queued' and q.scheduled_at <= now()
  order by q.scheduled_at
  limit least(greatest(coalesce(p_limit, 100), 1), 100);
end;
$$;

create or replace function public.email_preferences(p_token uuid, p_action text, p_on boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare c public.contacts%rowtype;
begin
  if p_token is null then return jsonb_build_object('ok', false); end if;
  select * into c from public.contacts where email_token = p_token;
  if c.id is null then return jsonb_build_object('ok', false); end if;
  if p_action = 'unsubscribe' or (p_action = 'save' and p_on is false) then
    update public.contacts set email_consent = false, unsubscribed = true, unsubscribed_at = coalesce(unsubscribed_at, now())
    where id = c.id;
    insert into public.email_suppressions (email, reason)
    values (lower(c.email), 'unsubscribe')
    on conflict (email) do nothing;
  elsif p_action = 'save' and p_on is true then
    update public.contacts set email_consent = true, unsubscribed = false where id = c.id;
    delete from public.email_suppressions where email = lower(c.email) and reason = 'unsubscribe';
  end if;
  select * into c from public.contacts where id = c.id;
  return jsonb_build_object('ok', true, 'email_consent', c.email_consent, 'unsubscribed', c.unsubscribed);
end;
$$;

comment on function public.email_preferences(uuid, text, boolean) is
  'Public preferences page. The token is the only key. Returns consent flags, never messages or medical notes.';

create or replace function public.record_email_event(p_resend_id text, p_kind text, p_url text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare q public.email_queue%rowtype;
begin
  select * into q from public.email_queue where resend_id = p_resend_id limit 1;
  if q.id is null then return; end if;
  insert into public.email_events (contact_id, campaign_id, queue_id, kind, url)
  values (q.contact_id, q.campaign_id, q.id, p_kind, left(p_url, 500));
  if p_kind = 'bounced' then
    update public.email_queue set status = 'suppressed', skip_reason = 'bounce' where id = q.id;
    insert into public.email_suppressions (email, reason) values (lower(q.to_email), 'bounce') on conflict (email) do nothing;
    update public.contacts set unsubscribed = true, unsubscribed_at = coalesce(unsubscribed_at, now()) where id = q.contact_id;
  elsif p_kind = 'complained' then
    update public.email_queue set status = 'suppressed', skip_reason = 'complaint' where id = q.id;
    insert into public.email_suppressions (email, reason) values (lower(q.to_email), 'complaint') on conflict (email) do nothing;
    update public.contacts set do_not_contact = true, unsubscribed = true, unsubscribed_at = coalesce(unsubscribed_at, now()) where id = q.contact_id;
  elsif p_kind = 'unsubscribed' then
    perform public.email_preferences((select email_token from public.contacts where id = q.contact_id), 'unsubscribe', false);
  end if;
end;
$$;

revoke all on function private.email_allowed(uuid) from public, anon, authenticated;
revoke all on function public.enqueue_email_campaign(uuid) from public, anon;
grant execute on function public.enqueue_email_campaign(uuid) to authenticated;
revoke all on function public.enroll_email_flow(text, uuid) from public, anon;
grant execute on function public.enroll_email_flow(text, uuid) to authenticated;
revoke all on function public.queue_due_flow_steps() from public, anon;
grant execute on function public.queue_due_flow_steps() to authenticated;
revoke all on function public.fetch_due_email(int) from public, anon;
grant execute on function public.fetch_due_email(int) to authenticated;
revoke all on function public.email_preferences(uuid, text, boolean) from public;
grant execute on function public.email_preferences(uuid, text, boolean) to anon, authenticated;
revoke all on function public.record_email_event(text, text, text) from public, anon, authenticated;

create or replace view public.email_campaign_revenue
with (security_invoker = true) as
select camp.id as campaign_id, camp.name, camp.slug,
  count(distinct b.id) filter (where b.status = 'paid')::int as paid_bookings,
  coalesce(sum(b.amount) filter (where b.status = 'paid'), 0)::int as revenue_rm
from public.email_campaigns camp
left join public.workshop_bookings b on b.utm_campaign = camp.slug
group by camp.id, camp.name, camp.slug;

comment on view public.email_campaign_revenue is
  'Paid workshop revenue whose utm_campaign matches the email campaign slug. Bookings already store UTM fields.';

alter table public.email_templates enable row level security;
alter table public.email_campaigns enable row level security;
alter table public.email_flows enable row level security;
alter table public.email_flow_steps enable row level security;
alter table public.email_flow_enrollments enable row level security;
alter table public.email_suppressions enable row level security;
alter table public.email_queue enable row level security;
alter table public.email_events enable row level security;
alter table public.email_settings enable row level security;

drop policy if exists email_templates_all on public.email_templates;
create policy email_templates_all on public.email_templates for all to authenticated
  using (private.can_section('email', false) or private.can_section('customers', false))
  with check (private.can_section('email', true) or private.can_section('customers', true));
drop policy if exists email_campaigns_all on public.email_campaigns;
create policy email_campaigns_all on public.email_campaigns for all to authenticated
  using (private.can_section('email', false) or private.can_section('customers', false))
  with check (private.can_section('email', true) or private.can_section('customers', true));
drop policy if exists email_flows_read on public.email_flows;
create policy email_flows_read on public.email_flows for select to authenticated
  using (private.can_section('email', false) or private.can_section('customers', false));
drop policy if exists email_flow_steps_read on public.email_flow_steps;
create policy email_flow_steps_read on public.email_flow_steps for select to authenticated
  using (private.can_section('email', false) or private.can_section('customers', false));
drop policy if exists email_enroll_read on public.email_flow_enrollments;
create policy email_enroll_read on public.email_flow_enrollments for select to authenticated
  using (private.can_section('email', false) or private.can_section('customers', false));
drop policy if exists email_suppress_all on public.email_suppressions;
create policy email_suppress_all on public.email_suppressions for all to authenticated
  using (private.can_section('email', false) or private.can_section('customers', false))
  with check (private.can_section('email', true) or private.can_section('customers', true));
drop policy if exists email_queue_read on public.email_queue;
create policy email_queue_read on public.email_queue for select to authenticated
  using (private.can_section('email', false) or private.can_section('customers', false));
drop policy if exists email_events_read on public.email_events;
create policy email_events_read on public.email_events for select to authenticated
  using (private.can_section('email', false) or private.can_section('customers', false) or private.can_bookings(false));
drop policy if exists email_settings_read on public.email_settings;
create policy email_settings_read on public.email_settings for select to authenticated
  using (private.can_section('email', false) or private.can_section('customers', false));

revoke all on public.email_templates from public, anon, authenticated;
grant select, insert, update, delete on public.email_templates to authenticated;
revoke all on public.email_campaigns from public, anon, authenticated;
grant select, insert, update, delete on public.email_campaigns to authenticated;
revoke all on public.email_flows from public, anon, authenticated;
grant select on public.email_flows to authenticated;
revoke all on public.email_flow_steps from public, anon, authenticated;
grant select on public.email_flow_steps to authenticated;
revoke all on public.email_flow_enrollments from public, anon, authenticated;
grant select on public.email_flow_enrollments to authenticated;
revoke all on public.email_suppressions from public, anon, authenticated;
grant select, insert, delete on public.email_suppressions to authenticated;
revoke all on public.email_queue from public, anon, authenticated;
grant select on public.email_queue to authenticated;
revoke all on public.email_events from public, anon, authenticated;
grant select on public.email_events to authenticated;
revoke all on public.email_settings from public, anon, authenticated;
grant select on public.email_settings to authenticated;
revoke all on public.email_campaign_revenue from public, anon, authenticated;
grant select on public.email_campaign_revenue to authenticated;

insert into public.role_permissions (role, section, can_read, can_write)
select r::user_role, 'email', true, true
from unnest(array['admin', 'marketing']) as r
where not exists (
  select 1 from public.role_permissions p where p.role = r::user_role and p.section = 'email'
);

commit;
