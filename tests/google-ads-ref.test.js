const test = require('node:test');
const assert = require('node:assert/strict');

const SUFFIX = 'utm_source=google&utm_medium=cpc&utm_campaign={campaignid}&utm_content={creative}&utm_term={keyword}&ma_adgroup={adgroupid}&ma_device={device}&ma_network={network}';

let m;
test.before(async function () {
  m = await import('../attribution.mjs');
});

function memory() {
  const data = {};
  return {
    data,
    getItem(k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem(k, v) { data[k] = String(v); },
  };
}

test('capture stores first and last touch for 30 days', function () {
  const now = Date.parse('2026-11-26T02:00:00Z');
  const search = '?utm_source=google&utm_medium=cpc&utm_campaign=987&utm_content=654&utm_term=piano+lessons&utm_id=111&ma_adgroup=321&ma_device=m&ma_network=g&gclid=CjwKEA&gbraid=0AAAAA&wbraid=Ck';
  const visit = m.captureAdTouches({
    storedFirst: null,
    storedLast: null,
    now,
    search,
    landing: 'https://masterartist.co/workshops/?gclid=CjwKEA',
    referrer: 'https://www.google.com/aclk?foo=1',
  });
  assert.equal(visit.wroteFirst, true);
  assert.equal(visit.wroteLast, true);
  assert.equal(visit.first.expires, now + m.AD_TOUCH_TTL_MS);
  assert.equal(m.AD_TOUCH_TTL_MS, 30 * 24 * 60 * 60 * 1000);
  assert.equal(visit.first.gclid, 'CjwKEA');
  assert.equal(visit.first.gbraid, '0AAAAA');
  assert.equal(visit.first.wbraid, 'Ck');
  assert.equal(visit.first.utm_source, 'google');
  assert.equal(visit.first.utm_medium, 'cpc');
  assert.equal(visit.first.utm_campaign, '987');
  assert.equal(visit.first.utm_content, '654');
  assert.equal(visit.first.utm_term, 'piano lessons');
  assert.equal(visit.first.utm_id, '111');
  assert.equal(visit.first.ma_adgroup, '321');
  assert.equal(visit.first.ma_device, 'm');
  assert.equal(visit.first.ma_network, 'g');
  assert.equal(visit.first.landing_path, '/workshops/');
  assert.equal(visit.first.referrer_host, 'www.google.com');
  assert.equal(visit.first.seen_at, '2026-11-26T02:00:00.000Z');
  assert.notEqual(visit.first, visit.last);
  assert.equal(visit.last.gclid, 'CjwKEA');

  const later = m.captureAdTouches({
    storedFirst: visit.first,
    storedLast: visit.last,
    now: now + 10 * 24 * 60 * 60 * 1000,
    search: '?gclid=next&utm_source=google&utm_medium=ppc&ma_device=c',
    landing: 'https://masterartist.co/classes/voice/?gclid=next',
    referrer: 'https://googleads.g.doubleclick.net/pagead/aclk',
  });
  assert.equal(later.wroteFirst, false);
  assert.equal(later.wroteLast, true);
  assert.equal(later.first.gclid, 'CjwKEA');
  assert.equal(later.first.seen_at, visit.first.seen_at);
  assert.equal(later.last.gclid, 'next');
  assert.equal(later.last.utm_medium, 'ppc');
  assert.equal(later.last.ma_device, 'c');
  assert.equal(later.last.landing_path, '/classes/voice/');
  assert.equal(later.last.referrer_host, 'googleads.g.doubleclick.net');

  const browse = m.captureAdTouches({
    storedFirst: later.first,
    storedLast: later.last,
    now: now + 10 * 24 * 60 * 60 * 1000 + 5000,
    search: '',
    landing: 'https://masterartist.co/prices/',
    referrer: '',
  });
  assert.equal(browse.wroteFirst, false);
  assert.equal(browse.wroteLast, false);
  assert.equal(browse.last.gclid, 'next');
  assert.equal(browse.first.landing_path, '/workshops/');

  const expired = m.captureAdTouches({
    storedFirst: visit.first,
    storedLast: visit.last,
    now: now + m.AD_TOUCH_TTL_MS,
    search: '?utm_source=google&utm_medium=paid&gclid=renewed',
    landing: 'https://masterartist.co/trial/',
    referrer: '',
  });
  assert.equal(expired.wroteFirst, true);
  assert.equal(expired.wroteLast, true);
  assert.equal(expired.first.gclid, 'renewed');
  assert.equal(expired.first.utm_medium, 'paid');
  assert.equal(expired.first.referrer_host, '');
});

test('captureVisit writes localStorage and keeps the same keys', function () {
  const storage = memory();
  const now = Date.parse('2026-11-26T02:00:00Z');
  const visit = m.captureVisit({
    storage,
    now,
    search: '?gclid=store1&utm_source=google&utm_medium=cpc',
    landing: 'https://masterartist.co/',
    referrer: 'https://www.google.com/',
  });
  assert.equal(JSON.parse(storage.data[m.AD_FIRST_KEY]).gclid, 'store1');
  assert.equal(JSON.parse(storage.data[m.AD_LAST_KEY]).gclid, 'store1');
  const again = m.captureVisit({
    storage,
    now: now + 1000,
    search: '',
    landing: 'https://masterartist.co/about/',
    referrer: '',
  });
  assert.equal(again.wroteLast, false);
  assert.equal(again.last.gclid, 'store1');
});

test('google detection matches click ids and paid google utms only', function () {
  assert.equal(m.isGoogleAds({ gclid: 'abc' }), true);
  assert.equal(m.isGoogleAds({ gbraid: 'abc' }), true);
  assert.equal(m.isGoogleAds({ wbraid: 'abc' }), true);
  assert.equal(m.isGoogleAds({ gclid: '  ' }), false);
  assert.equal(m.isGoogleAds({ utm_source: 'google', utm_medium: 'cpc' }), true);
  assert.equal(m.isGoogleAds({ utm_source: 'Google', utm_medium: 'CPC' }), true);
  assert.equal(m.isGoogleAds({ utm_source: 'google', utm_medium: 'paid' }), true);
  assert.equal(m.isGoogleAds({ utm_source: 'google', utm_medium: 'ppc' }), true);
  assert.equal(m.isGoogleAds({ utm_source: 'google_ads', utm_medium: 'cpc' }), true);
  assert.equal(m.isGoogleAds({ utm_source: 'google', utm_medium: 'organic' }), false);
  assert.equal(m.isGoogleAds({ utm_source: 'google' }), false);
  assert.equal(m.isGoogleAds({ utm_source: 'facebook', utm_medium: 'cpc', fbclid: 'IwAR' }), false);
  assert.equal(m.isGoogleAds({ utm_source: 'instagram', fbclid: '1' }), false);
  assert.equal(m.isGoogleAds({ ttclid: 'tt.1' }), false);
  assert.equal(m.isGoogleAds(null), false);
  assert.equal(SUFFIX, 'utm_source=google&utm_medium=cpc&utm_campaign={campaignid}&utm_content={creative}&utm_term={keyword}&ma_adgroup={adgroupid}&ma_device={device}&ma_network={network}');
});

test('ref is Crockford base32, reused for 30 days', function () {
  assert.equal(m.CROCKFORD32.length, 32);
  for (const banned of ['I', 'L', 'O', 'U', 'i', 'l', 'o', 'u']) {
    assert.equal(m.CROCKFORD32.includes(banned), false);
  }
  for (let i = 0; i < 32; i++) {
    const code = m.crockfordCode([i, i, i, i, i, i]);
    assert.equal(code, m.CROCKFORD32[i].repeat(6));
    assert.match('G-' + code, m.GOOGLE_REF_RE);
  }
  assert.equal(m.crockfordCode([0, 1, 31, 32, 10, 255]), '01Z0AZ');
  const now = Date.parse('2026-11-26T02:00:00Z');
  const fresh = m.ensureGoogleRef({ stored: null, now, bytes: [0, 1, 31, 32, 10, 255] });
  assert.equal(fresh.ref, 'G-01Z0AZ');
  assert.equal(fresh.wrote, true);
  assert.equal(fresh.record.expires, now + m.AD_TOUCH_TTL_MS);
  const reused = m.ensureGoogleRef({ stored: fresh.record, now: now + 29 * 24 * 60 * 60 * 1000, bytes: [4, 4, 4, 4, 4, 4] });
  assert.equal(reused.ref, 'G-01Z0AZ');
  assert.equal(reused.wrote, false);
  const renewed = m.ensureGoogleRef({ stored: fresh.record, now: now + m.AD_TOUCH_TTL_MS, bytes: [2, 2, 2, 2, 2, 2] });
  assert.equal(renewed.ref, 'G-' + m.CROCKFORD32[2].repeat(6));
  assert.equal(renewed.wrote, true);
  for (let n = 0; n < 40; n++) {
    const ref = m.ensureGoogleRef({ stored: null, now, bytes: null }).ref;
    assert.match(ref, m.GOOGLE_REF_RE);
    assert.equal(/[ILOU]/.test(ref), false);
  }
});

test('prefill keeps existing text and adds one final ref line', function () {
  const now = Date.parse('2026-11-26T02:00:00Z');
  const visit = m.captureAdTouches({
    storedFirst: null, storedLast: null, now,
    search: '?gclid=Cj0&utm_source=google&utm_medium=cpc&utm_campaign=42',
    landing: 'https://masterartist.co/booking/?gclid=Cj0',
    referrer: 'https://www.google.com/',
  });
  const storage = memory();
  const existing = m.withRef("Hi, I'd like to book Textured Canvas on Thu 26 Nov. Source: google/42.", {
    gclid: 'Cj0', utm_source: 'google', utm_medium: 'cpc',
  });
  let posts = 0;
  const stamped = m.applyGoogleClick({
    storage, now, first: visit.first, last: visit.last, text: existing, bytes: [0, 1, 31, 32, 10, 255],
    transport() { posts += 1; throw new Error('network down'); },
  });
  assert.equal(posts, 1);
  assert.equal(stamped.text, "Ref: GG\nHi, I'd like to book Textured Canvas on Thu 26 Nov. Source: google/42.\n(ref G-01Z0AZ)");
  assert.equal(m.appendGoogleRef(stamped.text, stamped.ref), stamped.text);
  assert.equal(m.appendGoogleRef('', 'G-01Z0AZ'), '(ref G-01Z0AZ)');
  const href = m.buildWhatsAppHref('https://wa.me/60000000000?text=old', stamped.text);
  assert.equal(href.startsWith('https://wa.me/60102779426?text='), true);
  assert.equal(new URL(href).searchParams.get('text'), stamped.text);
  const api = m.buildWhatsAppHref('https://api.whatsapp.com/send?phone=15550001111&text=old', stamped.text);
  const apiUrl = new URL(api);
  assert.equal(apiUrl.hostname, 'api.whatsapp.com');
  assert.equal(apiUrl.searchParams.get('phone'), '60102779426');
  assert.equal(apiUrl.searchParams.get('text'), stamped.text);
});

test('non-google visitors keep their message and are not posted', function () {
  const now = Date.parse('2026-11-26T02:00:00Z');
  const fb = m.captureAdTouches({
    storedFirst: null, storedLast: null, now,
    search: '?utm_source=facebook&utm_medium=cpc&fbclid=IwAR',
    landing: 'https://masterartist.co/music.html?fbclid=IwAR',
    referrer: 'https://m.facebook.com/',
  });
  const text = m.withRef('Hi there', { fbclid: 'IwAR', utm_source: 'facebook' });
  assert.equal(text, 'Ref: FB\nHi there');
  let posted = false;
  const result = m.applyGoogleClick({
    storage: memory(), now, first: fb.first, last: fb.last, text, bytes: [1, 1, 1, 1, 1, 1],
    transport() { posted = true; },
  });
  assert.equal(posted, false);
  assert.equal(result.google, false);
  assert.equal(result.ref, '');
  assert.equal(result.payload, null);
  assert.equal(result.text, 'Ref: FB\nHi there');

  const googleFirst = m.captureAdTouches({
    storedFirst: null, storedLast: null, now,
    search: '?gclid=aaa&utm_source=google&utm_medium=cpc',
    landing: 'https://masterartist.co/?gclid=aaa',
    referrer: 'https://www.google.com/',
  });
  const tiktok = m.captureAdTouches({
    storedFirst: googleFirst.first, storedLast: googleFirst.last, now: now + 1000,
    search: '?ttclid=tiktok-click',
    landing: 'https://masterartist.co/?ttclid=tiktok-click',
    referrer: 'https://www.tiktok.com/',
  });
  assert.equal(tiktok.wroteFirst, false);
  assert.equal(tiktok.last.ttclid, 'tiktok-click');
  assert.equal(m.isGoogleAds(m.activeAdTouch(tiktok.first, tiktok.last, now + 1000)), false);
  const tiktokMsg = m.applyGoogleClick({
    storage: memory(), now: now + 1000, first: tiktok.first, last: tiktok.last, text: 'Source: site.',
    transport() { posted = true; },
  });
  assert.equal(posted, false);
  assert.equal(tiktokMsg.text, 'Source: site.');
});

test('ad-ref payload carries click ids and is not awaited', async function () {
  const now = Date.parse('2026-11-26T02:00:00Z');
  const first = m.captureAdTouches({
    storedFirst: null, storedLast: null, now,
    search: '?gclid=first&utm_source=google&utm_medium=cpc&utm_campaign=1',
    landing: 'https://masterartist.co/?gclid=first',
    referrer: 'https://www.google.com/',
  });
  const last = m.captureAdTouches({
    storedFirst: first.first, storedLast: first.last, now: now + 60000,
    search: '?gclid=last&gbraid=gb2&wbraid=wb2&utm_source=google&utm_medium=cpc&utm_campaign=2&utm_term=art&utm_content=cr&utm_id=9&ma_adgroup=7&ma_device=m&ma_network=g',
    landing: 'https://masterartist.co/workshops/textured-canvas/?gclid=last',
    referrer: 'https://www.google.com/aclk',
  });
  const storage = memory();
  let resolved = false;
  let payload = null;
  const result = m.applyGoogleClick({
    storage, now: now + 60000, first: last.first, last: last.last,
    text: 'Hi, I have a question about Master Artist. Source: google/2.',
    bytes: [0, 1, 31, 32, 10, 255],
    transport(_url, body) {
      payload = body;
      return new Promise(function (resolve) {
        setTimeout(function () { resolved = true; resolve(); }, 30);
      });
    },
  });
  assert.equal(resolved, false);
  assert.equal(result.ref, 'G-01Z0AZ');
  assert.equal(result.text.endsWith('\n(ref G-01Z0AZ)'), true);
  assert.equal(result.text.startsWith('Hi, I have a question about Master Artist. Source: google/2.'), true);
  assert.equal(payload.ref, 'G-01Z0AZ');
  assert.equal(payload.gclid, 'last');
  assert.equal(payload.gbraid, 'gb2');
  assert.equal(payload.wbraid, 'wb2');
  assert.equal(payload.utm_source, 'google');
  assert.equal(payload.utm_medium, 'cpc');
  assert.equal(payload.utm_campaign, '2');
  assert.equal(payload.utm_term, 'art');
  assert.equal(payload.utm_content, 'cr');
  assert.equal(payload.utm_id, '9');
  assert.equal(payload.ma_adgroup, '7');
  assert.equal(payload.ma_device, 'm');
  assert.equal(payload.ma_network, 'g');
  assert.equal(payload.landing_path, '/workshops/textured-canvas/');
  assert.equal(payload.referrer_host, 'www.google.com');
  assert.equal(payload.first_seen_at, first.first.seen_at);
  assert.equal(payload.clicked_at, '2026-11-26T02:01:00.000Z');
  for (const banned of ['fbclid', 'ttclid', 'phone', 'message', 'text', 'email']) {
    assert.equal(Object.prototype.hasOwnProperty.call(payload, banned), false);
  }
  assert.deepEqual(Object.keys(payload), [
    'ref', 'gclid', 'gbraid', 'wbraid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term',
    'utm_content', 'utm_id', 'ma_adgroup', 'ma_device', 'ma_network', 'landing_path', 'referrer_host',
    'first_seen_at', 'clicked_at',
  ]);
  await new Promise(function (resolve) { setTimeout(resolve, 40); });
  assert.equal(resolved, true);
});

test('post uses fetch keepalive and falls back without throwing', function () {
  const payload = { ref: 'G-01Z0AZ', gclid: 'abc' };
  let opts;
  m.dispatchAdRef(m.AD_REF_URL, payload, 'anon-test', {
    fetch(url, options) {
      opts = { url, options };
      return Promise.reject(new Error('404'));
    },
    sendBeacon() { throw new Error('fetch already ran'); },
  });
  assert.equal(opts.url, 'https://fudaosneozobacdalncv.supabase.co/functions/v1/ad-ref');
  assert.equal(opts.options.method, 'POST');
  assert.equal(opts.options.keepalive, true);
  assert.equal(opts.options.headers.apikey, 'anon-test');
  assert.equal(opts.options.headers.Authorization, 'Bearer anon-test');
  assert.equal(JSON.parse(opts.options.body).gclid, 'abc');

  let beaconUrl = '';
  assert.doesNotThrow(function () {
    m.dispatchAdRef(m.AD_REF_URL, payload, '', {
      fetch() { throw new Error('blocked'); },
      sendBeacon(url, body) { beaconUrl = url; assert.ok(body); },
    });
  });
  assert.equal(beaconUrl, m.AD_REF_URL);
  assert.doesNotThrow(function () {
    m.dispatchAdRef(m.AD_REF_URL, payload, '', {
      fetch() { throw new Error('blocked'); },
      sendBeacon() { throw new Error('blocked'); },
    });
  });
});
