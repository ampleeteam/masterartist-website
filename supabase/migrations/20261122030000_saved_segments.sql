-- Saved contact lists. A clause list, not free-form SQL.
-- Run after 20261122020000_staff_tasks.sql. Safe to run more than once.
-- Membership is computed. Nothing is copied out of messages or participant_health.

begin;

create table if not exists public.saved_segments (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  definition  jsonb not null default '{"clauses":[]}',
  owner       uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz,
  constraint saved_segments_name check (char_length(btrim(name)) between 1 and 80),
  constraint saved_segments_def check (jsonb_typeof(definition) = 'object')
);

comment on table public.saved_segments is
  'Reusable contact filters. definition.clauses is a list of {field, op, value}. Evaluated by segment_contacts.';

insert into public.saved_segments (name, definition)
select 'Opted in to WhatsApp', '{"clauses":[{"field":"whatsapp_opt_in","op":"eq","value":true}]}'::jsonb
where not exists (select 1 from public.saved_segments where name = 'Opted in to WhatsApp');
insert into public.saved_segments (name, definition)
select 'Parents', '{"clauses":[{"field":"has_child","op":"eq","value":true}]}'::jsonb
where not exists (select 1 from public.saved_segments where name = 'Parents');
insert into public.saved_segments (name, definition)
select 'Baking, no booking in 60 days',
  '{"clauses":[{"field":"formats_attended","op":"contains","value":"baking"},{"field":"days_since_last_booking","op":"gte","value":60}]}'::jsonb
where not exists (select 1 from public.saved_segments where name = 'Baking, no booking in 60 days');

create or replace function public.segment_contacts(p_segment uuid)
returns table (contact_id uuid)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  def jsonb;
  clause jsonb;
  sql text := 'select c.id from public.contacts c where true';
  fld text;
  op text;
  val text;
begin
  if auth.uid() is not null
     and not (private.can_section('customers', false) or private.can_bookings(false)) then
    return;
  end if;
  select definition into def from public.saved_segments where id = p_segment;
  if def is null then return; end if;
  for clause in select value from jsonb_array_elements(coalesce(def->'clauses', '[]'::jsonb)) loop
    fld := clause->>'field';
    op := clause->>'op';
    val := clause->>'value';
    if fld = 'whatsapp_opt_in' and val = 'true' then
      sql := sql || ' and c.whatsapp_consent and not c.unsubscribed and not c.do_not_contact';
    elsif fld = 'email_opt_in' and val = 'true' then
      sql := sql || ' and c.email_consent and not c.unsubscribed and not c.do_not_contact';
    elsif fld = 'has_child' and val = 'true' then
      sql := sql || ' and (jsonb_array_length(coalesce(c.children, ''[]''::jsonb)) > 0 or exists (select 1 from public.contact_guardians g where g.guardian_contact_id = c.id))';
    elsif fld = 'formats_attended' and op = 'contains' and val ~ '^[a-z0-9 &]{1,40}$' then
      sql := sql || format(' and %L = any(c.formats_attended)', val);
    elsif fld = 'interests' and op = 'contains' and val ~ '^[a-zA-Z0-9 &]{1,40}$' then
      sql := sql || format(' and %L = any(c.interests)', val);
    elsif fld = 'tags' and op = 'contains' and val ~ '^[a-zA-Z0-9 &-]{1,40}$' then
      sql := sql || format(' and %L = any(c.tags)', val);
    elsif fld = 'days_since_last_booking' and op = 'gte' and val ~ '^[0-9]{1,4}$' then
      sql := sql || format(' and c.last_booking_date is not null and c.last_booking_date <= current_date - %s', val);
    elsif fld = 'lifecycle_stage' and op = 'eq' and val ~ '^[a-z ]{1,40}$' then
      sql := sql || format(' and c.lifecycle_stage = %L', val);
    elsif fld = 'contact_type' and op = 'eq' and val ~ '^[a-z ]{1,40}$' then
      sql := sql || format(' and c.contact_type = %L', val);
    elsif fld = 'is_organiser' and val = 'true' then
      sql := sql || ' and c.is_organiser';
    elsif fld = 'birthday_enquiry' and val = 'true' then
      sql := sql || ' and c.birthday_enquiry';
    elsif fld = 'asked_price' and val = 'true' then
      sql := sql || ' and c.asked_price';
    end if;
  end loop;
  return query execute sql;
end;
$$;

comment on function public.segment_contacts(uuid) is
  'Contacts matching a saved list. Only whitelisted fields. Never reads message bodies or participant_health.';

revoke all on function public.segment_contacts(uuid) from public, anon;
grant execute on function public.segment_contacts(uuid) to authenticated;

-- Queue a WhatsApp template for an opted-in segment. Does not call the provider.
create or replace function public.queue_segment_whatsapp(p_segment uuid, p_template text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int := 0;
  r record;
  conv uuid;
  tpl public.message_templates%rowtype;
  v_body text;
begin
  if auth.uid() is null or not private.can_bookings(true) or not private.not_marketing() then
    raise exception 'not allowed';
  end if;
  select * into tpl from public.message_templates where name = p_template and active;
  if tpl.id is null then raise exception 'template not found'; end if;
  for r in
    select c.* from public.contacts c
    join public.segment_contacts(p_segment) s on s.contact_id = c.id
    where c.whatsapp_consent and not c.unsubscribed and not c.do_not_contact
      and coalesce(c.whatsapp_e164, c.phone_e164) is not null
  loop
    conv := private.ensure_conversation(r.id, 'whatsapp');
    v_body := private.fill_template(tpl.body, jsonb_build_object('first_name', coalesce(r.preferred_name, r.first_name, '')));
    perform private.queue_message(r.id, conv, null, 'manual_template', tpl.name, v_body, tpl.buttons,
      jsonb_build_object('first_name', coalesce(r.preferred_name, r.first_name, '')), now(), null);
    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke all on function public.queue_segment_whatsapp(uuid, text) from public, anon;
grant execute on function public.queue_segment_whatsapp(uuid, text) to authenticated;

alter table public.saved_segments enable row level security;
drop policy if exists saved_segments_read on public.saved_segments;
create policy saved_segments_read on public.saved_segments for select to authenticated
  using (private.can_section('customers', false) or private.can_bookings(false));
drop policy if exists saved_segments_write on public.saved_segments;
create policy saved_segments_write on public.saved_segments for insert to authenticated
  with check (private.can_section('customers', true) or private.can_bookings(true));
drop policy if exists saved_segments_update on public.saved_segments;
create policy saved_segments_update on public.saved_segments for update to authenticated
  using (private.can_section('customers', true) or private.can_bookings(true))
  with check (private.can_section('customers', true) or private.can_bookings(true));
drop policy if exists saved_segments_delete on public.saved_segments;
create policy saved_segments_delete on public.saved_segments for delete to authenticated
  using (private.can_section('customers', true) or private.can_bookings(true));

revoke all on public.saved_segments from public, anon, authenticated;
grant select, insert, update, delete on public.saved_segments to authenticated;

commit;
