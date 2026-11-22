// Upserts daily Meta ad metrics. Code only. Not deployed.
// Account act_1612497836946260. Set META_ADS_TOKEN before this is switched on.

import { createClient } from "jsr:@supabase/supabase-js@2";

const ACCOUNT = "act_1612497836946260";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async () => {
  const token = Deno.env.get("META_ADS_TOKEN") || "";
  if (!token) return json({ ok: false, upserted: 0, reason: "META_ADS_TOKEN is not set" });
  const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const until = new Date().toISOString().slice(0, 10);
  const url = new URL(`https://graph.facebook.com/v21.0/${ACCOUNT}/insights`);
  url.searchParams.set("fields", "ad_id,ad_name,spend,impressions,clicks,actions");
  url.searchParams.set("level", "ad");
  url.searchParams.set("time_increment", "1");
  url.searchParams.set("time_range", JSON.stringify({ since, until }));
  url.searchParams.set("access_token", token);
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) return json({ ok: false, reason: body?.error?.message || "Meta ads request failed" }, 502);
  const sb = createClient(Deno.env.get("SUPABASE_URL") || "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "");
  let upserted = 0;
  for (const row of body.data || []) {
    const actions = Array.isArray(row.actions) ? row.actions : [];
    const leads = Number(actions.find((a: { action_type?: string }) => a.action_type === "lead")?.value || 0);
    const chats = Number(actions.find((a: { action_type?: string }) => String(a.action_type || "").includes("conversation"))?.value || 0);
    await sb.from("ad_entities").upsert({ id: row.ad_id, name: row.ad_name || row.ad_id, account_id: ACCOUNT });
    const { error } = await sb.from("ad_daily_metrics").upsert({
      ad_id: row.ad_id,
      day: row.date_start,
      spend_rm: Number(row.spend || 0),
      impressions: Number(row.impressions || 0),
      clicks: Number(row.clicks || 0),
      wa_conversations_started: chats,
      leads,
    });
    if (!error) upserted += 1;
  }
  return json({ ok: true, upserted, account: ACCOUNT });
});
