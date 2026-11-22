const test = require('node:test');
const assert = require('node:assert/strict');
const {
  emptyFilters, seedViews, passes, arrange, chips, dropChip, readState, writeState,
  windowState, waitingLabel, weekRange
} = require('../assets/crm-inbox-views.js');

const now = new Date('2026-11-22T02:00:00Z');
const sessions = [
  { id: 'children-2027', title: "Children's art", starts_at: '2026-11-29T02:00:00Z', capacity: 12 },
  { id: 'bread-past', title: 'Sourdough', starts_at: '2026-11-01T02:00:00Z', capacity: 8 }
];

function row(extra) {
  return Object.assign({
    id: 'c', channel: 'whatsapp', status: 'open', assigned_to: 'maya', unread_count: 1,
    last_direction: 'in', last_message_at: '2026-11-22T01:00:00Z', last_inbound_at: '2026-11-22T01:00:00Z',
    stage: 'enquired', session_id: 'children-2027', tags: ['kids'], entry_kind: 'ad',
    headline: "Children's Art Class", bookings_count: 0, lifetime_spend_rm: 0, score: 70,
    starts_at: '2026-11-29T02:00:00Z', category: 'kids'
  }, extra);
}

test('seeds stay client-side and describe the two default views', function () {
  const seeds = seedViews(now);
  assert.equal(seeds.length, 2);
  assert.equal(seeds[0].name, 'Kids enquiries from ads this week');
  assert.equal(seeds[0].definition.filters.sources[0], 'ad');
  assert.equal(seeds[1].name, 'Unpaid this weekend');
  assert.deepEqual(seeds[1].definition.filters.stages, ['enquired', 'interested', 'enrolled']);
  const week = weekRange(now);
  assert.equal(week.from <= '2026-11-22' && week.to >= '2026-11-22', true);
});

test('filters combine with AND and the URL round-trips', function () {
  const filters = Object.assign(emptyFilters(), {
    channels: ['whatsapp'], stages: ['enquired'], sources: ['ad'], unread: true, customer: 'new', scoreBand: 'high'
  });
  assert.equal(passes(row(), filters, now), true);
  assert.equal(passes(row({ channel: 'email' }), filters, now), false);
  assert.equal(passes(row({ bookings_count: 2 }), filters, now), false);
  const search = writeState({ view: 'needs', filters: filters }, '?preview=needs');
  const back = readState(search);
  assert.equal(back.view, 'needs');
  assert.deepEqual(back.filters.channels, ['whatsapp']);
  assert.equal(back.filters.unread, true);
  assert.match(search, /preview=needs/);
  const chip = chips(filters).find(function (item) { return item.id === 'unread'; });
  assert.equal(dropChip(filters, chip.id).unread, false);
});

test('needs reply pins a window closing within 4 hours, oldest wait after that', function () {
  const soon = row({ id: 'soon', last_inbound_at: '2026-11-21T04:00:00Z', last_message_at: '2026-11-21T04:00:00Z' });
  const old = row({ id: 'old', last_inbound_at: '2026-11-20T01:00:00Z', last_message_at: '2026-11-20T01:00:00Z' });
  const fresh = row({ id: 'fresh', last_inbound_at: '2026-11-22T01:30:00Z' });
  assert.equal(windowState(soon, now).closing, true);
  assert.equal(windowState(fresh, now).closing, false);
  assert.equal(waitingLabel('2026-11-20T01:00:00Z', now), '2d');
  const arranged = arrange([fresh, old, soon], { view: 'needs', filters: emptyFilters() }, sessions, now);
  assert.deepEqual(arranged.rows.map(function (item) { return item.id; }), ['soon', 'old', 'fresh']);
});

test('by event groups upcoming sessions and leaves unlinked chats last', function () {
  const rows = [
    row({ id: 'a', stage: 'enquired' }),
    row({ id: 'b', stage: 'paid', session_id: 'children-2027' }),
    row({ id: 'c', stage: '', session_id: '', starts_at: '' })
  ];
  const arranged = arrange(rows, { view: 'event', filters: emptyFilters() }, sessions, now);
  assert.equal(arranged.groups[0].title.includes("Children's art"), true);
  assert.match(arranged.groups[0].title, /seats left/);
  assert.equal(arranged.groups[arranged.groups.length - 1].title, 'No event linked');
  const past = arrange([row({ id: 'p', session_id: 'bread-past', starts_at: '2026-11-01T02:00:00Z', stage: 'paid' })], { view: 'event', filters: emptyFilters() }, sessions, now);
  assert.equal(past.groups[0].past, true);
});

test('pipeline columns follow the enrolment stages', function () {
  const arranged = arrange([
    row({ id: 'a', stage: 'enquired' }),
    row({ id: 'b', stage: 'paid' })
  ], { view: 'pipeline', filters: emptyFilters() }, sessions, now);
  assert.deepEqual(arranged.columns.map(function (col) { return col.stage; }).slice(0, 5), ['enquired', 'interested', 'enrolled', 'paid', 'attended']);
  assert.equal(arranged.columns[0].rows.length, 1);
  assert.equal(arranged.columns[3].rows.length, 1);
});

test('kids go to Alysha and everyone else is round-robin among people on duty', function () {
  const { pickAssignee } = require('../assets/crm-inbox-views.js');
  const rules = [{ kind: 'category', match: 'kids', staff_id: 'alysha' }, { kind: 'category', match: 'corporate', staff_id: 'sabrina' }];
  const duty = [{ staff_id: 'alysha', on_duty: true }, { staff_id: 'sabrina', on_duty: true }, { staff_id: 'maya', on_duty: false }];
  assert.equal(pickAssignee(rules, duty, null, { category: 'kids' }), 'alysha');
  assert.equal(pickAssignee(rules, duty, null, { category: 'corporate' }), 'sabrina');
  assert.equal(pickAssignee(rules, duty, 'alysha', { category: 'painting', source: 'ad' }), 'sabrina');
});

test('mine keeps only the signed-in assignee', function () {
  const arranged = arrange([
    row({ id: 'mine', assigned_to: 'maya' }),
    row({ id: 'other', assigned_to: 'amir' })
  ], { view: 'mine', meId: 'maya', filters: emptyFilters() }, sessions, now);
  assert.deepEqual(arranged.rows.map(function (item) { return item.id; }), ['mine']);
});
