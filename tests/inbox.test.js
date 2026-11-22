const test = require('node:test');
const assert = require('node:assert/strict');
const {
  inSabbathWindow, whatsappWindow, fillTemplate, slashQuery, matchReplies, copyAllowed, mentionsIn, providerPayload
} = require('../assets/inbox.js');

const settings = { startDow: 5, startMin: 19 * 60, endDow: 6, endMin: 19 * 60 + 30 };

test('sabbath window is Friday 19:00 to Saturday 19:30 Kuala Lumpur', function () {
  assert.equal(inSabbathWindow('2026-11-20T10:59:00Z', settings), false);
  assert.equal(inSabbathWindow('2026-11-20T11:00:00Z', settings), true);
  assert.equal(inSabbathWindow('2026-11-21T11:29:00Z', settings), true);
  assert.equal(inSabbathWindow('2026-11-21T11:30:00Z', settings), false);
  assert.equal(inSabbathWindow('2026-11-22T02:00:00Z', settings), false);
});

test('24-hour window counts down from the last inbound and flags ads', function () {
  const open = whatsappWindow('2026-11-21T00:00:00Z', '2026-11-21T20:00:00Z', true);
  assert.equal(open.open, true);
  assert.equal(open.msLeft, 4 * 60 * 60 * 1000);
  assert.match(open.note, /click-to-WhatsApp/);
  const closed = whatsappWindow('2026-11-18T00:00:00Z', '2026-11-21T00:00:00Z', false);
  assert.equal(closed.open, false);
  assert.equal(closed.label, '24-hour window closed');
});

test('templates, slash picker, mentions, and brand wording', function () {
  assert.equal(fillTemplate('Hello {first_name}, see you at {workshop} on {date}.', {
    first_name: 'Aina', workshop: 'Acrylic canvas', date: '29 Nov 2026'
  }), 'Hello Aina, see you at Acrylic canvas on 29 Nov 2026.');
  assert.equal(slashQuery('thanks /ho'), 'ho');
  assert.equal(slashQuery('thanks'), null);
  const hits = matchReplies([{ title: 'Hold a seat', shortcut: '/hold' }, { title: 'Sunday', shortcut: '/sunday' }], 'sun');
  assert.equal(hits.length, 1);
  assert.deepEqual(mentionsIn('Please @Aina Staff look', [{ id: '1', full_name: 'Aina Staff' }]).map(s => s.id), ['1']);
  assert.equal(copyAllowed('See you Sunday'), true);
  assert.equal(copyAllowed('This is cheaper than a class'), false);
  assert.equal(copyAllowed('sip and paint night'), false);
  const payload = providerPayload({ template_name: 'reminder_dayof', language: 'en', variables: { first_name: 'Aina' }, phone_e164: '+60120000000' });
  assert.equal(payload.type, 'template');
  assert.equal(payload.name, 'reminder_dayof');
  assert.equal(payload.to, '+60120000000');
});
