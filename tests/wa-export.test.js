const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normaliseMyPhone,
  isStudioSender,
  parseWhatsAppExport,
  rowsToTimeline,
  filterTimeline,
  timelineHtml
} = require('../assets/wa-export.js');

test('Malaysian numbers become +60 E.164 and other countries stay', function () {
  assert.equal(normaliseMyPhone('012-345 6789'), '+60123456789');
  assert.equal(normaliseMyPhone('60123456789'), '+60123456789');
  assert.equal(normaliseMyPhone('+60 12 345 6789'), '+60123456789');
  assert.equal(normaliseMyPhone('123456789'), '+60123456789');
  assert.equal(normaliseMyPhone('+1 415 555 2671'), '+14155552671');
  assert.equal(normaliseMyPhone(''), '');
  assert.equal(normaliseMyPhone('abc'), '');
});

test('studio name and You count as outbound', function () {
  assert.equal(isStudioSender('Master Artist', 'master artist'), true);
  assert.equal(isStudioSender('You', ''), true);
  assert.equal(isStudioSender('Aina Sample', 'Master Artist'), false);
});

test('parses iOS and Android export lines, keeps replies, skips encryption notices', function () {
  var text = [
    '\u200e[04/11/2024, 9:41:23 AM] Aina Sample: Is the Sunday workshop still open?',
    '[04/11/2024, 9:45:01 AM] Master Artist: Yes — two seats left.',
    'I can hold them until 6.',
    '[04/11/2024, 9:46:12 AM] Aina Sample: <Media omitted>',
    '[04/11/2024, 9:46:40 AM] Messages and calls are end-to-end encrypted. Only people in this chat can read them.',
    '04/11/2024, 4:05 pm - Master Artist: IMG-0001.jpg (file attached)',
    '04/11/2024, 4:06 pm - Missed voice call'
  ].join('\n');
  var parsed = parseWhatsAppExport(text);
  assert.equal(parsed.messages.length, 4);
  assert.ok(parsed.skipped >= 2);
  assert.equal(parsed.messages[0].sender, 'Aina Sample');
  assert.equal(parsed.messages[0].occurredAt, '2024-11-04T01:41:23.000Z');
  assert.match(parsed.messages[1].body, /two seats/);
  assert.match(parsed.messages[1].body, /until 6/);
  assert.equal(parsed.messages[2].media[0].kind, 'omitted');
  assert.equal(parsed.messages[3].media.some(function (m) { return m.kind === 'file' && m.name === 'IMG-0001.jpg'; }), true);
  var again = parseWhatsAppExport(text);
  assert.deepEqual(again.messages.map(function (m) { return m.occurredAt + m.body; }), parsed.messages.map(function (m) { return m.occurredAt + m.body; }));
});

test('timeline is chronological, escapes HTML, and filters', function () {
  var rows = rowsToTimeline([
    { occurred_at: '2024-11-04T02:00:00.000Z', kind: 'booking', channel: 'website', direction: 'out', sender_type: 'system', body: 'Textured canvas', booking_event: 'confirmed', source: 'live', media: [] },
    { occurred_at: '2024-11-04T01:00:00.000Z', kind: 'message', channel: 'whatsapp', direction: 'in', sender_type: 'customer', sender_name: 'Aina', body: '<script>', source: 'live', media: [] },
    { occurred_at: '2024-11-04T01:30:00.000Z', kind: 'message', channel: 'whatsapp', direction: 'out', sender_type: 'bot', sender_name: 'Master Artist', body: 'Your seat is confirmed.', source: 'live', media: [] },
    { occurred_at: '2024-11-04T03:00:00.000Z', kind: 'message', channel: 'note', direction: 'out', sender_type: 'staff', body: 'Called, no answer', source: 'manual', media: [] }
  ]);
  assert.deepEqual(rows.map(function (r) { return r.body; }), ['<script>', 'Your seat is confirmed.', 'Textured canvas', 'Called, no answer']);
  var html = timelineHtml(rows);
  assert.equal(html.includes('<script>'), false);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.indexOf('&lt;script&gt;') < html.indexOf('Your seat is confirmed'));
  assert.ok(html.includes('Booking confirmed'));
  assert.ok(html.includes('Automated'));
  assert.equal(filterTimeline(rows, 'auto').length, 1);
  assert.equal(filterTimeline(rows, 'notes').length, 1);
  assert.equal(filterTimeline(rows, 'bookings').length, 1);
  assert.equal(filterTimeline(rows, 'whatsapp').length, 2);
});
