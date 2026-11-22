-- Channel identities and an explainable lead score.
-- Run after 20261121103000_shared_inbox.sql. Safe to run more than once.
-- Adds rows and columns only. Does not rewrite or delete customers.
-- Instagram and Facebook identities can be stored later. Nothing here talks to Meta.

begin;

alter table public.contacts add column if not exists asked_price boolean not null default false;
alter table public.contacts add column if not exists email_token uuid;
create unique index if not exists contacts_email_token_key on public.contacts (email_token) where email_token is not null;
update public.contacts set email_token = gen_random_uuid() where email_token is null;

comment on column public.contacts.asked_price is 'Staff tick, or a later private keyword flag. The score says asked_price. It does not store the message.';
comment on column public.contacts.email_token is 'Secret token for the public email preferences page. Not a login.';

create table if not exists public.contact_identities (
  id           uuid primary key default gen_random_uuid(),
  contact_id   uuid not null references public.contacts(id) on delete cascade,
  channel      text not null,
  external_id  text not null,
  is_primary   boolean not null default false,
  created_at   timestamptz not null default now(),
  constraint contact_identities_channel check (channel in ('whatsapp', 'email', 'phone', 'instagram', 'facebook')),
  constraint contact_identities_id_len check (char_length(btrim(external_id)) between 1 and 320),
  constraint contact_identities_pair unique (channel, external_id)
);

comment on table public.contact_identities is
  'One row per channel identity. WhatsApp stores E.164. Email stores the address. Instagram and Facebook ids can be added later. No Meta connection in this migration.';

create index if not exists contact_identities_contact_idx on public.contact_identities (contact_id);

insert into public.contact_identities (contact_id, channel, external_id, is_primary)
select id, 'whatsapp', whatsapp_e164, true
from public.contacts
where whatsapp_e164 is not null
on conflict (channel, external_id) do nothing;

insert into public.contact_identities (contact_id, channel, external_id, is_primary)
select id, 'email', lower(email), true
from public.contacts
where email is not null
on conflict (channel, external_id) do nothing;

create table if not exists public.contact_signals (
  id          uuid primary key default gen_random_uuid(),
  contact_id  uuid not null references public.contacts(id) on delete cascade,
  kind        text not null,
  occurred_at timestamptz not null default now(),
  detail      text,
  constraint contact_signals_kind check (kind in ('link_opened', 'ad_click', 'replied', 'asked_price')),
  constraint contact_signals_detail_len check (detail is null or char_length(detail) <= 200)
);

comment on table public.contact_signals is
  'Future events such as a tracked link open. The lead score reads kind only. detail must stay a label, not a message body.';

create index if not exists contact_signals_contact_idx on public.contact_signals (contact_id, kind);

-- Points: ad click 10, replied 15, asked price 10, booked 25, opened a link 5, recent 10 or 5.
-- Reasons are codes. Message text is never returned.
create or replace function public.contact_lead_scores()
returns table (contact_id uuid, points int, reasons text[])
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null
     and not (private.can_section('customers', false) or private.can_bookings(false)) then
    return;
  end if;
  return query
  select c.id,
    (
      (case when c.ctwa_clid is not null or c.meta_ad_id is not null or c.fbclid is not null then 10 else 0 end)
      + (case when exists (
          select 1 from public.messages m
          where m.contact_id = c.id and m.direction = 'in' and m.sender_type = 'customer'
        ) then 15 else 0 end)
      + (case when c.asked_price then 10 else 0 end)
      + (case when exists (
          select 1 from public.workshop_bookings b
          where b.status = 'paid' and (b.contact_id = c.id or b.booker_contact_id = c.id)
        ) then 25 else 0 end)
      + (case when exists (
          select 1 from public.contact_signals s
          where s.contact_id = c.id and s.kind = 'link_opened'
        ) then 5 else 0 end)
      + (case
          when coalesce(c.last_inbound_at, c.last_activity, c.created_at) >= now() - interval '14 days' then 10
          when coalesce(c.last_inbound_at, c.last_activity, c.created_at) >= now() - interval '45 days' then 5
          else 0 end)
    )::int as points,
    array_remove(array[
      case when c.ctwa_clid is not null or c.meta_ad_id is not null or c.fbclid is not null then 'ad_click' end,
      case when exists (
          select 1 from public.messages m
          where m.contact_id = c.id and m.direction = 'in' and m.sender_type = 'customer'
        ) then 'replied' end,
      case when c.asked_price then 'asked_price' end,
      case when exists (
          select 1 from public.workshop_bookings b
          where b.status = 'paid' and (b.contact_id = c.id or b.booker_contact_id = c.id)
        ) then 'booked' end,
      case when exists (
          select 1 from public.contact_signals s
          where s.contact_id = c.id and s.kind = 'link_opened'
        ) then 'opened_link' end,
      case when coalesce(c.last_inbound_at, c.last_activity, c.created_at) >= now() - interval '45 days' then 'recent' end
    ], null)::text[] as reasons
  from public.contacts c;
end;
$$;

comment on function public.contact_lead_scores() is
  'Explainable B2C score. Returns points and reason codes only, never message text or medical notes.';

revoke all on function public.contact_lead_scores() from public, anon;
grant execute on function public.contact_lead_scores() to authenticated;

alter table public.contact_identities enable row level security;
alter table public.contact_signals enable row level security;

drop policy if exists contact_identities_read on public.contact_identities;
create policy contact_identities_read on public.contact_identities for select to authenticated
  using (private.can_section('customers', false) or private.can_bookings(false));
drop policy if exists contact_identities_write on public.contact_identities;
create policy contact_identities_write on public.contact_identities for insert to authenticated
  with check (private.can_section('customers', true) or private.can_bookings(true));
drop policy if exists contact_identities_update on public.contact_identities;
create policy contact_identities_update on public.contact_identities for update to authenticated
  using (private.can_section('customers', true) or private.can_bookings(true))
  with check (private.can_section('customers', true) or private.can_bookings(true));

drop policy if exists contact_signals_read on public.contact_signals;
create policy contact_signals_read on public.contact_signals for select to authenticated
  using (private.can_section('customers', false) or private.can_bookings(false));
drop policy if exists contact_signals_write on public.contact_signals;
create policy contact_signals_write on public.contact_signals for insert to authenticated
  with check (private.can_section('customers', true) or private.can_bookings(true));

revoke all on public.contact_identities from public, anon, authenticated;
grant select, insert, update on public.contact_identities to authenticated;
revoke all on public.contact_signals from public, anon, authenticated;
grant select, insert on public.contact_signals to authenticated;

grant update (asked_price) on public.contacts to authenticated;

commit;
