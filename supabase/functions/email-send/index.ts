// email-send: drain public.email_queue through Resend.
// Not deployed. Does not send unless both RESEND_API_KEY and EMAIL_SEND_ENABLED=true.
// DNS for masterartist.co is not set up, so leave EMAIL_SEND_ENABLED unset.
//
// Secrets, when you are ready (do not commit them):
//   RESEND_API_KEY
//   EMAIL_SEND_ENABLED   must be the string "true"
//   EMAIL_FROM            optional, defaults to the email_settings row
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.

import { createClient } from "jsr:@supabase/supabase-js@2";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async () => {
  const key = Deno.env.get("RESEND_API_KEY");
  const enabled = Deno.env.get("EMAIL_SEND_ENABLED") === "true";
  if (!key || !enabled) {
    return json({
      ok: false,
      sent: 0,
      reason: "Email sending is off. RESEND_API_KEY and EMAIL_SEND_ENABLED are not set, and DNS is not ready. No customer mail was sent.",
    });
  }

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: settings } = await sb.from("email_settings").select("*").eq("id", 1).maybeSingle();
  const limit = Math.min(Number(settings?.batch_size ?? 100), Number(settings?.max_per_minute ?? 60), 100);
  const { data: due, error } = await sb.rpc("fetch_due_email", { p_limit: limit });
  if (error) return json({ ok: false, reason: error.message }, 500);
  const rows = due ?? [];
  if (!rows.length) return json({ ok: true, sent: 0 });

  const from = Deno.env.get("EMAIL_FROM") ?? settings?.from_address ?? "Master Artist <news@masterartist.co>";
  let sent = 0;
  for (const row of rows) {
    const tpl = row.template_id
      ? (await sb.from("email_templates").select("subject, body_html, body_text").eq("id", row.template_id).maybeSingle()).data
      : null;
    const vars = row.variables ?? {};
    const fill = (s: string | null) => String(s ?? "").replace(/\{([a-z0-9_]+)\}/gi, (_, k) => String(vars[k] ?? ""));
    const footer = `<p style="font-size:12px;color:#666">${settings?.postal_address ?? ""}<br><a href="${vars.unsubscribe_url ?? ""}">Unsubscribe</a></p>`;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: row.to_email,
        subject: fill(row.subject || tpl?.subject),
        html: fill(tpl?.body_html) + footer,
        text: fill(tpl?.body_text),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.id) {
      sent += 1;
      await sb.from("email_queue").update({ status: "sent", resend_id: body.id, sent_at: new Date().toISOString() }).eq("id", row.id);
    } else {
      await sb.from("email_queue").update({ status: "failed", skip_reason: String(body.message || res.status) }).eq("id", row.id);
    }
  }
  return json({ ok: true, sent });
});
