// Drafts a staff reply. Code only. Not deployed. Never sends.
// Uses the Atrium prompt shape and rejects a draft that uses a banned phrase.

import { draftSystemPrompt, reviewDraft } from "../_shared/atrium-port.mjs";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const body = await req.json().catch(() => ({}));
  const note = String(body.note || body.context || "").slice(0, 1000);
  const messages = Array.isArray(body.messages) ? body.messages : [{ direction: "inbound", body: note || "Hello" }];
  const prompt = draftSystemPrompt({
    orgName: "Master Artist",
    knowledgeBase: String(body.knowledgeBase || note || ""),
  });
  const key = Deno.env.get("AI_API_KEY") || Deno.env.get("OPENAI_API_KEY") || "";
  let text = "";
  if (!key) {
    text = `Hello, thanks for writing to Master Artist. ${note}`.replace(/\s+/g, " ").trim().slice(0, 500);
  } else {
    const base = (Deno.env.get("AI_BASE_URL") || "https://api.openai.com/v1").replace(/\/$/, "");
    const transcript = messages.slice(-12).map((message: { direction?: string; body?: string }) =>
      `${message.direction === "outbound" ? "Agent" : "Customer"}: ${message.body || ""}`
    ).join("\n");
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: Deno.env.get("AI_MODEL") || "gpt-4o-mini",
        temperature: 0.4,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: transcript || "The customer has just opened the chat." },
        ],
      }),
    });
    const payload = await response.json().catch(() => ({}));
    text = payload?.choices?.[0]?.message?.content || "";
  }
  const reviewed = reviewDraft(text);
  if (!reviewed.ok) return json({ ok: false, sent: false, reason: reviewed.reason }, 422);
  return json({ ok: true, sent: false, draft: reviewed.text });
});
