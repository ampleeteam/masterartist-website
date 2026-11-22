const test = require('node:test');
const assert = require('node:assert/strict');
const { leadScore, emailSendable, segmentMatch, reasonText } = require('../assets/crm-growth.js');

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
});
