// 360dialog / WhatsApp Cloud API inbound webhook. Code only. Not deployed.
// Signature check, Click-to-WhatsApp referral, wa.me ref codes, and call events
// come from the Atrium port. Messages are stored through ingest_whatsapp_webhook.
// Set META_APP_SECRET or D360_WEBHOOK_SECRET before this is switched on.
// Greeting and away replies are queued by the database when a message is stored
// (private.maybe_auto_reply). This function assigns new chats and then asks
// whatsapp-send to drain the queue.

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  applyAttribution,
  describeCall,
  extractRefCode,
  parseCalls,
  parseWebhook,
  pickAssignee,
  phoneFromWaId,
  resolveEntry,
  verifySignature,
  verifySubscription,
} from "../_shared/atrium-port.mjs";
import { extractAdRef, matchAdLink } from "../../../attribution.mjs";

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
  const adLinks = await sb.from("ad_links").select("ad_id, ref_code, platform, campaign_name, ad_name, target_type, target_id, active");
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
  const newMessageIds: string[] = [];
  for (const event of parseWebhook(payload)) {
    if (event.type === "status") {
      if (event.waMessageId) {
        await sb.from("messages").update({ status: event.status }).eq("provider_message_id", event.waMessageId);
      }
      saved.push({ type: "status", id: event.waMessageId });
      continue;
    }
    const refCode = extractAdRef(event.body) || (event.referral ? null : extractRefCode(event.body));
    const linked = matchAdLink({
      sourceId: event.referral && event.referral.sourceId,
      refCode,
    }, (adLinks.data || []).map((row) => ({
      ad_id: row.ad_id,
      ref_code: row.ref_code,
      platform: row.platform,
      campaign_name: row.campaign_name,
      target_type: row.target_type,
      target_id: row.target_id,
      active: row.active !== false,
    })));
    const entry = resolveEntry({
      body: event.body,
      referral: event.referral,
      refCode,
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
        session_id: (linked && linked.link.target_id) || stored.sessionId,
        attribution_method: linked ? linked.method : entry.kind === "ad" ? "ad_referral" : refCode ? "ref_code" : "direct",
        platform: linked && linked.link.platform,
        campaign: linked && linked.link.campaign_name,
        ref_code: refCode,
      },
    });
    if (!error && data && data.message_id && !data.duplicate) newMessageIds.push(data.message_id);
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

  const assigned = await assignNewChats(sb, newMessageIds);
  const sendQueue = newMessageIds.length ? await kickSender() : "nothing new";

  return json({ ok: true, received: true, saved, assigned, sendQueue });
});

// Gives each new chat with no owner to the next staff member on duty.
// The update only applies while assigned_to is still empty, so two webhooks
// arriving together cannot assign the same chat twice.
// deno-lint-ignore no-explicit-any
async function assignNewChats(sb: any, messageIds: string[]) {
  if (!messageIds.length) return [];
  const msgs = await sb.from("messages").select("conversation_id").in("id", messageIds);
  const conversationIds = [...new Set((msgs.data || []).map((m: { conversation_id: string }) => m.conversation_id).filter(Boolean))];
  if (!conversationIds.length) return [];
  const open = await sb.from("conversations").select("id").in("id", conversationIds).is("assigned_to", null);
  if (!(open.data || []).length) return [];
  const staff = await sb.from("profiles").select("id").eq("active", true).order("id");
  const duty = await sb.from("staff_duty").select("staff_id, on_duty");
  const cursor = await sb.from("assignment_cursor").select("last_user_id").eq("id", 1).maybeSingle();
  const active = (staff.data || []).map((row: { id: string }) => row.id);
  let last = cursor.data?.last_user_id || null;
  const out = [];
  for (const row of open.data || []) {
    const who = pickAssignee(active, duty.data || [], last);
    if (!who) break;
    const done = await sb.from("conversations").update({ assigned_to: who }).eq("id", row.id).is("assigned_to", null).select("id");
    if ((done.data || []).length) {
      last = who;
      out.push({ conversation: row.id, assigned_to: who });
    }
  }
  if (out.length) await sb.from("assignment_cursor").update({ last_user_id: last }).eq("id", 1);
  return out;
}

// Asks whatsapp-send to send whatever the database queued (greeting, away reply).
// whatsapp-send still does nothing unless D360_SEND_ENABLED=true.
async function kickSender() {
  const url = Deno.env.get("SUPABASE_URL") || "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!url || !key) return "not configured";
  try {
    const res = await fetch(url + "/functions/v1/whatsapp-send", {
      method: "POST",
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      body: "{}",
    });
    const body = await res.json().catch(() => ({}));
    return body;
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}
