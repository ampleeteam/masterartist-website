import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyAttribution,
  automationDecision,
  canTransition,
  classifyIntent,
  describeCall,
  enrolmentStamp,
  extractRefCode,
  isWithinBusinessHours,
  linkEnrolment,
  matchKeyword,
  nextRoundRobin,
  parseCalls,
  parseReferral,
  parseWebhook,
  phoneFromWaId,
  resolveEntry,
  reviewDraft,
  seatsLeft,
  signBody,
  statusTimestamps,
  suggestIntent,
  verifySignature,
  verifySubscription,
  withinServiceWindow,
} from "../supabase/functions/_shared/atrium-port.mjs";

const secret = "test-app-secret";
const catalog = {
  ads: [{
    sourceId: "120210445566778",
    sessionId: "children-2027",
    sessionTitle: "Children's Art Class – 10 sessions",
    campaignName: "Children Jan",
    headline: "Children's Art Class – 10 sessions",
  }],
  refs: [{
    code: "ig-bio",
    label: "Instagram bio",
    sessionId: "children-2027",
    sessionTitle: "Children's Art Class – 10 sessions",
  }],
};

const referralPayload = {
  object: "whatsapp_business_account",
  entry: [{
    changes: [{
      value: {
        metadata: { phone_number_id: "sim-ma-1001" },
        contacts: [{ profile: { name: "Hana Parent" }, wa_id: "60173334444" }],
        messages: [{
          from: "60173334444",
          id: "wamid.ad.1",
          timestamp: "1710002222",
          type: "text",
          text: { body: "Is the Saturday class still open?" },
          referral: {
            source_url: "https://fb.me/master-artist-children",
            source_id: "120210445566778",
            source_type: "ad",
            headline: "Children's Art Class – 10 sessions",
            body: "Ten Saturday mornings in Bangsar for ages 6 to 10.",
            media_type: "image",
            image_url: "https://example.com/children-art-class.jpg",
            ctwa_clid: "ARtest-ctwa-clid",
          },
        }],
      },
    }],
  }],
};

describe("webhook verification", () => {
  it("accepts the Meta subscribe challenge when the verify token matches", () => {
    assert.deepEqual(verifySubscription({
      mode: "subscribe", token: "desk-token", challenge: "12345", expectedToken: "desk-token",
    }), { ok: true, challenge: "12345" });
  });

  it("rejects a wrong verify token, a missing challenge, and a non-subscribe mode", () => {
    assert.equal(verifySubscription({ mode: "subscribe", token: "nope", challenge: "1", expectedToken: "desk-token" }).ok, false);
    assert.equal(verifySubscription({ mode: "subscribe", token: "desk-token", challenge: null, expectedToken: "desk-token" }).ok, false);
    assert.equal(verifySubscription({ mode: "unsubscribe", token: "desk-token", challenge: "1", expectedToken: "desk-token" }).ok, false);
  });

  it("checks the X-Hub-Signature-256 header against the raw body", () => {
    const raw = JSON.stringify({ object: "whatsapp_business_account" });
    assert.equal(verifySignature(raw, signBody(raw, secret), secret), true);
    assert.equal(verifySignature(raw, signBody(`${raw} `, secret), secret), false);
    assert.equal(verifySignature(raw, null, secret), false);
    assert.equal(verifySignature(raw, "sha256=abc", secret), false);
  });
});

describe("webhook parsing", () => {
  const payload = {
    object: "whatsapp_business_account",
    entry: [{
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "60322011188", phone_number_id: "sim-ma-1001" },
          contacts: [{ profile: { name: "Farah Ismail" }, wa_id: "60111222333" }],
          messages: [{ from: "60111222333", id: "wamid.1", timestamp: "1710000000", type: "text", text: { body: "Table for 4" } }],
          statuses: [{ id: "wamid.out", status: "delivered", timestamp: "1710000005", recipient_id: "60111222333" }],
        },
      }],
    }],
  };

  it("routes a text message and a status by phone number id", () => {
    const events = parseWebhook(payload);
    assert.equal(events.length, 2);
    assert.equal(events[0].type, "message");
    assert.equal(events[0].phoneNumberId, "sim-ma-1001");
    assert.equal(events[0].waId, "60111222333");
    assert.equal(events[0].name, "Farah Ismail");
    assert.equal(events[0].waMessageId, "wamid.1");
    assert.equal(events[0].kind, "text");
    assert.equal(events[0].body, "Table for 4");
    assert.equal(events[1].type, "status");
    assert.equal(events[1].status, "delivered");
  });

  it("keeps a username-style user id and treats a photo as media", () => {
    const events = parseWebhook({
      object: "whatsapp_business_account",
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: "sim-ma-1001" },
            contacts: [{ profile: { name: "Mei" }, wa_id: "US.13491208655302741918" }],
            messages: [{
              from: "US.13491208655302741918",
              id: "wamid.photo",
              timestamp: "1710000000",
              type: "image",
              image: { id: "media-9", mime_type: "image/jpeg", caption: "Healed" },
            }],
          },
        }],
      }],
    });
    assert.equal(events[0].waId, "US.13491208655302741918");
    assert.equal(events[0].kind, "media");
    assert.equal(events[0].body, "Healed");
    assert.equal(events[0].waMediaId, "media-9");
    assert.equal(phoneFromWaId("US.13491208655302741918"), null);
    assert.equal(phoneFromWaId("60111222333"), "60111222333");
  });

  it("ignores payloads that are not from a WhatsApp business account", () => {
    assert.deepEqual(parseWebhook({ object: "page", entry: [] }), []);
    assert.deepEqual(parseWebhook(null), []);
  });
});

describe("referral parsing", () => {
  it("reads the Click-to-WhatsApp referral, including the click id", () => {
    const [event] = parseWebhook(referralPayload);
    assert.equal(event.type, "message");
    assert.deepEqual(event.referral, {
      sourceType: "ad",
      sourceId: "120210445566778",
      sourceUrl: "https://fb.me/master-artist-children",
      headline: "Children's Art Class – 10 sessions",
      body: "Ten Saturday mornings in Bangsar for ages 6 to 10.",
      mediaType: "image",
      mediaUrl: "https://example.com/children-art-class.jpg",
      ctwaClid: "ARtest-ctwa-clid",
    });
    assert.equal(parseReferral({ referral: { source_type: "ad" } }).sourceType, "ad");
    assert.equal(parseReferral({}), null);
  });

  it("finds a ref code in a prefilled wa.me message and ignores ordinary text", () => {
    assert.equal(extractRefCode("Hi Master Artist (ref:ig-bio)"), "ig-bio");
    assert.equal(extractRefCode("ref: flyer-bangsar please"), "flyer-bangsar");
    assert.equal(extractRefCode("Hello, I would like a table"), null);
  });

  it("suggests intent from the first words and from an ad for a class", () => {
    assert.equal(suggestIntent({ body: "How much is the term?", entryKind: "direct" }), "pricing");
    assert.equal(suggestIntent({ body: "Can I enrol my son?", entryKind: "direct" }), "booking");
    assert.equal(suggestIntent({ body: "This was a terrible class", entryKind: "direct" }), "complaint");
    assert.equal(suggestIntent({ body: "Hello", headline: "Children's Art Class – 10 sessions", entryKind: "ad" }), "class_enquiry");
    assert.equal(suggestIntent({ body: "Hi", entryKind: "direct" }), "general");
  });
});

describe("attribution without an organisation id", () => {
  it("maps an ad click onto the children's class and keeps the first click id", () => {
    const [event] = parseWebhook(referralPayload);
    const entry = resolveEntry({ body: event.body, referral: event.referral, refCode: null }, catalog);
    assert.equal(entry.label, "From ad: Children's Art Class – 10 sessions");
    assert.equal(entry.ctwaClid, "ARtest-ctwa-clid");
    assert.equal(entry.sessionTitle, "Children's Art Class – 10 sessions");
    assert.equal(entry.intent, "class_enquiry");
    const stored = applyAttribution(null, entry);
    const later = resolveEntry({
      body: "Any update?",
      referral: { sourceType: "ad", sourceId: "999", sourceUrl: null, headline: "Some other ad", body: null, mediaType: null, mediaUrl: null, ctwaClid: "ARother" },
      refCode: null,
    }, catalog);
    const locked = applyAttribution(stored, later);
    assert.equal(locked.ctwaClid, "ARtest-ctwa-clid");
    assert.equal(locked.sourceId, "120210445566778");
  });

  it("attributes a ref code and marks everyone else direct", () => {
    const tracked = resolveEntry({ body: "Hi Master Artist (ref:ig-bio)", referral: null, refCode: "ig-bio" }, catalog);
    assert.equal(tracked.label, "From Instagram bio");
    assert.equal(tracked.refCode, "ig-bio");
    assert.equal(tracked.sessionTitle, "Children's Art Class – 10 sessions");
    const direct = resolveEntry({ body: "Hello, are you open today?", referral: null, refCode: null }, catalog);
    assert.equal(direct.kind, "direct");
    assert.equal(direct.label, "Direct / organic");
  });

  it("falls back when the classifier returns something that is not an intent", async () => {
    const intent = await classifyIntent(
      { body: "How much is the term?", entryKind: "direct" },
      { draftReply: async () => "not a real intent" },
    );
    assert.equal(intent, "pricing");
  });
});

describe("hours, keywords, and round-robin", () => {
  const hours = { mon: { start: "10:00", end: "12:00" }, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null };

  it("uses Asia/Kuala_Lumpur for business hours", () => {
    const mondayMorning = new Date("2026-11-16T02:30:00Z");
    assert.equal(isWithinBusinessHours(mondayMorning, "Asia/Kuala_Lumpur", hours), true);
    assert.equal(isWithinBusinessHours(mondayMorning, "UTC", hours), false);
  });

  it("keeps Friday evening and Saturday morning closed for the rest window", () => {
    const fridayEvening = new Date("2026-11-20T12:30:00Z");
    const saturdayMorning = new Date("2026-11-21T02:00:00Z");
    const saturdayEvening = new Date("2026-11-21T12:00:00Z");
    const decision = automationDecision({
      now: fridayEvening,
      timeZone: "Asia/Kuala_Lumpur",
      awayEnabled: true,
      awayMessage: "We are resting and will reply after the weekend window.",
      greetingEnabled: true,
      greetingMessage: "Hello from Master Artist.",
      body: "Hi",
      rules: [],
    });
    assert.equal(decision.openNow, false);
    assert.equal(decision.messages[0].kind, "away");
    assert.equal(automationDecision({
      now: saturdayEvening,
      greetingEnabled: true,
      greetingMessage: "Hello from Master Artist.",
      greetingSentAt: null,
      awayEnabled: true,
      awayMessage: "away",
      body: "Hi",
      rules: [],
    }).messages[0].kind, "greeting");
    assert.equal(isWithinBusinessHours(saturdayMorning, "Asia/Kuala_Lumpur", {
      mon: null, tue: null, wed: null, thu: null, fri: null, sun: null, sat: { start: "19:30", end: "24:00" },
    }), false);
  });

  it("matches the first keyword, case-insensitively", () => {
    const rule = matchKeyword("What is the PRICE range?", [
      { keyword: "parking", reply: "Bay B2", enabled: true },
      { keyword: "price", reply: "We quote after a reference.", enabled: true },
    ]);
    assert.match(rule.reply, /quote/);
    assert.equal(matchKeyword("hello", [{ keyword: "price", reply: "x", enabled: false }]), null);
  });

  it("walks the staff list and wraps around", () => {
    assert.equal(nextRoundRobin(["maya", "amir"], null), "maya");
    assert.equal(nextRoundRobin(["maya", "amir"], "maya"), "amir");
    assert.equal(nextRoundRobin(["maya", "amir"], "amir"), "maya");
    assert.equal(nextRoundRobin([], "maya"), null);
  });
});

describe("calls, enrolments, and the service window", () => {
  it("reads a WhatsApp call and describes a missed one", () => {
    const [call] = parseCalls({
      object: "whatsapp_business_account",
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: "sim-ma-1001" },
            contacts: [{ profile: { name: "Hana" }, wa_id: "60173334444" }],
            calls: [{ id: "call-1", from: "60173334444", direction: "USER_INITIATED", status: "no_answer", duration: 0, timestamp: "1710002222" }],
          },
        }],
      }],
    });
    assert.equal(call.status, "missed");
    assert.equal(call.waId, "60173334444");
    assert.equal(call.name, "Hana");
    assert.equal(describeCall({ direction: "inbound", status: "missed", durationSeconds: 0, kind: "whatsapp_call" }), "Incoming · WhatsApp call · missed");
  });

  it("links a customer as enquired and stamps enrolled only when they enrol", () => {
    const row = linkEnrolment(null, {
      sessionId: "children-2027",
      contactId: "hana",
      conversationId: "conv-1",
      status: "enquired",
      entryKind: "ad",
      entryLabel: "From ad: Children's Art Class – 10 sessions",
    });
    assert.equal(row.status, "enquired");
    assert.equal(row.isCurrent, true);
    assert.equal(row.enrolledAt, null);
    const enrolled = enrolmentStamp(row, "enrolled", new Date("2026-11-22T01:00:00Z"));
    assert.equal(enrolled.status, "enrolled");
    assert.ok(enrolled.enrolledAt);
    assert.equal(seatsLeft(12, 3), 9);
    assert.equal(seatsLeft(null, 3), null);
    const again = linkEnrolment(row, { sessionId: "children-2027", contactId: "hana", entryKind: "ref", entryLabel: "From somewhere else" });
    assert.equal(again.entryLabel, "From ad: Children's Art Class – 10 sessions");
  });

  it("walks a case from new to closed and refuses a jump backwards", () => {
    assert.equal(canTransition("new", "open").ok, true);
    assert.equal(canTransition("open", "pending").ok, true);
    assert.equal(canTransition("pending", "resolved").ok, true);
    assert.equal(canTransition("resolved", "closed").ok, true);
    assert.equal(canTransition("closed", "pending").ok, false);
    assert.equal(canTransition("closed", "open").ok, true);
    assert.equal(canTransition("open", "open").ok, false);
    const now = new Date("2026-11-17T02:00:00Z");
    const resolved = statusTimestamps("open", "resolved", now, { resolved_at: null, closed_at: null });
    assert.equal(resolved.resolved_at, now);
    assert.equal(resolved.closed_at, null);
    const reopened = statusTimestamps("resolved", "open", now, { resolved_at: now, closed_at: null });
    assert.equal(reopened.resolved_at, null);
  });

  it("allows free-form replies only inside 24 hours of the last customer message", () => {
    const now = new Date("2026-11-17T12:00:00Z");
    assert.equal(withinServiceWindow(new Date("2026-11-17T10:00:00Z"), now), true);
    assert.equal(withinServiceWindow(new Date("2026-11-16T11:00:00Z"), now), false);
    assert.equal(withinServiceWindow(null, now), false);
  });

  it("rejects a draft that uses a banned phrase", () => {
    assert.equal(reviewDraft("Come to our sip and paint").ok, false);
    assert.equal(reviewDraft("The Saturday class still has seats.").ok, true);
  });
});
