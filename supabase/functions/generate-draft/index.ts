import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// generate-draft — Feature 1: LLM draft writing.
//
// Takes { companyId }, reads that company row + the caller's template (both
// RLS-scoped to the signed-in user), asks Claude to write a personalized cold
// outreach subject + body, and stores the result on the company row as
// generated_subject / generated_body / generated_at. Does NOT touch Gmail —
// create-draft still does that, and now prefers this stored text.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
// Default per Anthropic guidance; override with the ANTHROPIC_MODEL secret
// (e.g. "claude-sonnet-5") without redeploying.
const DEFAULT_MODEL = "claude-opus-5";

const SYSTEM_PROMPT = [
  "You write short, sharp cold outreach emails on behalf of a job seeker.",
  "You are given the sender's own template as a guide to their voice, background, and intent, plus facts about the target company and contact.",
  "Write ONE email tailored to that company and person.",
  "",
  "Rules:",
  "- Plain text only. No markdown, no bullet points, no placeholder tokens like {{company}}.",
  "- Keep the body under 150 words. Every sentence earns its place.",
  "- Open with something specific to this company or role, not a generic hook.",
  "- Keep the sender's voice and any concrete claims from the template. Do not invent facts about the sender, the company, or the person.",
  "- One clear ask. Mention that a CV is attached (it is attached separately — do not write it out).",
  "- End with the sender's name on its own line.",
  "",
  'Reply with ONLY a JSON object, no prose around it: {"subject": "...", "body": "..."}',
].join("\n");

function extractText(msg: any): string {
  if (!msg || !Array.isArray(msg.content)) return "";
  const block = msg.content.find((b: any) => b && b.type === "text");
  return block ? String(block.text || "") : "";
}

function parseDraftJson(text: string): { subject: string; body: string } | null {
  let t = (text || "").trim();
  // tolerate ```json fences or stray prose around the object
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(t.slice(start, end + 1));
    const subject = String(obj.subject || "").trim();
    const body = String(obj.body || "").trim();
    if (!body) return null;
    return { subject, body };
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
  const ANTHROPIC_WORKSPACE_ID = Deno.env.get("ANTHROPIC_WORKSPACE_ID");
  const MODEL = Deno.env.get("ANTHROPIC_MODEL") || DEFAULT_MODEL;

  const authHeader = req.headers.get("Authorization") || "";
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);
  const userId = userData.user.id;

  let payload: any;
  try { payload = await req.json(); } catch { return json({ error: "bad_request", message: "Invalid JSON body" }, 400); }
  const companyId = payload?.companyId;
  if (!companyId) return json({ error: "bad_request", message: "companyId is required" }, 400);

  if (!ANTHROPIC_API_KEY) {
    // Not an error the user needs to see as a failure — create-draft will fall
    // back to template merge. The client treats this as "skip generation".
    return json({ error: "not_configured", message: "ANTHROPIC_API_KEY is not set on the server" }, 400);
  }

  const { data: company, error: companyErr } = await userClient
    .from("companies").select("*").eq("id", companyId).single();
  if (companyErr || !company) return json({ error: "not_found", message: "Company not found" }, 404);

  const { data: template } = await userClient
    .from("templates").select("*").eq("user_id", userId).single();

  const instruction = payload?.instruction ? String(payload.instruction).slice(0, 1000) : "";

  const userContent = [
    `Sender name: ${template?.your_name || "(not set)"}`,
    "",
    "Sender's template — subject:",
    template?.subject || "(empty)",
    "",
    "Sender's template — body:",
    template?.body || "(empty)",
    "",
    "Target:",
    `- Company: ${company.company || "(unknown)"}`,
    `- Contact name: ${company.contact_name || "(unknown)"}`,
    `- Role / context: ${company.role || "(unknown)"}`,
    instruction ? `\nExtra instruction from the sender: ${instruction}` : "",
    "",
    "Write the tailored email now.",
  ].join("\n");

  const anthropicHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
  };
  // Identity-linked API keys require the workspace to be named explicitly.
  if (ANTHROPIC_WORKSPACE_ID) anthropicHeaders["anthropic-workspace-id"] = ANTHROPIC_WORKSPACE_ID;

  let claudeRes: Response;
  try {
    claudeRes = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: anthropicHeaders,
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 3000,
        output_config: { effort: "low" },
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      }),
    });
  } catch (e) {
    return json({ error: "llm_unreachable", message: String(e) }, 502);
  }

  const claudeJson = await claudeRes.json().catch(() => null);
  if (!claudeRes.ok) {
    const msg = claudeJson?.error?.message || `Claude API returned ${claudeRes.status}`;
    return json({ error: "llm_error", message: msg }, 502);
  }

  const draft = parseDraftJson(extractText(claudeJson));
  if (!draft) {
    return json({ error: "bad_llm_output", message: "Could not parse a draft from the model response" }, 502);
  }

  const { error: saveErr } = await userClient.from("companies").update({
    generated_subject: draft.subject || null,
    generated_body: draft.body,
    generated_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", companyId);
  if (saveErr) return json({ error: "save_failed", message: saveErr.message }, 500);

  return json({
    ok: true,
    subject: draft.subject,
    body: draft.body,
    model: claudeJson?.model || MODEL,
    usage: claudeJson?.usage || null,
  });
});
