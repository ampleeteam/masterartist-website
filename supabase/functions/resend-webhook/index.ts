// resend-webhook: record delivered, opened, clicked, bounced, unsubscribed, complained.
// Not deployed. Rejects every call until RESEND_WEBHOOK_SECRET is set.
// Resend signs the body with Svix (svix-id, svix-timestamp, svix-signature).

import { createClient } from "jsr:@supabase/supabase-js@2";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const KINDS: Record<string, string> = {
  "email.delivered": "delivered",
  "email.opened": "opened",
  "email.clicked": "clicked",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.unsubscribed": "unsubscribed",
};

function decodeSecret(secret: string) {
  const raw = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const bin = atob(raw);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function signed(secret: string, id: string, timestamp: string, payload: string, header: string) {
  const key = await crypto.subtle.importKey("raw", decodeSecret(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${payload}`));
  const expect = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return header.split(" ").some((part) => part.split(",")[1] === expect);
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("RESEND_WEBHOOK_SECRET");
  if (!secret) return json({ ok: false, reason: "RESEND_WEBHOOK_SECRET is not set. No event was stored." }, 401);
  const id = req.headers.get("svix-id") ?? "";
  const timestamp = req.headers.get("svix-timestamp") ?? "";
  const signature = req.headers.get("svix-signature") ?? "";
  const payload = await req.text();
  if (!id || !timestamp || !signature || !(await signed(secret, id, timestamp, payload, signature))) {
    return json({ ok: false }, 401);
  }
  const event = JSON.parse(payload);
  const kind = KINDS[event.type];
  if (!kind) return json({ ok: true, ignored: event.type });
  const data = event.data ?? {};
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { error } = await sb.rpc("record_email_event", {
    p_resend_id: data.email_id,
    p_kind: kind,
    p_url: data.click?.link ?? null,
  });
  if (error) return json({ ok: false, reason: error.message }, 500);
  return json({ ok: true });
});
