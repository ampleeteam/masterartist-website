/** Ad attribution and WhatsApp ref codes. No DOM.
 *
 * Two stores, on purpose:
 * - firstTouch / refCode / withRef: the existing 90-day first touch and the
 *   "Ref: FB|GG|WEB" line. Meta and other non-Google clicks keep that behaviour.
 * - captureAdTouches: 30-day first and last touch for the Google Ads CRM ref.
 *   A Google click appends "(ref G-XXXXXX)" and posts to the ad-ref function.
 */

export const ATTR_FIELDS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid',
];
export const ATTR_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Fields posted to the CRM. Click ids stay out of the Final URL suffix; auto-tagging adds them. */
export const AD_TOUCH_FIELDS = [
  'gclid', 'gbraid', 'wbraid',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'ma_adgroup', 'ma_device', 'ma_network',
];
/** Extra ids that mark a newer non-Google ad click so it is not labelled as Google. Not posted. */
const SIGNAL_FIELDS = AD_TOUCH_FIELDS.concat(['fbclid', 'ttclid']);

export const AD_TOUCH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const AD_REF_URL = 'https://fudaosneozobacdalncv.supabase.co/functions/v1/ad-ref';
export const STUDIO_WA = '60102779426';
export const AD_FIRST_KEY = 'ma_ad_first';
export const AD_LAST_KEY = 'ma_ad_last';
export const AD_REF_KEY = 'ma_ad_gref';
/** Crockford base32: digits plus A–Z without I, L, O, U. */
export const CROCKFORD32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const GOOGLE_REF_RE = /^G-[0-9A-HJKMNP-TV-Z]{6}$/;

const PAID_MEDIUMS = new Set(['cpc', 'paid', 'ppc']);

function sourceTokens(src) {
  return String(src || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function hasSource(src, names) {
  const tokens = sourceTokens(src);
  return names.some(name => tokens.includes(name));
}

function clip(value, max) {
  return String(value || '').trim().slice(0, max);
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
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
  return { touch, wrote: true };
}

/** Prefix a WhatsApp message with "Ref: FB|GG|WEB", replacing an old ref line. */
export function withRef(text, attr) {
  const ref = 'Ref: ' + refCode(attr);
  const body = String(text || '').replace(/^\s*Ref:\s*(?:FB|GG|WEB)\s*\n?/i, '').trim();
  return body ? ref + '\n' + body : ref;
}

function landingPath(landing) {
  const raw = String(landing || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw, 'https://masterartist.co').pathname.slice(0, 500);
  } catch {
    return raw.slice(0, 500);
  }
}

function referrerHost(referrer) {
  const raw = String(referrer || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).hostname.slice(0, 200);
  } catch {
    return '';
  }
}

function hasAdSignal(touch) {
  if (!touch || typeof touch !== 'object') return false;
  return SIGNAL_FIELDS.some(key => String(touch[key] || '').trim() !== '');
}

/** Google Ads: a click id, or utm_source=google with a paid medium (cpc, paid, ppc). */
export function isGoogleAds(attr) {
  if (!attr || typeof attr !== 'object') return false;
  if (clip(attr.gclid, 200) || clip(attr.gbraid, 200) || clip(attr.wbraid, 200)) return true;
  const medium = clip(attr.utm_medium, 40).toLowerCase();
  return hasSource(attr.utm_source, ['google']) && PAID_MEDIUMS.has(medium);
}

export function readAdTouch({ search, landing, referrer, now }) {
  const params = new URLSearchParams(search || '');
  const touch = {};
  for (const key of SIGNAL_FIELDS) touch[key] = clip(params.get(key) || '', 200);
  touch.landing_path = landingPath(landing);
  touch.referrer_host = referrerHost(referrer);
  touch.seen_at = new Date(now).toISOString();
  touch.expires = now + AD_TOUCH_TTL_MS;
  return touch;
}

/**
 * First touch is kept until it expires. Last touch updates when this landing
 * carries any tracked param (including fbclid / ttclid), and a later page with
 * no ad params does not wipe it. Both expire after 30 days.
 */
export function captureAdTouches({ storedFirst, storedLast, now, search, landing, referrer }) {
  const current = readAdTouch({ search, landing, referrer, now });
  const firstLive = storedFirst && typeof storedFirst === 'object' && Number(storedFirst.expires) > now;
  const lastLive = storedLast && typeof storedLast === 'object' && Number(storedLast.expires) > now;
  const wroteFirst = !firstLive;
  const wroteLast = !lastLive || hasAdSignal(current);
  return {
    first: wroteFirst ? clone(current) : storedFirst,
    last: wroteLast ? clone(current) : storedLast,
    wroteFirst,
    wroteLast,
  };
}

/** Last campaign if it is still live and has a signal; otherwise the first touch. */
export function activeAdTouch(first, last, now) {
  const lastLive = last && typeof last === 'object' && Number(last.expires) > now;
  const firstLive = first && typeof first === 'object' && Number(first.expires) > now;
  if (lastLive && hasAdSignal(last)) return last;
  if (firstLive && hasAdSignal(first)) return first;
  if (lastLive) return last;
  if (firstLive) return first;
  return null;
}

export function readStored(storage, key) {
  try {
    if (!storage || typeof storage.getItem !== 'function') return null;
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function captureVisit({ storage, now, search, landing, referrer }) {
  const captured = captureAdTouches({
    storedFirst: readStored(storage, AD_FIRST_KEY),
    storedLast: readStored(storage, AD_LAST_KEY),
    now, search, landing, referrer,
  });
  try {
    if (storage && captured.wroteFirst) storage.setItem(AD_FIRST_KEY, JSON.stringify(captured.first));
    if (storage && captured.wroteLast) storage.setItem(AD_LAST_KEY, JSON.stringify(captured.last));
  } catch { /* private mode */ }
  return captured;
}

/** Six Crockford characters from 6 bytes. Missing bytes count as 0. */
export function crockfordCode(bytes) {
  let out = '';
  const src = bytes || [];
  for (let i = 0; i < 6; i++) {
    const n = Number(src[i]);
    const idx = Number.isFinite(n) ? Math.trunc(Math.abs(n)) % 32 : 0;
    out += CROCKFORD32[idx];
  }
  return out;
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.getRandomValues === 'function') cryptoRef.getRandomValues(bytes);
  else for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

/** Reuse a stored G-XXXXXX until it expires; otherwise mint a new one. */
export function ensureGoogleRef({ stored, now, bytes }) {
  if (stored && GOOGLE_REF_RE.test(stored.ref) && Number(stored.expires) > now) {
    return { ref: stored.ref, record: stored, wrote: false };
  }
  const ref = 'G-' + crockfordCode(bytes && bytes.length ? bytes : randomBytes(6));
  const record = { ref, expires: now + AD_TOUCH_TTL_MS };
  return { ref, record, wrote: true };
}

/** Keep the existing prefill and put "(ref G-XXXXXX)" on its own final line. */
export function appendGoogleRef(text, ref) {
  if (!GOOGLE_REF_RE.test(ref)) return String(text ?? '');
  const line = '(ref ' + ref + ')';
  const body = String(text ?? '').replace(/\n*\(ref G-[0-9A-HJKMNP-TV-Z]{6}\)\s*$/i, '').replace(/[ \t]+$/g, '');
  return body ? body + '\n' + line : line;
}

export function adRefPayload({ ref, touch, firstSeenAt, clickedAt }) {
  const t = touch || {};
  const pick = key => clip(t[key], 200);
  return {
    ref: String(ref || ''),
    gclid: pick('gclid'),
    gbraid: pick('gbraid'),
    wbraid: pick('wbraid'),
    utm_source: pick('utm_source'),
    utm_medium: pick('utm_medium'),
    utm_campaign: pick('utm_campaign'),
    utm_term: pick('utm_term'),
    utm_content: pick('utm_content'),
    utm_id: pick('utm_id'),
    ma_adgroup: pick('ma_adgroup'),
    ma_device: pick('ma_device'),
    ma_network: pick('ma_network'),
    landing_path: String(t.landing_path || '').slice(0, 500),
    referrer_host: String(t.referrer_host || '').slice(0, 200),
    first_seen_at: String(firstSeenAt || ''),
    clicked_at: String(clickedAt || ''),
  };
}

/**
 * Append the Google ref when this visitor's active touch is Google Ads.
 * `transport` is called only for a real click. It is not awaited, and a throw
 * or a rejected promise does not escape.
 */
export function applyGoogleClick({ storage, now, first, last, text, bytes, transport }) {
  const touch = activeAdTouch(first, last, now);
  if (!isGoogleAds(touch)) {
    return { google: false, ref: '', text: String(text ?? ''), payload: null };
  }
  const ensured = ensureGoogleRef({ stored: readStored(storage, AD_REF_KEY), now, bytes });
  if (ensured.wrote && storage && typeof storage.setItem === 'function') {
    try { storage.setItem(AD_REF_KEY, JSON.stringify(ensured.record)); } catch { /* private mode */ }
  }
  const clickedAt = new Date(now).toISOString();
  const payload = adRefPayload({
    ref: ensured.ref,
    touch,
    firstSeenAt: (first && first.seen_at) || (touch && touch.seen_at) || clickedAt,
    clickedAt,
  });
  if (typeof transport === 'function') {
    try {
      const ret = transport(AD_REF_URL, payload);
      if (ret && typeof ret.catch === 'function') ret.catch(() => {});
    } catch { /* the WhatsApp click must proceed */ }
  }
  return { google: true, ref: ensured.ref, text: appendGoogleRef(text, ensured.ref), payload };
}

/** wa.me and api.whatsapp.com links always use the studio number. */
export function buildWhatsAppHref(existingHref, text) {
  const phone = STUDIO_WA;
  let host = 'wa.me';
  let extra = new URLSearchParams();
  try {
    const current = new URL(existingHref, 'https://masterartist.co');
    host = current.hostname.replace(/^www\./, '');
    extra = new URLSearchParams(current.search);
  } catch { /* fall back to wa.me */ }
  extra.delete('text');
  extra.delete('phone');
  const message = text == null ? '' : String(text);
  if (host === 'api.whatsapp.com') {
    const url = new URL('https://api.whatsapp.com/send');
    extra.forEach((value, key) => url.searchParams.append(key, value));
    url.searchParams.set('phone', phone);
    url.searchParams.set('text', message);
    return url.toString();
  }
  const tail = extra.toString();
  return 'https://wa.me/' + phone + '?text=' + encodeURIComponent(message) + (tail ? '&' + tail : '');
}

/**
 * Fire-and-forget POST. fetch keepalive can send the public anon key the other
 * Supabase calls use; sendBeacon cannot set that header, so it is only the fallback.
 * Neither path is awaited, and neither can throw to the click handler.
 */
export function dispatchAdRef(url, payload, anon, deps) {
  const body = JSON.stringify(payload);
  const fetchFn = deps && deps.fetch ? deps.fetch : (typeof fetch === 'function' ? fetch : null);
  const beacon = deps && deps.sendBeacon
    ? deps.sendBeacon
    : (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function'
      ? navigator.sendBeacon.bind(navigator)
      : null);
  if (fetchFn) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (anon) {
        headers.apikey = anon;
        headers.Authorization = 'Bearer ' + anon;
      }
      const ret = fetchFn(url, { method: 'POST', keepalive: true, headers, body });
      if (ret && typeof ret.catch === 'function') ret.catch(() => {});
      return;
    } catch { /* try the beacon */ }
  }
  try {
    if (typeof beacon === 'function') {
      const data = typeof Blob === 'function' ? new Blob([body], { type: 'application/json' }) : body;
      beacon(url, data);
    }
  } catch { /* ignore */ }
}
