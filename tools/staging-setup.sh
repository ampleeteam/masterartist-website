#!/usr/bin/env bash
# Builds the Master Artist staging database from the live one, then applies the
# CRM branch's new migrations to staging only.
#
#   bash tools/staging-setup.sh
#
# What it does
#   1. Copies the live database's STRUCTURE (schemas public and private: tables,
#      functions, policies, grants). No customer rows are copied.
#   2. Loads that structure into the staging project.
#   3. Applies the migrations that are new on this branch, in order.
#   4. Makes your staging login an admin and lists the CRM tables.
#
# It asks for both connection strings and never writes them to disk. It refuses to
# apply migrations to the live project (fudaosneozobacdalncv).
#
# Needs pg_dump and psql 15 or newer:  brew install libpq
set -euo pipefail

LIVE_REF="fudaosneozobacdalncv"
cd "$(dirname "$0")/.."

PATH="/opt/homebrew/opt/libpq/bin:/usr/local/opt/libpq/bin:$PATH"
for tool in pg_dump psql; do
  command -v "$tool" >/dev/null || { echo "Missing $tool. Run: brew install libpq"; exit 1; }
done

NEW_MIGRATIONS=(
  20261122002642_baseline_bookings_crm_events.sql
  20261122110000_workshop_sessions_and_enrolments.sql
  20261122120000_conversation_cases_and_refs.sql
  20261122130000_event_finance.sql
  20261122140000_inbox_views.sql
  20261122150000_roster_history_assignment.sql
  20261122160000_deal_qualified_stage.sql
  20261122170000_conversation_snooze.sql
  20261122180000_ad_links_and_attribution.sql
  20261122190000_crm_finish.sql
)

cat <<'EOF'
Connection strings: Supabase dashboard -> project -> Connect -> "Session pooler".
Paste each with the real database password in place of [YOUR-PASSWORD].
Nothing you paste is shown or saved.
EOF
read -rsp "LIVE connection string:    " LIVE_DB; echo
read -rsp "STAGING connection string: " STAGING_DB; echo

case "$STAGING_DB" in
  *"$LIVE_REF"*) echo "That staging string points at the LIVE project. Stopping."; exit 1 ;;
esac
case "$LIVE_DB" in
  *"$LIVE_REF"*) ;;
  *) echo "The live string does not mention $LIVE_REF. Stopping."; exit 1 ;;
esac

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
SCHEMA="$WORK/live-schema.sql"

echo "1/4 Copying the live structure (no rows)..."
pg_dump "$LIVE_DB" --schema-only --no-owner --schema=public --schema=private -f "$SCHEMA.raw"
# The public schema already exists on a new project and belongs to Supabase.
grep -vE '^(CREATE SCHEMA public;|COMMENT ON SCHEMA public )' "$SCHEMA.raw" > "$SCHEMA"
echo "    $(grep -c '^CREATE TABLE' "$SCHEMA") tables, $(grep -c '^CREATE FUNCTION' "$SCHEMA") functions"

echo "2/4 Loading it into staging..."
psql "$STAGING_DB" -q -v ON_ERROR_STOP=1 -c "create extension if not exists pg_net; create extension if not exists pgcrypto with schema extensions;"
psql "$STAGING_DB" -q -v ON_ERROR_STOP=1 -f "$SCHEMA"

echo "3/4 Applying the new migrations to staging..."
for m in "${NEW_MIGRATIONS[@]}"; do
  echo "    $m"
  psql "$STAGING_DB" -q -v ON_ERROR_STOP=1 -f "supabase/migrations/$m" > "$WORK/out.txt" 2>&1 || {
    echo "    FAILED. Last lines:"; tail -20 "$WORK/out.txt"; exit 1; }
done

echo "4/4 Admin login and checks..."
read -rp "Email of the user you added in staging Authentication -> Users: " EMAIL
psql "$STAGING_DB" -q -v ON_ERROR_STOP=1 -v email="$EMAIL" <<'SQL'
insert into public.profiles (id, role, active, full_name)
select u.id, 'admin', true, coalesce(u.raw_user_meta_data->>'full_name', split_part(u.email, '@', 1))
from auth.users u where lower(u.email) = lower(:'email')
on conflict (id) do update set role = 'admin', active = true;
select case when count(*) = 1 then 'Admin login ready for ' || :'email'
            else 'No staging user with that email yet: add it in Authentication -> Users, then run this step again.' end as result
from public.profiles p join auth.users u on u.id = p.id where lower(u.email) = lower(:'email');
select table_name from information_schema.tables
where table_schema = 'public' and table_name in
  ('contacts','conversations','messages','group_deals','workshop_sessions','ad_links',
   'payments','keyword_rules','staff_duty','knowledge_articles','assignment_cursor')
order by 1;
SQL

echo "Done. Staging has the live structure plus this branch's migrations."
