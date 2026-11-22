-- New customers need a preferences token. email_token was added as uuid with no default,
-- so an insert that omits it stored null and the preferences page had nothing to look up.
-- Run after 20261122050000_email_marketing.sql. Safe to run more than once.
--
-- These inserts omit the column, so this default fills them. None of them writes null:
--   private.ingest_message  (unknown WhatsApp number)
--   private.upsert_contact  (workshop booking and trial form)
--   admin.html child contact (first_name, last_name, contact_type only)
-- contacts_derive does not touch email_token.

begin;

alter table public.contacts alter column email_token set default gen_random_uuid();

update public.contacts set email_token = gen_random_uuid() where email_token is null;

commit;
