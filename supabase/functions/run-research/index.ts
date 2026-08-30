import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// run-research — Stage 3 of the LinkedIn capture + staged-research feature.
//
// Runs the research prompts that suggest-research drafted. ONE Claude call with
// the server-side web_search tool: Claude searches, then returns per-question
// findings plus a short synthesis. Findings + status are written back onto
// companies.research_prompts and the synthesis onto companies.research_notes.
// This is the only function here that hits the web and it costs real API
// credits — the client only calls it on an explicit user action.
//
// Request:  { companyId: string, promptIds?: string[] }   (default: the
//           prompts with selected !== false)
// Response: { ok: true, notes: string, prompts: [...] }

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
// A capable model with good tool use; web search + synthesis over several
// results is weak on the small models. Override with ANTHROPIC_RESEARCH_RUN_MODEL.
const DEFAULT_MODEL = "claude-sonnet-5";
// web_search_20260209 (dynamic filtering) needs Opus 4.6+/Sonnet 4.6+/Sonnet 5;
// anything older must use the basic web_search_20250305 variant.
const WEB_SEARCH_MODERN = new Set([
  "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6",
  "claude-sonnet-5", "claude-sonnet-4-6", "claude-fable-5",
]);
const MAX_SEARCHES = 5;
const MAX_PAUSE_TURNS = 4;

// Prompt text is inlined here (not read from ./prompts/*.md at runtime): the
// Supabase deploy path used for this project does not bundle non-code asset
// files, so a Deno.readTextFile at boot crashes the worker before it can
// respond. The .md file in ./prompts/ is the editable source — re-inline it
// here by hand if you change it.
const RUN_GUIDE = `# Research runner guide

You are doing quick background research so a job-seeker can write a
well-informed outreach message. You get a short list of questions, each with an
id. Use web search to answer them.

- Answer each question in 1 to 3 sentences, concrete and specific. Prefer facts
  with a date or a number. If search turns up nothing solid, say so plainly —
  do not speculate or pad.
- Keep it current: prefer sources from roughly the last 12 months.
- For each answer, include the URLs you actually used.
- Then write \`notes\`: 2 to 4 sentences a writer can use directly — the
  through-line of what you found that would change how the outreach message is
  written. No preamble, no "in summary".

Output ONLY this JSON — no code fences, no commentary, no leading or trailing
text:

{
  "findings": [
    { "id": "r1", "answer": "...", "sources": ["https://..."] }
  ],
  "notes": "..."
}
`;

function extractText(msg: any): string {
  if (!msg || !Array.isArray(msg.content)) return "";
  return msg.content
    .filter((b: any) => b && b.type === "text")
    .map((b: any) => b.text || "")
    .join("");
}

function parseJsonLoose(text: string): any {
  let t = (text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

const clean = (v: unknown) => String(v ?? "").trim();

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
  const ANTHROPIC_WORKSPACE_ID = Deno.env.get("ANTHROPIC_WORKSPACE_ID");
  const MODEL = Deno.env.get("ANTHROPIC_RESEARCH_RUN_MODEL") || DEFAULT_MODEL;

  const authHeader = req.headers.get("Authorization") || "";
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);

  let payload: any;
  try { payload = await req.json(); } catch { return json({ error: "bad_request", message: "Invalid JSON body" }, 400); }
  const companyId = payload?.companyId;
  if (!companyId) return json({ error: "bad_request", message: "companyId is required" }, 400);
  const onlyIds: string[] | null = Array.isArray(payload?.promptIds)
    ? payload.promptIds.map((s: unknown) => String(s))
    : null;

  const { data: company, error: companyErr } = await userClient
    .from("companies").select("*").eq("id", companyId).single();
  if (companyErr || !company) return json({ error: "not_found", message: "Company not found" }, 404);

  const allPrompts: any[] = Array.isArray(company.research_prompts) ? company.research_prompts : [];
  const targets = allPrompts.filter((p) =>
    onlyIds ? onlyIds.includes(p?.id) : p?.selected !== false
  );
  if (targets.length === 0) {
    return json({ error: "bad_request", message: "No research prompts selected to run." }, 400);
  }

  if (!ANTHROPIC_API_KEY) {
    return json({ error: "not_configured", message: "ANTHROPIC_API_KEY is not set on the server" }, 400);
  }

  const anthropicHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
  };
  if (ANTHROPIC_WORKSPACE_ID) anthropicHeaders["anthropic-workspace-id"] = ANTHROPIC_WORKSPACE_ID;

  const webSearchType = WEB_SEARCH_MODERN.has(MODEL) ? "web_search_20260209" : "web_search_20250305";
  const system = `${RUN_GUIDE}\n\nRespond with ONLY the JSON object. No code fences, no commentary.`;
  const questionLines = targets
    .map((p) => `- ${p.id} [${p.topic || "company"}]: ${clean(p.question)}${p.query ? `  (try: ${clean(p.query)})` : ""}`)
    .join("\n");
  const userMsg = [
    `Company: ${company.company || "(unknown)"}`,
    `Role / context: ${company.role || "(unknown)"}`,
    `Person: ${company.contact_name || "(no name given)"}`,
    "",
    "Questions:",
    questionLines,
  ].join("\n");

  // Mark the targeted prompts as running so a refetch mid-flight shows progress.
  const runningPrompts = allPrompts.map((p) =>
    targets.some((t) => t.id === p.id) ? { ...p, status: "running" } : p
  );
  await userClient.from("companies")
    .update({ research_prompts: runningPrompts, updated_at: new Date().toISOString() })
    .eq("id", companyId);

  try {
    const messages: any[] = [{ role: "user", content: userMsg }];
    let final: any = null;

    for (let turn = 0; turn < MAX_PAUSE_TURNS; turn++) {
      const res = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: anthropicHeaders,
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 3000,
          system,
          messages,
          tools: [{ type: webSearchType, name: "web_search", max_uses: MAX_SEARCHES }],
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error?.message || `Claude API returned ${res.status}`);
      }
      if (data?.stop_reason === "pause_turn" && Array.isArray(data.content)) {
        messages.push({ role: "assistant", content: data.content });
        continue;
      }
      final = data;
      break;
    }
    if (!final) throw new Error("Research did not finish (too many continuation turns).");

    const parsed = parseJsonLoose(extractText(final));
    if (!parsed) {
      return json({ error: "research_failed", message: "Could not read the research results." }, 502);
    }

    const findings: Record<string, any> = {};
    (Array.isArray(parsed.findings) ? parsed.findings : []).forEach((f: any) => {
      if (f && f.id) findings[String(f.id)] = f;
    });
    const notes = clean(parsed.notes);

    const merged = allPrompts.map((p) => {
      if (!targets.some((t) => t.id === p.id)) return p;
      const f = findings[p.id];
      return {
        ...p,
        status: "done",
        answer: f ? clean(f.answer) : "(no answer found)",
        sources: f && Array.isArray(f.sources) ? f.sources.map(clean).filter(Boolean).slice(0, 6) : [],
        ran_at: new Date().toISOString(),
      };
    });

    await userClient.from("companies")
      .update({
        research_prompts: merged,
        research_notes: notes || company.research_notes || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", companyId);

    return json({ ok: true, notes, prompts: merged });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Something went wrong running the research.";
    // Roll the targeted prompts back off "running" so the UI isn't stuck.
    const rolledBack = allPrompts.map((p) =>
      targets.some((t) => t.id === p.id) && p.status === "running" ? { ...p, status: "suggested" } : p
    );
    await userClient.from("companies")
      .update({ research_prompts: rolledBack, updated_at: new Date().toISOString() })
      .eq("id", companyId);
    return json({ error: "research_failed", message }, 502);
  }
});
