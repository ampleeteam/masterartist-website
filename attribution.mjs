/** First-touch ad attribution and the WhatsApp ref code. No DOM. */

export const ATTR_FIELDS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'fbclid', 'wbraid', 'gbraid', 'ttclid',
];
export const ATTR_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function sourceTokens(src) {
  return String(src || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function hasSource(src, names) {
  const tokens = sourceTokens(src);
  return names.some(name => tokens.includes(name));
}

/** FB if fbclid or a facebook/instagram utm_source; else GG for gclid or google; else WEB. */
export function refCode(attr) {
  const src = attr && attr.utm_source;
  const fbSource = hasSource(src, ['facebook', 'instagram']);
  const ggSource = hasSource(src, ['google']);
  const fbClick = Boolean(attr && attr.fbclid);
  const ggClick = Boolean(attr && attr.gclid);
  if (fbClick && ggClick) {
    if (ggSource && !fbSource) return 'GG';
    return 'FB';
  }
  if (fbClick || fbSource) return 'FB';
  if (ggClick || ggSource) return 'GG';
  return 'WEB';
}

/**
 * Keep the first stored touch until it expires. `stored` is the parsed
 * localStorage value (or null). Returns the touch to keep and whether the
 * caller should write it.
 */
export function firstTouch({ stored, now, search, landing, referrer }) {
  if (stored && typeof stored === 'object' && Number(stored.expires) > now) {
    return { touch: stored, wrote: false };
  }
  const params = new URLSearchParams(search || '');
  const touch = { expires: now + ATTR_TTL_MS };
  for (const key of ATTR_FIELDS) touch[key] = (params.get(key) || '').slice(0, 200);
  touch.landing_page = String(landing || '').slice(0, 500);
  touch.referrer = String(referrer || '').slice(0, 500);
  const named = (params.get('ref') || '').trim();
  if (/^MA-[A-Z0-9-]{4,32}$/i.test(named)) touch.ad_ref = named.toUpperCase();
  return { touch, wrote: true };
}

const AD_REF = /\[ref\s+(MA-[A-Z0-9-]{4,32})\]/i;

/** The short code in a prefilled WhatsApp message, if a tracked link added one. */
export function extractAdRef(body) {
  const match = String(body || '').match(AD_REF);
  return match ? match[1].toUpperCase() : null;
}

/** Staff see the sentence without the tracking code. The code is shown as a badge. */
export function hideAdRef(body) {
  return String(body || '').replace(new RegExp(AD_REF.source, 'gi'), ' ').replace(/\s+/g, ' ').trim();
}

/** Append a campaign ref without dropping the existing Ref: FB|GG|WEB line. */
export function withAdRef(text, code) {
  const clean = String(text || '').replace(new RegExp(AD_REF.source, 'gi'), ' ').replace(/\s+/g, ' ').trim();
  if (!code) return clean;
  return (clean ? clean + ' ' : '') + '[ref ' + String(code).toUpperCase() + ']';
}

/** Prefix a WhatsApp message with "Ref: FB|GG|WEB", replacing an old ref line. */
export function withRef(text, attr) {
  const ref = 'Ref: ' + refCode(attr);
  const body = withAdRef(
    String(text || '').replace(/^\s*Ref:\s*(?:FB|GG|WEB)\s*\n?/i, '').trim(),
    attr && attr.ad_ref
  );
  return body ? ref + '\n' + body : ref;
}

/**
 * Match an inbound chat to one ad link. Many ads may share one target.
 * Order: Meta referral ad id, then the short ref code, then UTM campaign.
 */
export function matchAdLink(input, links) {
  const rows = links || [];
  const sourceId = input && (input.sourceId || input.adId);
  if (sourceId) {
    const hit = rows.find(row => row.ad_id && String(row.ad_id) === String(sourceId) && row.active !== false);
    if (hit) return { link: hit, method: 'ad_referral' };
  }
  const code = input && input.refCode;
  if (code) {
    const hit = rows.find(row => row.ref_code && String(row.ref_code).toUpperCase() === String(code).toUpperCase() && row.active !== false);
    if (hit) return { link: hit, method: 'ref_code' };
  }
  const utm = input && input.utmCampaign;
  if (utm) {
    const hit = rows.find(row => row.utm_campaign && String(row.utm_campaign).toLowerCase() === String(utm).toLowerCase() && row.active !== false);
    if (hit) return { link: hit, method: 'utm_click' };
  }
  return null;
}

/** Suggest an upcoming session from the first words. Staff still confirm it. */
export function suggestSession(text, sessions) {
  const hay = String(text || '').toLowerCase();
  let best = null;
  (sessions || []).forEach(session => {
    const words = String(session.title || '').toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 3);
    const hits = words.filter(word => hay.includes(word)).length;
    if (!hits) return;
    const confidence = Math.min(0.9, hits / Math.max(words.length, 1));
    if (!best || confidence > best.confidence) best = { target_id: session.id, title: session.title, confidence: Math.round(confidence * 100) / 100 };
  });
  return best;
}

/** Tracking URL for a platform. No account secrets. */
export function trackingUrl(link, landing) {
  const url = new URL(landing || link.landing_url || 'https://masterartist.co/');
  const platform = link.platform || 'other';
  const source = { meta: 'facebook', google: 'google', tiktok: 'tiktok' }[platform] || platform;
  url.searchParams.set('utm_source', source);
  url.searchParams.set('utm_medium', platform === 'google' ? 'cpc' : 'paid');
  if (link.utm_campaign || link.campaign_name) url.searchParams.set('utm_campaign', link.utm_campaign || link.campaign_name);
  if (link.utm_content || link.ad_name) url.searchParams.set('utm_content', link.utm_content || link.ad_name);
  if (link.ref_code) url.searchParams.set('ref', link.ref_code);
  return url.toString();
}
