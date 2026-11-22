// 360dialog / WhatsApp Cloud API inbound webhook. Code only. Not deployed.
// Signature check, Click-to-WhatsApp referral, wa.me ref codes, and call events
// come from the Atrium port. Messages are stored through ingest_whatsapp_webhook.
// Set META_APP_SECRET or D360_WEBHOOK_SECRET before this is switched on.

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  applyAttribution,
  automationDecision,
  describeCall,
  extractRefCode,
  nextRoundRobin,
  parseCalls,
  parseWebhook,
  phoneFromWaId,
  resolveEntry,
  verifySignature,
  verifySubscription,
} from "../_shared/atrium-port.mjs";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "GET") {
    const url = new URL(req.url);
    const result = verifySubscription({
      mode: url.searchParams.get("hub.mode"),
      token: url.searchParams.get("hub.verify_token"),
      challenge: url.searchParams.get("hub.challenge"),
      expectedToken: Deno.env.get("META_VERIFY_TOKEN") || Deno.env.get("D360_VERIFY_TOKEN"),
    });
    if (!result.ok) return new Response("forbidden", { status: 403 });
    return new Response(result.challenge, { status: 200, headers: { "content-type": "text/plain" } });
  }

  const secret = Deno.env.get("META_APP_SECRET") || Deno.env.get("D360_WEBHOOK_SECRET") || "";
  const raw = await req.text();
  if (!secret) return json({ ok: false, reason: "META_APP_SECRET is not set" }, 500);
  const header = req.headers.get("x-hub-signature-256") || req.headers.get("x-360dialog-signature");
  if (!verifySignature(raw, header, secret)) return json({ ok: false, reason: "invalid signature" }, 401);
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ ok: false, reason: "invalid json" }, 400);
  }

  const sb = createClient(Deno.env.get("SUPABASE_URL") || "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "");
  const ads = await sb.from("ad_mappings").select("source_id, session_id, campaign_name, headline");
  const refs = await sb.from("ref_links").select("code, label, session_id");
  const catalog = {
    ads: (ads.data || []).map((row) => ({
      sourceId: row.source_id,
      sessionId: row.session_id,
      sessionTitle: row.headline,
      campaignName: row.campaign_name,
      headline: row.headline,
    })),
    refs: (refs.data || []).map((row) => ({
      code: row.code,
      label: row.label,
      sessionId: row.session_id,
      sessionTitle: null,
    })),
  };

  const saved = [];
  const inboundBodies: string[] = [];
  for (const event of parseWebhook(payload)) {
    if (event.type === "status") {
      if (event.waMessageId) {
        await sb.from("messages").update({ status: event.status }).eq("provider_message_id", event.waMessageId);
      }
      saved.push({ type: "status", id: event.waMessageId });
      continue;
    }
    inboundBodies.push(event.body || "");
    const entry = resolveEntry({
      body: event.body,
      referral: event.referral,
      refCode: event.referral ? null : extractRefCode(event.body),
    }, catalog);
    const stored = applyAttribution(null, entry);
    const phone = phoneFromWaId(event.waId);
    const { data, error } = await sb.rpc("ingest_whatsapp_webhook", {
      p: {
        phone: phone || event.waId,
        channel: "whatsapp",
        direction: "in",
        sender_type: "customer",
        body: event.body,
        source: "live",
        provider_message_id: event.waMessageId,
        occurred_at: event.timestamp ? new Date(Number(event.timestamp) * 1000).toISOString() : undefined,
        raw: { referral: event.referral, ref_code: entry.refCode, name: event.name },
        entry_kind: stored.entryKind,
        entry_label: stored.entryLabel,
        source_id: stored.sourceId,
        ctwa_clid: stored.ctwaClid,
        intent: stored.intent,
        session_id: stored.sessionId,
      },
    });
    saved.push(error ? { error: error.message } : { id: data, entry: stored.entryLabel });
  }

  for (const call of parseCalls(payload)) {
    const phone = phoneFromWaId(call.waId);
    const body = describeCall({ direction: call.direction, status: call.status, durationSeconds: call.durationSeconds, kind: "whatsapp_call" });
    const { error } = await sb.rpc("ingest_whatsapp_webhook", {
      p: {
        phone: phone || call.waId,
        channel: "call",
        direction: call.direction === "outbound" ? "out" : "in",
        sender_type: call.direction === "outbound" ? "staff" : "customer",
        body,
        source: "live",
        wa_call_id: call.callId,
        entry_kind: "call",
        entry_label: "WhatsApp call",
      },
    });
    saved.push(error ? { error: error.message } : { call: call.callId });
  }

  const settings = await sb.from("inbox_settings").select("timezone, business_hours, welcome_reply, sabbath_reply, greeting_enabled, away_enabled").eq("id", 1).maybeSingle();
  const rules = await sb.from("keyword_rules").select("phrase, reply, active").eq("active", true);
  const decision = automationDecision({
    now: new Date(),
    timeZone: settings.data?.timezone || "Asia/Kuala_Lumpur",
    hours: settings.data?.business_hours,
    greetingEnabled: settings.data?.greeting_enabled !== false,
    greetingMessage: settings.data?.welcome_reply,
    awayEnabled: settings.data?.away_enabled !== false,
    awayMessage: settings.data?.sabbath_reply,
    body: inboundBodies.join("\n"),
    rules: (rules.data || []).map((rule) => ({ keyword: rule.phrase, reply: rule.reply, enabled: rule.active })),
  });
  const cursor = await sb.from("assignment_cursor").select("last_user_id").eq("id", 1).maybeSingle();
  const staff = await sb.from("profiles").select("id").eq("active", true).order("id");
  const assignee = nextRoundRobin((staff.data || []).map((row) => row.id), cursor.data?.last_user_id || null);

  return json({
    ok: true,
    received: true,
    saved,
    openNow: decision.openNow,
    suggestedReplies: decision.messages.map((message) => message.kind),
    nextAssignee: assignee,
  });
});
