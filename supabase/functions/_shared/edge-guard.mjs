// Shared check for edge functions that are not the public WhatsApp webhook.
// Accepts the service role, a shared secret, or a signed-in staff JWT.

export async function requireCaller(req) {
  const secret = Deno.env.get("EDGE_SHARED_SECRET") || "";
  const given = req.headers.get("x-edge-secret") || "";
  if (secret && given && given === secret) return true;
  const header = req.headers.get("authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (service && token && token === service) return true;
  if (!token || token.split(".").length !== 3) return false;
  const url = Deno.env.get("SUPABASE_URL") || "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") || "";
  if (!url || !anon) return false;
  const res = await fetch(url + "/auth/v1/user", {
    headers: { authorization: "Bearer " + token, apikey: anon },
  });
  return res.ok;
}
