-- Snooze a chat until a time, ManyChat-style. Not applied. Safe to run more than once.

begin;

alter table public.conversations add column if not exists snoozed_until timestamptz;

comment on column public.conversations.snoozed_until is
  'When set in the future, the chat stays out of Open and appears under Snoozed.';

commit;
