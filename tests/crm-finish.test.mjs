import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const finish = require('../assets/crm-finish.js');

test('saved reply fills the workshop variables', () => {
  const vars = finish.replyVars(
    { first_name: 'Hana', child_name: 'Aina' },
    { id: 'children-2027', title: "Children's art", when: 'Sun 29 Nov, 10:00', price_rm: 150, capacity: 12, taken: 4 }
  );
  const text = finish.fillReply('Hello {first_name}, {child_name} can join {next_workshop} on {workshop_date}. {price}, {seats_left} seats left. {booking_link}', vars);
  assert.equal(text, "Hello Hana, Aina can join Children's art on Sun 29 Nov, 10:00. RM150, 8 seats left. https://masterartist.co/workshops/children-2027");
});

test('booking card names the session, price, seats and link', () => {
  const text = finish.bookingCard({ id: 'bake', title: 'Gingerbread Bake Lab', when: 'Sun 29 Nov, 14:00', price_rm: 180, capacity: 16, taken: 10 });
  assert.match(text, /Gingerbread Bake Lab/);
  assert.match(text, /RM180, all in/);
  assert.match(text, /6 seats left/);
  assert.match(text, /\/workshops\/bake/);
});

test('duplicates match a shared phone across channels', () => {
  const groups = finish.duplicateGroups([
    { id: 'a', first_name: 'Hana', last_name: 'Parent', whatsapp_e164: '+60173334444', channel: 'whatsapp' },
    { id: 'b', first_name: 'Hana', last_name: 'P.', whatsapp_e164: '0173334444', channel: 'instagram' }
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].reason, 'Same phone');
});

test('a question with no article is a knowledge gap', () => {
  const answer = finish.knowledgeAnswer(
    [{ title: 'Parking', body: 'Street parking near the studio.', keywords: 'parking' }],
    'Do you have lockers?'
  );
  assert.equal(answer.ok, false);
  assert.equal(answer.gap, 'Do you have lockers?');
});

test('a price question is answered from knowledge and not sent', () => {
  const answer = finish.knowledgeAnswer(
    [{ title: 'Prices', body: 'Each workshop page shows the all-in price.', keywords: 'price cost' }],
    'What is the price?'
  );
  assert.equal(answer.ok, true);
  assert.match(answer.draft, /all-in price/);
});

test('staff reply pauses automation for the configured minutes', () => {
  const until = finish.pauseUntil(new Date('2026-11-22T10:00:00Z'), 30);
  assert.equal(until, '2026-11-22T10:30:00.000Z');
});

test('search matches message text', () => {
  const hits = finish.searchHits([
    { body: 'Is the Saturday class still open?' },
    { body: 'See you then' }
  ], 'saturday');
  assert.equal(hits.length, 1);
});

test('channel mark is a dot, not a wrapping label', () => {
  assert.match(finish.channelDot('instagram'), /mc-dot dot-ig/);
  assert.doesNotMatch(finish.channelDot('website'), /Website form/);
});
