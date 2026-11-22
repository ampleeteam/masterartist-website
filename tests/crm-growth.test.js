const test = require('node:test');
const assert = require('node:assert/strict');
const { leadScore, emailSendable, segmentMatch, reasonText, indexHtml, recordFrame, taskBucket, taskPriority, checklistState, sortRows, pageWindow, appNav, folds } = require('../assets/crm-growth.js');

test('lead score is explainable and does not need message text', function () {
  const full = leadScore({ adClick: true, replied: true, askedPrice: true, booked: true, openedLink: true, recencyDays: 3 });
  assert.equal(full.points, 10 + 15 + 10 + 25 + 5 + 10);
  assert.deepEqual(full.reasons, ['ad_click', 'replied', 'asked_price', 'booked', 'opened_link', 'recent']);
  const quiet = leadScore({ recencyDays: 30 });
  assert.equal(quiet.points, 5);
  assert.equal(reasonText(quiet.reasons), 'Recent');
  const stale = leadScore({ recencyDays: 90 });
  assert.equal(stale.points, 0);
});

test('email sends only to opted-in addresses', function () {
  assert.equal(emailSendable({ email: 'a@example.com', email_consent: true }, false), null);
  assert.equal(emailSendable({ email: 'a@example.com', email_consent: false }, false), 'no consent');
  assert.equal(emailSendable({ email: 'a@example.com', email_consent: true, unsubscribed: true }, false), 'unsubscribed');
  assert.equal(emailSendable({ email: 'a@example.com', email_consent: true, do_not_contact: true }, false), 'do not contact');
  assert.equal(emailSendable({ email: 'a@example.com', email_consent: true }, true), 'suppressed');
  assert.equal(emailSendable({ email_consent: true }, false), 'no email');
});

test('saved list clauses match the whitelisted fields', function () {
  const person = {
    whatsapp_consent: true, unsubscribed: false, do_not_contact: false,
    formats_attended: ['baking'], days_since_last_booking: 70, has_child: true
  };
  assert.equal(segmentMatch(person, [
    { field: 'formats_attended', op: 'contains', value: 'baking' },
    { field: 'days_since_last_booking', op: 'gte', value: 60 }
  ]), true);
  assert.equal(segmentMatch(person, [{ field: 'has_child', op: 'eq', value: true }]), true);
  assert.equal(segmentMatch(person, [{ field: 'whatsapp_opt_in', op: 'eq', value: true }]), true);
  assert.equal(segmentMatch({ whatsapp_consent: true, unsubscribed: true }, [{ field: 'whatsapp_opt_in', value: true }]), false);
  assert.equal(segmentMatch({ contact_type: 'parent' }, [{ field: 'contact_type', op: 'eq', value: 'parent' }]), true);
});

test('index table is dense, sortable, and paged', function () {
  const rows = [
    { id: '11111111-1111-1111-1111-111111111111', cells: { name: 'Aina Rahman', email: 'aina.sample@example.com' }, sort: { name: 'aina' } },
    { id: '22222222-2222-2222-2222-222222222222', cells: { name: 'Farid Lee', email: 'farid.sample@example.com' }, sort: { name: 'farid' } }
  ];
  const html = indexHtml({
    scope: 'customers',
    tabs: [{ id: 'all', label: 'All customers' }, { id: 'parents', label: 'Parents' }],
    tab: 'all',
    columns: [{ key: 'name', label: 'Name' }, { key: 'email', label: 'Email' }],
    allColumns: [{ key: 'name', label: 'Name' }, { key: 'email', label: 'Email' }],
    rows, sort: { key: 'name', dir: 'asc' }, page: 0, pageSize: 1, selected: {}
  });
  assert.match(html, /ix-table/);
  assert.match(html, /ix-mlist/);
  assert.match(html, /Sort and filter/);
  assert.match(html, /ix-sticky/);
  assert.match(html, /Edit columns/);
  assert.match(html, /All customers/);
  assert.match(html, /Aina Rahman/);
  assert.doesNotMatch(html, /Farid Lee/);
  assert.match(html, /Page 1 of 2/);
  const ordered = sortRows(rows, 'name', 'desc');
  assert.equal(ordered[0].cells.name, 'Farid Lee');
  assert.equal(pageWindow(2, 0, 1).to, 1);
});

test('tasks bucket by due date and the record frame has three columns', function () {
  assert.equal(taskBucket('2026-11-21', '2026-11-22'), 'overdue');
  assert.equal(taskBucket('2026-11-22', '2026-11-22'), 'today');
  assert.equal(taskPriority('2026-11-21', '2026-11-22').label, 'High');
  const frame = recordFrame({ top: '<h2>Aina Rahman</h2>', left: 'About', middle: 'Timeline', right: 'Family' });
  assert.match(frame, /rec-l/);
  assert.match(frame, /rec-m/);
  assert.match(frame, /rec-r/);
});

test('the customer form lists every field group', function () {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../admin.html'), 'utf8');
  ['Contact info', 'Lifecycle and lead status', 'Source and attribution', 'Marketing consent', 'Interests and tags', 'Family', 'Participants health', 'Bookings and stats', 'Academy credit and referrals', 'Social handles', 'Custom fields'].forEach(function (title) {
    assert.ok(html.includes("section('" + title + "'") || html.includes('section("' + title + '"'), title);
  });
  assert.match(html, /Queue reply/);
  assert.match(html, /Open full record/);
});

test('the CRM nav and record folds keep labels', function () {
  const nav = appNav([
    { label: 'CRM', items: [{ id: 'inbox', label: 'Inbox', icon: 'inbox', badge: '3', go: "goNav('inbox')" }, { id: 'customers', label: 'Customers', icon: 'customers', go: "goNav('customers')" }] }
  ], 'inbox');
  assert.match(nav, /Inbox/);
  assert.match(nav, />3</);
  assert.match(nav, /class="snav on"/);
  const form = folds([{ title: 'Contact info', body: '<input>', open: true }, { title: 'Family', body: '' }]);
  assert.match(form, /Contact info/);
  assert.match(form, /<details class="fold" open>/);
});

test('email checklist ticks only the parts that are filled', function () {
  const open = checklistState({ to: 'list', fromName: 'Master Artist', fromEmail: 'news@masterartist.co', subject: '', when: 'now', blocks: [] });
  assert.equal(open.to, true);
  assert.equal(open.from, true);
  assert.equal(open.subject, false);
  assert.equal(open.send, true);
  assert.equal(open.content, false);
});
