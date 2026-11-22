// Sends due WhatsApp rows through 360dialog. Code only. Not deployed.
// Does nothing unless D360_API_KEY and D360_SEND_ENABLED=true are both set.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { textPayload } from "../_shared/atrium-port.mjs";
import { requireCaller } from "../_shared/edge-guard.mjs";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (!(await requireCaller(req))) return json({ ok: false, sent: 0, reason: "Sign in is required." }, 401);
  const key = Deno.env.get("D360_API_KEY") || "";
  if (!key || Deno.env.get("D360_SEND_ENABLED") !== "true") {
    return json({ ok: false, sent: 0, reason: "360dialog sending is off" });
  }
  const sb = createClient(Deno.env.get("SUPABASE_URL") || "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "");
  const due = await sb.rpc("fetch_due_outbound", { p_limit: 20 });
  if (due.error) return json({ ok: false, reason: due.error.message }, 500);
  let sent = 0;
  for (const job of due.data || []) {
    const payload = job.template_name
      ? { messaging_product: "whatsapp", recipient_type: "individual", to: job.phone_e164, type: "template", template: { name: job.template_name, language: { code: job.language || "en" } } }
      : textPayload(job.phone_e164, job.body || "");
    const res = await fetch("https://waba-v2.360dialog.io/messages", {
      method: "POST",
      headers: { "D360-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    await sb.from("outbound_queue").update({
      status: res.ok ? "sent" : "failed",
      provider_ref: body?.messages?.[0]?.id || null,
      sent_at: res.ok ? new Date().toISOString() : null,
      skip_reason: res.ok ? null : JSON.stringify(body).slice(0, 300),
    }).eq("id", job.id);
    if (res.ok) sent += 1;
  }
  return json({ ok: true, sent });
});
