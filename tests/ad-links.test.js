const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('module');
const requireEsm = createRequire(import.meta.url);

test('a Meta referral ad id wins over a ref code, and Google uses the ref', async function () {
  const { matchAdLink, extractAdRef, hideAdRef, suggestSession, trackingUrl } = await import('../attribution.mjs');
  const links = [
    { ad_id: '120210445566778', ref_code: 'MA-GB1129-M1', platform: 'meta', campaign_name: 'Children', target_type: 'session', target_id: 'children-2027' },
    { ad_id: 'g-99', ref_code: 'MA-GB1129-G1', platform: 'google', utm_campaign: 'gingerbread', target_type: 'session', target_id: 'gingerbread' },
    { ad_id: 'tt-1', ref_code: 'MA-GB1129-T1', platform: 'tiktok', target_type: 'session', target_id: 'children-2027' }
  ];
  const meta = matchAdLink({ sourceId: '120210445566778' }, links);
  assert.equal(meta.method, 'ad_referral');
  assert.equal(meta.link.ref_code, 'MA-GB1129-M1');
  const body = "Hi! I'm interested in Gingerbread Bake Lab [ref MA-GB1129-G1]";
  assert.equal(extractAdRef(body), 'MA-GB1129-G1');
  assert.equal(hideAdRef(body).includes('MA-GB1129'), false);
  const google = matchAdLink({ refCode: extractAdRef(body) }, links);
  assert.equal(google.method, 'ref_code');
  assert.equal(google.link.platform, 'google');
  const idea = suggestSession('Is the gingerbread class still open?', [{ id: 'gingerbread', title: 'Gingerbread Bake Lab' }, { id: 'paint', title: 'Canvas painting' }]);
  assert.equal(idea.target_id, 'gingerbread');
  assert.ok(idea.confidence > 0);
  const url = trackingUrl(links[1], 'https://masterartist.co/workshops/');
  assert.match(url, /utm_source=google/);
  assert.match(url, /ref=MA-GB1129-G1/);
});
