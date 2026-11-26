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
  assert.equal(byId['bake-lab-2026-11-29-1500'].price, 130);
  assert.equal(byId['bake-lab-2026-11-29-1500'].pair_price, 260);
  assert.equal(byId['bake-lab-2026-12-02-1500'].price, 95);
  assert.equal(byId['textured-canvas-2026-12-06-1500'].theme, 'Floral Impasto');
  assert.equal(byId['textured-canvas-2026-12-06-1500'].price, 89);
  assert.equal(byId['kids-2026-12-06-1500'].price, 109);
  for (const s of feed.sessions) {
    assert.equal(Number.isInteger(s.price), true);
    assert.equal(s.public, true);
  }
});

test('type pages list the next dates with one price and WhatsApp', () => {
  const textured = read('workshops/textured-canvas/index.html');
  assert.match(textured, /Floral Impasto/);
  assert.match(textured, /data-start="2026-12-06T15:00:00\+08:00"/);
  assert.match(textured, /Book on WhatsApp/);
  assert.match(textured, /60102779426/);
  assert.match(textured, /\{source\}/);
  assert.doesNotMatch(textured, /Golden Impasto/);
  assert.doesNotMatch(textured, /early bird/i);
  assert.doesNotMatch(textured, /8 November/);
  assert.match(textured, /Public holiday sessions are 10% more\./);

  const bake = read('workshops/bake-lab/index.html');
  assert.match(bake, /Gingerbread Baking Workshop/);
  assert.match(bake, /RM130 <small>per person · 2 pax RM260<\/small>/);
  assert.match(bake, />Bread</);
  assert.match(bake, /data-start="2026-12-02T15:00:00\+08:00"/);
  assert.match(bake, /<span class="amt">RM95<\/span>/);
  assert.doesNotMatch(bake, /Specialty bakes/);
  assert.doesNotMatch(bake, /RM85/);

  const acrylic = read('workshops/acrylic-canvas/index.html');
  assert.match(acrylic, /Nothing is open on the calendar right now/);
  assert.match(acrylic, /WhatsApp us/);
  assert.match(acrylic, /60102779426/);
  assert.doesNotMatch(acrylic, /New dates are on the way/);

  for (const rel of ['workshops/candle-making/index.html', 'workshops/crochet-bag/index.html', 'workshops/glow-canvas/index.html', 'workshops/watercolour-botanicals/index.html']) {
    const html = read(rel);
    assert.match(html, /data-next-dates/);
    assert.match(html, /Nothing is open on the calendar right now/);
    assert.match(html, /60102779426/);
  }
});

test('painting and kids pages, and the classes link both ways', () => {
  const painting = read('workshops/painting/index.html');
  assert.match(painting, /rel="canonical" href="https:\/\/masterartist\.co\/workshops\/painting\/"/);
  assert.match(painting, /Sip and paint/);
  assert.match(painting, /href="\/workshops\/textured-canvas\/"/);
  assert.match(painting, /href="\/workshops\/textured-canvas\/2026-12-06\/"/);
  assert.match(painting, /Floral Impasto/);
  assert.match(painting, /href="\/workshops\/acrylic-canvas\/"/);
  assert.match(painting, /href="\/workshops\/watercolour-botanicals\/"/);
  assert.match(painting, /href="\/workshops\/glow-canvas\/"/);

  const kids = read('workshops/kids/index.html');
  assert.match(kids, /rel="canonical" href="https:\/\/masterartist\.co\/workshops\/kids\/"/);
  assert.match(kids, /Family Sunday/);
  assert.match(kids, /RM109/);
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
});
