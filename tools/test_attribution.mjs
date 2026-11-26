import assert from 'node:assert/strict';
import {
  firstTouch, refCode, withRef, ATTR_TTL_MS,
  AD_TOUCH_TTL_MS, STUDIO_WA, GOOGLE_REF_RE, CROCKFORD32,
  captureAdTouches, isGoogleAds, applyGoogleClick, appendGoogleRef, buildWhatsAppHref,
  crockfordCode, AD_REF_URL,
} from '../attribution.mjs';

const now = Date.parse('2026-10-16T00:00:00Z');

assert.equal(refCode({ fbclid: 'abc' }), 'FB');
assert.equal(refCode({ utm_source: 'Instagram' }), 'FB');
assert.equal(refCode({ utm_source: 'facebook_ads' }), 'FB');
assert.equal(refCode({ gclid: 'xyz' }), 'GG');
assert.equal(refCode({ utm_source: 'google' }), 'GG');
assert.equal(refCode({ utm_source: 'Google' }), 'GG');
assert.equal(refCode({}), 'WEB');
assert.equal(refCode({ utm_source: 'newsletter' }), 'WEB');
assert.equal(refCode({ fbclid: 'a', gclid: 'b', utm_source: 'google' }), 'GG');
assert.equal(refCode({ fbclid: 'a', gclid: 'b' }), 'FB');

assert.equal(withRef('Hi there', { fbclid: '1' }), 'Ref: FB\nHi there');
assert.equal(withRef('Ref: WEB\nHi there', { gclid: '1' }), 'Ref: GG\nHi there');
assert.equal(withRef('', {}), 'Ref: WEB');

const first = firstTouch({
  stored: null,
  now,
  search: '?utm_source=facebook&utm_medium=cpc&gclid=&fbclid=IwAR',
  landing: 'https://masterartist.co/music.html?utm_source=facebook&fbclid=IwAR',
  referrer: 'https://m.facebook.com/',
});
assert.equal(first.wrote, true);
assert.equal(first.touch.utm_source, 'facebook');
assert.equal(first.touch.utm_medium, 'cpc');
assert.equal(first.touch.fbclid, 'IwAR');
assert.equal(first.touch.expires, now + ATTR_TTL_MS);
assert.equal(refCode(first.touch), 'FB');

const again = firstTouch({
  stored: first.touch,
  now: now + 10 * 24 * 60 * 60 * 1000,
  search: '?utm_source=google&gclid=new',
  landing: 'https://masterartist.co/?gclid=new',
  referrer: 'https://www.google.com/',
});
assert.equal(again.wrote, false);
assert.equal(again.touch.utm_source, 'facebook');
assert.equal(again.touch.fbclid, 'IwAR');

const expired = firstTouch({
  stored: first.touch,
  now: now + ATTR_TTL_MS + 1,
  search: '?utm_source=google&gclid=later',
  landing: 'https://masterartist.co/pricing.html?gclid=later',
  referrer: '',
});
assert.equal(expired.wrote, true);
assert.equal(expired.touch.utm_source, 'google');
assert.equal(expired.touch.gclid, 'later');
assert.equal(expired.touch.landing_page, 'https://masterartist.co/pricing.html?gclid=later');
assert.equal(refCode(expired.touch), 'GG');

const day = 24 * 60 * 60 * 1000;
assert.equal(AD_TOUCH_TTL_MS, 30 * day);
assert.equal(STUDIO_WA, '60102779426');
assert.equal(CROCKFORD32.includes('I') || CROCKFORD32.includes('L') || CROCKFORD32.includes('O') || CROCKFORD32.includes('U'), false);
assert.equal(crockfordCode([0, 1, 31, 32, 10, 255]), '01Z0AZ');
assert.match('G-' + crockfordCode([0, 1, 31, 32, 10, 255]), GOOGLE_REF_RE);

const g0 = captureAdTouches({
  storedFirst: null, storedLast: null, now,
  search: '?utm_source=google&utm_medium=cpc&utm_campaign=111&utm_content=222&utm_term=piano&utm_id=333&ma_adgroup=444&ma_device=m&ma_network=g&gclid=Cj0&gbraid=gb&wbraid=wb',
  landing: 'https://masterartist.co/workshops/bake-lab/?gclid=Cj0',
  referrer: 'https://www.google.com/aclk?sa=l',
});
assert.equal(g0.wroteFirst, true);
assert.equal(g0.wroteLast, true);
assert.equal(g0.first.gclid, 'Cj0');
assert.equal(g0.first.gbraid, 'gb');
assert.equal(g0.first.wbraid, 'wb');
assert.equal(g0.first.utm_source, 'google');
assert.equal(g0.first.utm_medium, 'cpc');
assert.equal(g0.first.ma_adgroup, '444');
assert.equal(g0.first.landing_path, '/workshops/bake-lab/');
assert.equal(g0.first.referrer_host, 'www.google.com');
assert.equal(g0.first.expires, now + AD_TOUCH_TTL_MS);
assert.equal(isGoogleAds(g0.last), true);

const g1 = captureAdTouches({
  storedFirst: g0.first, storedLast: g0.last, now: now + 5 * day,
  search: '?gclid=second&utm_source=google&utm_medium=cpc',
  landing: 'https://masterartist.co/trial/?gclid=second',
  referrer: 'https://googleads.g.doubleclick.net/aclk',
});
assert.equal(g1.wroteFirst, false);
assert.equal(g1.wroteLast, true);
assert.equal(g1.first.gclid, 'Cj0');
assert.equal(g1.last.gclid, 'second');
assert.equal(g1.last.landing_path, '/trial/');

const quiet = captureAdTouches({
  storedFirst: g1.first, storedLast: g1.last, now: now + 5 * day + 1000,
  search: '', landing: 'https://masterartist.co/prices/', referrer: '',
});
assert.equal(quiet.wroteLast, false);
assert.equal(quiet.last.gclid, 'second');

assert.equal(isGoogleAds({ gclid: 'x' }), true);
assert.equal(isGoogleAds({ gbraid: 'x' }), true);
assert.equal(isGoogleAds({ wbraid: 'x' }), true);
assert.equal(isGoogleAds({ utm_source: 'google', utm_medium: 'cpc' }), true);
assert.equal(isGoogleAds({ utm_source: 'Google', utm_medium: 'PAID' }), true);
assert.equal(isGoogleAds({ utm_source: 'google', utm_medium: 'ppc' }), true);
assert.equal(isGoogleAds({ utm_source: 'google', utm_medium: 'organic' }), false);
assert.equal(isGoogleAds({ utm_source: 'google' }), false);
assert.equal(isGoogleAds({ utm_source: 'facebook', utm_medium: 'cpc', fbclid: 'IwAR' }), false);
assert.equal(isGoogleAds({ ttclid: 'tt' }), false);
assert.equal(isGoogleAds({}), false);

const store = {
  data: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this.data, k) ? this.data[k] : null; },
  setItem(k, v) { this.data[k] = String(v); },
};
const prefill = 'Hi, I\'d like to book the RM50 trial. Source: google/111.';
const stamped = applyGoogleClick({
  storage: store, now, first: g0.first, last: g0.last, text: prefill, bytes: [0, 1, 31, 32, 10, 255],
  transport() { throw new Error('crm down'); },
});
assert.equal(stamped.google, true);
assert.equal(stamped.ref, 'G-01Z0AZ');
assert.equal(stamped.text, prefill + '\n(ref G-01Z0AZ)');
assert.equal(stamped.payload.gclid, 'Cj0');
assert.equal(stamped.payload.gbraid, 'gb');
assert.equal(stamped.payload.wbraid, 'wb');
assert.equal(stamped.payload.utm_campaign, '111');
assert.equal(stamped.payload.ma_device, 'm');
assert.equal(stamped.payload.landing_path, '/workshops/bake-lab/');
assert.equal(stamped.payload.referrer_host, 'www.google.com');
assert.equal(stamped.payload.first_seen_at, g0.first.seen_at);
assert.equal('fbclid' in stamped.payload, false);
assert.equal('phone' in stamped.payload, false);
const againRef = applyGoogleClick({
  storage: store, now: now + day, first: g0.first, last: g0.last, text: prefill, bytes: [9, 9, 9, 9, 9, 9],
});
assert.equal(againRef.ref, 'G-01Z0AZ');
assert.equal(appendGoogleRef(stamped.text, stamped.ref), stamped.text);
assert.equal(withRef('Hi there', { fbclid: '1' }), 'Ref: FB\nHi there');
const fbOnly = applyGoogleClick({
  storage: store, now, first: first.touch, last: first.touch, text: 'Ref: FB\nHi there', bytes: [1, 1, 1, 1, 1, 1],
  transport() { throw new Error('should not post'); },
});
assert.equal(fbOnly.google, false);
assert.equal(fbOnly.text, 'Ref: FB\nHi there');
const href = buildWhatsAppHref('https://wa.me/60000000000?text=Hi', stamped.text);
assert.equal(href.startsWith('https://wa.me/' + STUDIO_WA + '?text='), true);
assert.equal(new URL(href).searchParams.get('text'), stamped.text);
assert.equal(AD_REF_URL, 'https://fudaosneozobacdalncv.supabase.co/functions/v1/ad-ref');

console.log('attribution tests passed');
