const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('schedule csv maps columns and skips a private row', () => {
  const { execFileSync } = require('child_process');
  const out = execFileSync('python3', [
    'scripts/sync_schedule.py', '--csv', 'tests/fixtures/schedule.csv', '--dry-run',
  ], { cwd: root, encoding: 'utf8' });
  const doc = JSON.parse(out);
  assert.ok(doc.columns.includes('Date'));
  assert.ok(doc.columns.includes('Price'));
  assert.equal(fs.existsSync(path.join(root, 'data/schedule-import.json')), false);
  const floral = doc.sessions.find((s) => s.theme === 'Floral Impasto');
  assert.equal(floral.format, 'textured-canvas');
  assert.equal(floral.date, '2026-12-06');
  assert.equal(floral.time, '15:00');
  assert.equal(floral.price, 109);
  assert.equal(floral.pair_price, 196);
  const bread = doc.sessions.find((s) => s.theme === 'Bread');
  assert.equal(bread.price, 95);
  assert.equal(bread.format, 'bake-lab');
  assert.equal(doc.sessions.some((s) => s.theme === 'Koi'), false);
  const kids = doc.sessions.find((s) => s.format === 'kids');
  assert.equal(kids.time, '15:00');
  assert.equal(kids.end, '17:00');
  assert.equal(kids.price, 109);
});

test('sessions feed keeps checkout prices in ringgit', () => {
  const feed = JSON.parse(read('assets/sessions.json'));
  const byId = Object.fromEntries(feed.sessions.map((s) => [s.id, s]));
  assert.equal(byId['textured-canvas-2026-11-26-1930'], undefined);
  assert.equal(byId['bake-lab-2026-12-02-1500'], undefined);
  assert.equal(byId['kids-2026-12-06-1500'], undefined);
  assert.equal(byId['bake-lab-2026-11-29-1500'].price, 130);
  assert.equal(byId['bake-lab-2026-11-29-1500'].pair_price, 260);
  assert.equal(byId['textured-canvas-2026-12-06-1000'].theme, 'Floral Impasto');
  assert.equal(byId['textured-canvas-2026-12-06-1000'].price, 89);
  assert.equal(byId['textured-canvas-2026-12-06-1000'].pair_price, null);
  assert.equal(byId['textured-canvas-2026-12-06-1500'].price, 89);
  assert.equal(byId['watercolour-botanicals-2026-12-01-1500'].price, 80);
  assert.equal(byId['glow-canvas-2026-12-01-1900'].price, 85);
  assert.equal(byId['bake-lab-2026-12-16-1500'].price, 85);
  assert.equal(byId['acrylic-canvas-2026-12-03-1500'], undefined);
  for (const s of feed.sessions) {
    assert.equal(Number.isInteger(s.price), true);
    assert.ok(s.price > 0);
    assert.equal(s.public, true);
  }
});

test('type pages list the next dates with one price and WhatsApp', () => {
  const textured = read('workshops/textured-canvas/index.html');
  assert.match(textured, /Floral Impasto/);
  assert.match(textured, /data-start="2026-12-06T10:00:00\+08:00"/);
  assert.match(textured, /data-start="2026-12-06T15:00:00\+08:00"/);
  assert.match(textured, /Book on WhatsApp/);
  assert.match(textured, /60102779426/);
  assert.match(textured, /\{source\}/);
  assert.doesNotMatch(textured, /Golden Impasto/);
  assert.doesNotMatch(textured, /early bird/i);
  assert.doesNotMatch(textured, /Pair RM/);
  assert.doesNotMatch(textured, /8 November/);
  assert.match(textured, /Public holiday sessions are 10% more\./);

  const bake = read('workshops/bake-lab/index.html');
  assert.match(bake, /Gingerbread Baking Workshop/);
  assert.match(bake, /RM130 <small>per person · 2 pax RM260<\/small>/);
  assert.match(bake, /Brownies/);
  assert.match(bake, /<span class="amt">RM85<\/span>/);
  assert.match(bake, /Cakepop/);
  assert.match(bake, /Ask us on WhatsApp/);
  assert.doesNotMatch(bake, />Bread</);
  assert.doesNotMatch(bake, /Specialty bakes/);

  const floral = read('workshops/textured-canvas/2026-12-06/index.html');
  assert.match(floral, /10am/);
  assert.match(floral, /3pm/);
  assert.match(floral, /RM89/);
  assert.doesNotMatch(floral, /Pair/);
  assert.doesNotMatch(floral, /for two/i);

  const aurora = read('workshops/acrylic-canvas/2026-12-03/index.html');
  assert.match(aurora, /Ask us on WhatsApp/);
  assert.match(aurora, /data-session="acrylic-canvas-2026-12-03-1500"/);
  assert.doesNotMatch(aurora, /data-price="89"/);

  const crochet = read('workshops/crochet-bag/index.html');
  assert.match(crochet, /Nothing is open on the calendar right now/);
  assert.match(crochet, /60102779426/);
  assert.doesNotMatch(crochet, /New dates are on the way/);
});

test('painting and kids pages, and the classes link both ways', () => {
  const painting = read('workshops/painting/index.html');
  assert.match(painting, /rel="canonical" href="https:\/\/masterartist\.co\/workshops\/painting\/"/);
  assert.match(painting, /Sip and paint/);
  assert.match(painting, /href="\/workshops\/textured-canvas\/"/);
  assert.match(painting, /Watercolour Christmas Tree/);
  assert.match(painting, /RM80/);
  assert.match(painting, /Glow-in-the-Dark Galaxy/);
  assert.match(painting, /href="\/workshops\/acrylic-canvas\/"/);
  assert.match(painting, /href="\/workshops\/watercolour-botanicals\/"/);
  assert.match(painting, /href="\/workshops\/glow-canvas\/"/);

  const kids = read('workshops/kids/index.html');
  assert.match(kids, /rel="canonical" href="https:\/\/masterartist\.co\/workshops\/kids\/"/);
  assert.match(kids, /Kids Baking: Christmas Cookies/);
  assert.match(kids, /Ask us on WhatsApp/);
  assert.doesNotMatch(kids, /Family Sunday/);
  assert.doesNotMatch(kids, /RM109/);
  assert.match(kids, /href="\/classes\/"/);
  assert.match(kids, /60102779426/);
  assert.match(kids, /\{source\}/);

  const classes = read('classes/index.html');
  assert.match(classes, /href="\/workshops\/kids\/"/);
  const hub = read('workshops/index.html');
  assert.match(hub, /href="\/workshops\/painting\/"/);
  assert.match(hub, /href="\/workshops\/kids\/"/);
  assert.doesNotMatch(hub, /Golden Impasto/);

  const moved = read('workshops/textured-canvas/2026-11-26/index.html');
  assert.match(moved, /url=\/workshops\/textured-canvas\//);
  assert.match(moved, /noindex/);
  const sitemap = read('sitemap.xml');
  assert.match(sitemap, /https:\/\/masterartist\.co\/workshops\/painting\//);
  assert.match(sitemap, /https:\/\/masterartist\.co\/workshops\/kids\//);
  assert.doesNotMatch(sitemap, /textured-canvas\/2026-11-26\//);
  assert.equal(fs.existsSync(path.join(root, '.github/workflows/schedule.yml')), false);
});
