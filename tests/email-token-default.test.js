const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261122060000_email_token_default.sql'),
  'utf8'
);

test('email_token default matches the uuid column and backfills nulls', function () {
  assert.match(
    sql,
    /alter table public\.contacts alter column email_token set default gen_random_uuid\(\)/
  );
  assert.match(
    sql,
    /update public\.contacts set email_token = gen_random_uuid\(\) where email_token is null/
  );
  assert.doesNotMatch(sql, /::text/);
});
