// Port of Atrium commit 886cb5b, single studio. No organisation or workspace id.
// Pure functions. The edge functions call these. Nothing here sends a message.

import { createHmac, timingSafeEqual } from "node:crypto";

export const INTENTS = [
  "class_enquiry",
  "booking",
  "pricing",
  "schedule",
  "student_support",
  "complaint",
  "partnership",
  "general",
];

export const ENROLMENT_STATUSES = ["enquired", "interested", "enrolled", "paid", "attended", "cancelled"];
const COUNTED = ["enrolled", "paid", "attended"];

export const CASE_STATUSES = ["new", "open", "pending", "resolved", "closed"];
const CASE_NEXT = {
  new: ["open", "pending", "resolved", "closed"],
  open: ["pending", "resolved", "closed"],
  pending: ["open", "resolved", "closed"],
  resolved: ["open", "closed"],
  closed: ["open"],
};

export const DEFAULT_HOURS = {
  mon: { start: "10:00", end: "19:00" },
  tue: { start: "10:00", end: "19:00" },
  wed: { start: "10:00", end: "19:00" },
  thu: { start: "10:00", end: "19:00" },
  fri: { start: "10:00", end: "19:00" },
  sat: { start: "19:30", end: "24:00" },
  sun: { start: "10:00", end: "19:00" },
};

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const weekdayMap = { Sun: "sun", Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat" };
const REF_PATTERN = /\bref:\s*([a-z0-9][a-z0-9-]{1,40})\b/i;
const BANNED = /sip and paint|cheaper than|\bhrdc\b|plant-based|plant based/i;

const intentRules = [
  { intent: "complaint", pattern: /\b(complaint|refund|unhappy|terrible|manager|worst)\b/i },
  { intent: "partnership", pattern: /\b(partner|partnership|collaborat|sponsor|collab)\b/i },
  { intent: "student_support", pattern: /\b(existing student|already enrolled|my child is in|current class|current student)\b/i },
  { intent: "pricing", pattern: /\b(price|pricing|how much|fee|fees|cost|rm\s?\d)\b/i },
  { intent: "booking", pattern: /\b(book|enrol|enroll|register|sign up|reserve a place|hold a spot)\b/i },
  { intent: "schedule", pattern: /\b(schedule|what time|which day|timetable|when does)\b/i },
  { intent: "class_enquiry", pattern: /\b(class|classes|workshop|camp|course|lesson|programme|program)\b/i },
];

function str(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asRecord(value) {
  return value && typeof value === "object" ? value : null;
}

function minutes(value) {
  const [h, m] = String(value).split(":").map((part) => Number(part));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

export function extractRefCode(body) {
  const match = String(body || "").match(REF_PATTERN);
  return match ? match[1].toLowerCase() : null;
}

export function parseReferral(message) {
  if (!message) return null;
  const referral = message.referral;
  if (!referral || typeof referral !== "object") return null;
  const mediaType = str(referral.media_type);
  const mediaUrl = str(referral.image_url) || str(referral.video_url) || str(referral.thumbnail_url) || str(referral.media_url);
  const parsed = {
    sourceType: str(referral.source_type),
    sourceId: str(referral.source_id),
    sourceUrl: str(referral.source_url),
    headline: str(referral.headline),
    body: str(referral.body),
    mediaType,
    mediaUrl,
    ctwaClid: str(referral.ctwa_clid),
  };
  return Object.values(parsed).some(Boolean) ? parsed : null;
}

export function adLabel(headlineOrOffer) {
  return headlineOrOffer ? `From ad: ${headlineOrOffer}` : "From ad";
}
export function refLabel(pointLabel, code) {
  return pointLabel ? `From ${pointLabel}` : `From ref: ${code}`;
}
export function directLabel() {
  return "Direct / organic";
}
export function callLabel(kind) {
  return kind === "whatsapp_call" ? "WhatsApp call" : "Phone call";
}

export function isIntent(value) {
  return INTENTS.includes(value);
}

export function suggestIntent(input) {
  const haystack = [input.body, input.headline, input.offerName].filter(Boolean).join("\n");
  for (const rule of intentRules) {
    if (rule.pattern.test(haystack)) return rule.intent;
  }
  if (input.entryKind === "ad" || input.offerName) return "class_enquiry";
  return "general";
}

export async function classifyIntent(input, provider) {
  const fallback = suggestIntent(input);
  if (!provider) return fallback;
  try {
    const text = await provider.draftReply({
      orgName: input.orgName || "Master Artist",
      knowledgeBase: [
        "Classify the customer's reason for writing.",
        `Reply with exactly one of these words and nothing else: ${INTENTS.join(", ")}.`,
        input.offerName ? `The message is tied to this offer: ${input.offerName}.` : "",
        input.headline ? `Ad headline: ${input.headline}` : "",
      ].filter(Boolean).join("\n"),
      contactName: "Customer",
      messages: [{ direction: "inbound", body: input.body || input.headline || "Hello" }],
    });
    const token = String(text).trim().toLowerCase().split(/\s+/)[0]?.replace(/[^a-z_]/g, "");
    if (token && isIntent(token)) return token;
    return fallback;
  } catch {
    return fallback;
  }
}

export function normalizeCallStatus(raw, duration) {
  const value = String(raw || "").toLowerCase();
  if (value.includes("miss") || value.includes("no_answer") || value.includes("unanswered")) return "missed";
  if (value.includes("declin") || value.includes("reject")) return "declined";
  if (value.includes("fail")) return "failed";
  if (value.includes("ring")) return "ringing";
  if (value.includes("connect") || value.includes("answer") || value.includes("accept")) return "answered";
  if ((value.includes("terminat") || value.includes("complet") || value.includes("end")) && (duration === 0 || duration === null)) {
    return duration === 0 ? "missed" : "completed";
  }
  if (value.includes("terminat") || value.includes("complet") || value.includes("end") || value.includes("hang")) return "completed";
  return "completed";
}

export function parseCalls(body) {
  const root = asRecord(body);
  if (!root || root.object !== "whatsapp_business_account") return [];
  const events = [];
  const entries = Array.isArray(root.entry) ? root.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(asRecord(entry)?.changes) ? asRecord(entry).changes : [];
    for (const change of changes) {
      const value = asRecord(asRecord(change)?.value);
      if (!value) continue;
      const metadata = asRecord(value.metadata);
      const phoneNumberId = metadata?.phone_number_id ? String(metadata.phone_number_id) : "";
      if (!phoneNumberId) continue;
      const names = new Map();
      for (const contact of Array.isArray(value.contacts) ? value.contacts : []) {
        const record = asRecord(contact);
        const profile = asRecord(record?.profile);
        if (record?.wa_id && profile?.name) names.set(String(record.wa_id), String(profile.name));
      }
      for (const call of Array.isArray(value.calls) ? value.calls : []) {
        const record = asRecord(call);
        if (!record?.id) continue;
        const directionRaw = String(record.direction || "USER_INITIATED").toUpperCase();
        const direction = directionRaw.includes("BUSINESS") || directionRaw === "OUTBOUND" ? "outbound" : "inbound";
        const waId = String((direction === "inbound" ? record.from : record.to) || record.from || record.to || "");
        if (!waId) continue;
        const durationRaw = record.duration ?? record.duration_seconds;
        const duration = durationRaw == null || durationRaw === "" ? null : Number(durationRaw);
        const durationSeconds = duration != null && Number.isFinite(duration) ? Math.max(0, Math.round(duration)) : null;
        events.push({
          phoneNumberId,
          callId: String(record.id),
          waId,
          name: names.get(waId),
          direction,
          status: normalizeCallStatus(String(record.status || record.event || "completed"), durationSeconds),
          durationSeconds,
          timestamp: String(record.timestamp || record.start_time || ""),
        });
      }
    }
  }
  return events;
}

export function describeCall(input) {
  const who = input.direction === "outbound" ? "Outgoing" : "Incoming";
  const channel = input.kind === "phone_call" ? "phone call" : "WhatsApp call";
  const duration = input.durationSeconds && input.durationSeconds > 0
    ? input.durationSeconds < 60
      ? `${input.durationSeconds}s`
      : `${Math.floor(input.durationSeconds / 60)}m ${input.durationSeconds % 60}s`
    : null;
  return [who, channel, String(input.status).replaceAll("_", " "), duration].filter(Boolean).join(" · ");
}

export function isWithinBusinessHours(date, timeZone, hours) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "Mon";
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  const key = weekdayMap[weekday] ?? "mon";
  const window = hours[key];
  if (!window) return false;
  const start = minutes(window.start);
  const end = minutes(window.end);
  if (start == null || end == null) return false;
  const nowMinutes = hour * 60 + minute;
  return nowMinutes >= start && nowMinutes < end;
}

export function parseHours(value) {
  const source = value && typeof value === "object" ? value : {};
  const hours = { ...DEFAULT_HOURS };
  for (const day of Object.keys(hours)) {
    if (!(day in source)) continue;
    const raw = source[day];
    if (raw == null) {
      hours[day] = null;
      continue;
    }
    if (typeof raw === "object" && raw && "start" in raw && "end" in raw) {
      hours[day] = { start: String(raw.start), end: String(raw.end) };
    }
  }
  return hours;
}

export function sabbathClosed(date, timeZone) {
  return !isWithinBusinessHours(date, timeZone, DEFAULT_HOURS) && weekdayIn(date, timeZone, ["fri", "sat"]);
}

function weekdayIn(date, timeZone, keys) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).formatToParts(date);
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "Mon";
  return keys.includes(weekdayMap[weekday] || "");
}

export function matchKeyword(body, rules) {
  const haystack = String(body || "").toLowerCase();
  for (const rule of rules || []) {
    if (rule.enabled === false || rule.active === false) continue;
    const needle = String(rule.keyword || rule.phrase || "").trim().toLowerCase();
    if (!needle) continue;
    if (haystack.includes(needle)) return rule;
  }
  return null;
}

export function nextRoundRobin(members, lastUserId) {
  const list = (members || []).filter(Boolean);
  if (!list.length) return null;
  const index = list.findIndex((id) => id === lastUserId);
  return list[(index + 1) % list.length];
}

// Next staff member for a new chat. Staff marked off duty are skipped; staff with
// no duty row count as on duty, so the rota works before anyone fills it in.
export function pickAssignee(activeIds, dutyRows, lastUserId) {
  const off = new Set((dutyRows || []).filter((row) => row && row.on_duty === false).map((row) => row.staff_id));
  return nextRoundRobin((activeIds || []).filter((id) => id && !off.has(id)), lastUserId);
}

export function isEnrolmentStatus(value) {
  return ENROLMENT_STATUSES.includes(value);
}

export function seatsLeft(capacity, enrolled) {
  if (capacity == null) return null;
  return Math.max(0, Number(capacity) - Number(enrolled || 0));
}

export function enrolmentStamp(current, status, now) {
  const counted = COUNTED.includes(status);
  return {
    status,
    isCurrent: true,
    enrolledAt: counted ? (current && current.enrolledAt) || now.toISOString() : (current && current.enrolledAt) || null,
  };
}

export function linkEnrolment(existing, input) {
  const status = input.status || "enquired";
  const prior = existing || {};
  return {
    sessionId: input.sessionId,
    contactId: input.contactId,
    conversationId: prior.conversationId || input.conversationId || null,
    status: prior.status && !input.status ? prior.status : status,
    isCurrent: true,
    entryKind: prior.entryKind || input.entryKind || null,
    entryLabel: prior.entryLabel || input.entryLabel || null,
    sourceId: prior.sourceId || input.sourceId || null,
    refCode: prior.refCode || input.refCode || null,
    ctwaClid: prior.ctwaClid || input.ctwaClid || null,
    campaignName: prior.campaignName || input.campaignName || null,
    enrolledAt: COUNTED.includes(status) ? prior.enrolledAt || new Date().toISOString() : prior.enrolledAt || null,
  };
}

export function canTransition(from, to) {
  if (from === to) return { ok: false, reason: `The case is already ${from}.` };
  const next = CASE_NEXT[from] || [];
  if (!next.includes(to)) return { ok: false, reason: `A ${from} case cannot move to ${to}.` };
  return { ok: true };
}

export function statusTimestamps(from, to, now, existing) {
  const current = existing || { resolved_at: null, closed_at: null };
  if (to === "resolved") return { resolved_at: current.resolved_at ?? now, closed_at: null };
  if (to === "closed") return { resolved_at: current.resolved_at ?? now, closed_at: current.closed_at ?? now };
  if (from === "resolved" || from === "closed") return { resolved_at: null, closed_at: null };
  return {};
}

export function withinServiceWindow(lastInboundAt, now = new Date()) {
  if (!lastInboundAt) return false;
  const then = lastInboundAt instanceof Date ? lastInboundAt : new Date(lastInboundAt);
  if (Number.isNaN(then.getTime())) return false;
  return now.getTime() - then.getTime() < 24 * 60 * 60 * 1000;
}

export function verifySignature(rawBody, header, secret) {
  if (!header || !secret) return false;
  const provided = header.startsWith("sha256=") ? header.slice("sha256=".length) : header;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

export function signBody(rawBody, secret) {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

export function verifySubscription(input) {
  if (input.mode !== "subscribe" || !input.challenge || !input.expectedToken || !input.token) return { ok: false };
  const a = Buffer.from(input.token);
  const b = Buffer.from(input.expectedToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false };
  return { ok: true, challenge: input.challenge };
}

export function phoneFromWaId(waId) {
  return /^\d{8,15}$/.test(String(waId || "")) ? String(waId) : null;
}

function textOf(message) {
  const type = String(message.type ?? "unknown");
  if (type === "text") {
    const text = asRecord(message.text);
    return { kind: "text", body: String(text?.body ?? "") };
  }
  const mediaTypes = ["image", "audio", "video", "document", "sticker"];
  if (mediaTypes.includes(type)) {
    const media = asRecord(message[type]);
    const caption = media?.caption ? String(media.caption) : "";
    const filename = media?.filename ? String(media.filename) : "";
    const fallback = type === "audio" ? "Voice message" : type === "image" ? "Photo" : type === "video" ? "Video" : filename || "Document";
    return {
      kind: "media",
      body: caption || fallback,
      mediaType: media?.mime_type ? String(media.mime_type) : type,
      waMediaId: media?.id ? String(media.id) : undefined,
    };
  }
  if (type === "button") return { kind: "text", body: String(asRecord(message.button)?.text ?? "Button reply") };
  if (type === "interactive") {
    const interactive = asRecord(message.interactive);
    const button = asRecord(interactive?.button_reply);
    const list = asRecord(interactive?.list_reply);
    return { kind: "text", body: String(button?.title ?? list?.title ?? "Interactive reply") };
  }
  if (type === "reaction") return { kind: "text", body: String(asRecord(message.reaction)?.emoji ?? "Reaction") };
  return { kind: "text", body: type === "unknown" ? "" : `[${type}]` };
}

export function parseWebhook(body) {
  const root = asRecord(body);
  if (!root || root.object !== "whatsapp_business_account") return [];
  const events = [];
  for (const entry of Array.isArray(root.entry) ? root.entry : []) {
    for (const change of Array.isArray(asRecord(entry)?.changes) ? asRecord(entry).changes : []) {
      const value = asRecord(asRecord(change)?.value);
      if (!value) continue;
      const metadata = asRecord(value.metadata);
      const phoneNumberId = metadata?.phone_number_id ? String(metadata.phone_number_id) : "";
      if (!phoneNumberId) continue;
      const names = new Map();
      for (const contact of Array.isArray(value.contacts) ? value.contacts : []) {
        const record = asRecord(contact);
        const profile = asRecord(record?.profile);
        if (record?.wa_id && profile?.name) names.set(String(record.wa_id), String(profile.name));
      }
      for (const message of Array.isArray(value.messages) ? value.messages : []) {
        const record = asRecord(message);
        if (!record?.id || !record.from) continue;
        const waId = String(record.from);
        events.push({
          type: "message",
          phoneNumberId,
          waMessageId: String(record.id),
          waId,
          name: names.get(waId),
          timestamp: String(record.timestamp ?? ""),
          referral: parseReferral(record),
          ...textOf(record),
        });
      }
      for (const status of Array.isArray(value.statuses) ? value.statuses : []) {
        const record = asRecord(status);
        if (!record?.id || !record.status) continue;
        const state = String(record.status);
        if (!["sent", "delivered", "read", "failed"].includes(state)) continue;
        const first = asRecord((Array.isArray(record.errors) ? record.errors : [])[0]);
        events.push({
          type: "status",
          phoneNumberId,
          waMessageId: String(record.id),
          status: state,
          timestamp: String(record.timestamp ?? ""),
          error: first?.title ? String(first.title) : first?.message ? String(first.message) : undefined,
        });
      }
    }
  }
  return events;
}

export function resolveEntry(input, catalog) {
  const ads = (catalog && catalog.ads) || [];
  const refs = (catalog && catalog.refs) || [];
  const referral = input.referral;
  if (referral && (referral.sourceId || referral.ctwaClid || referral.headline || referral.sourceType)) {
    const mapped = referral.sourceId ? ads.find((row) => row.sourceId === referral.sourceId) : null;
    const named = !mapped && referral.headline
      ? ads.find((row) => row.sessionTitle && row.sessionTitle.toLowerCase() === referral.headline.toLowerCase())
      : null;
    const sessionTitle = (mapped && mapped.sessionTitle) || (named && named.sessionTitle) || null;
    const headline = referral.headline || (mapped && mapped.headline) || sessionTitle;
    const intent = suggestIntent({ body: input.body, headline, offerName: sessionTitle, entryKind: "ad" });
    return {
      kind: "ad",
      label: adLabel(sessionTitle || headline),
      sourceType: referral.sourceType,
      sourceId: referral.sourceId,
      sourceUrl: referral.sourceUrl,
      headline,
      referralBody: referral.body,
      mediaType: referral.mediaType,
      mediaUrl: referral.mediaUrl,
      ctwaClid: referral.ctwaClid,
      refCode: null,
      campaignName: (mapped && mapped.campaignName) || null,
      sessionId: (mapped && mapped.sessionId) || (named && named.sessionId) || null,
      sessionTitle,
      intent,
    };
  }
  if (input.refCode) {
    const point = refs.find((row) => String(row.code).toLowerCase() === String(input.refCode).toLowerCase());
    const intent = suggestIntent({ body: input.body, offerName: point && point.sessionTitle, entryKind: "ref" });
    return {
      kind: "ref",
      label: refLabel(point ? point.label : null, input.refCode),
      sourceType: "ref",
      sourceId: null,
      sourceUrl: null,
      headline: null,
      referralBody: null,
      mediaType: null,
      mediaUrl: null,
      ctwaClid: null,
      refCode: input.refCode,
      campaignName: null,
      sessionId: point ? point.sessionId : null,
      sessionTitle: point ? point.sessionTitle : null,
      intent,
    };
  }
  return {
    kind: "direct",
    label: directLabel(),
    sourceType: null,
    sourceId: null,
    sourceUrl: null,
    headline: null,
    referralBody: null,
    mediaType: null,
    mediaUrl: null,
    ctwaClid: null,
    refCode: null,
    campaignName: null,
    sessionId: null,
    sessionTitle: null,
    intent: suggestIntent({ body: input.body, entryKind: "direct" }),
  };
}

export function applyAttribution(existing, entry) {
  if (existing && existing.attributedAt) return existing;
  return {
    ...(existing || {}),
    entryKind: entry.kind,
    entryLabel: entry.label,
    sourceType: entry.sourceType,
    sourceId: entry.sourceId,
    sourceUrl: entry.sourceUrl,
    headline: entry.headline,
    referralBody: entry.referralBody,
    mediaType: entry.mediaType,
    mediaUrl: entry.mediaUrl,
    ctwaClid: entry.ctwaClid,
    refCode: entry.refCode,
    campaignName: entry.campaignName,
    sessionId: entry.sessionId,
    intent: entry.intent,
    attributedAt: new Date().toISOString(),
  };
}

export function automationDecision(input) {
  const hours = parseHours(input.hours || DEFAULT_HOURS);
  const openNow = isWithinBusinessHours(input.now, input.timeZone || "Asia/Kuala_Lumpur", hours);
  const out = [];
  if (!openNow && input.awayEnabled && input.awayMessage) {
    const awayAt = input.awaySentAt ? new Date(input.awaySentAt).getTime() : 0;
    if (input.now.getTime() - awayAt > 12 * 60 * 60 * 1000) out.push({ kind: "away", body: input.awayMessage });
  } else if (openNow && input.greetingEnabled && input.greetingMessage && !input.greetingSentAt) {
    out.push({ kind: "greeting", body: input.greetingMessage });
  }
  const matched = matchKeyword(input.body, input.rules || []);
  if (matched && (matched.reply || matched.body)) out.push({ kind: "keyword", body: matched.reply || matched.body, rule: matched });
  return { openNow, messages: out };
}

export function draftSystemPrompt(input) {
  return [
    `You draft WhatsApp replies for ${input.orgName || "Master Artist"}.`,
    "Write one short reply the agent can edit. Do not invent prices, promises, or policies that are not in the knowledge base.",
    "Use a warm, plain tone. No markdown, no sign-off with a fake human name.",
    "Never write “sip and paint”, “cheaper than”, HRDC, or “plant-based”.",
    input.knowledgeBase && String(input.knowledgeBase).trim()
      ? `Knowledge base:\n${String(input.knowledgeBase).trim()}`
      : "The studio has not written a knowledge base yet. Draft a careful reply that asks for the missing detail.",
  ].join("\n\n");
}

export function reviewDraft(text) {
  if (!text || !String(text).trim()) return { ok: false, reason: "The model returned an empty draft" };
  if (BANNED.test(text)) return { ok: false, reason: "That draft uses a phrase we do not say." };
  return { ok: true, text: String(text).trim() };
}

export function textPayload(to, body) {
  return { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: false, body } };
}

export { BANNED, DAY_KEYS };
