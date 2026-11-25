-- Adds the Qualified stage to group bookings. Not applied.
-- Existing rows stay valid. Safe to run more than once.

begin;

alter table public.group_deals drop constraint if exists group_deals_stage;
alter table public.group_deals add constraint group_deals_stage
  check (stage in ('enquiry', 'qualified', 'proposal_sent', 'negotiating', 'won', 'lost'));

commit;
