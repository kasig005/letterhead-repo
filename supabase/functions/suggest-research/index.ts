import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// suggest-research — Stage 2 of the LinkedIn capture + staged-research feature.
//
// Given a companies row (ideally one with a captured source_profile), asks
// Claude for 3-6 specific things worth looking up before writing the outreach —
// split between the company and the person. It stores the list on
// companies.research_prompts and returns it. It does NOT run any of them; that
// is Stage 4 (run-research).
//
// Request:  { companyId: string }
// Response: { ok: true, prompts: [{ id, topic, question, query, status,
//             selected }] }

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
const DEFAULT_MODEL = "claude-haiku-4-5";
const MAX_PROMPTS = 6;

// Prompt text is inlined here (not read from ./prompts/*.md at runtime): the
// Supabase deploy path used for this project does not bundle non-code asset
// files, so a Deno.readTextFile at boot crashes the worker before it can
// respond. The .md file in ./prompts/ is the editable source — re-inline it
// here by hand if you change it.
const RESEARCH_GUIDE = `# Research suggestion guide

A job-seeker is about to send a tailored outreach message to a specific person
at a specific company. Before they write it, propose the handful of things worth
looking up that would actually change what the message says.

## Input

You get: the target company, the role / context, the person's name, and
(sometimes) a captured LinkedIn profile — headline, about, current and past
roles, skills.

## Output

A JSON array of 3 to 6 objects, most useful first:

[
  {
    "topic": "company" | "person",
    "question": "plain-English thing you want to know",
    "query": "a web search string likely to surface it"
  }
]

- topic "company": recent, concrete developments — funding rounds, product
  launches, notable hires or departures, strategic shifts, partnerships, press
  in roughly the last 12 months. Not "what does the company do".
- topic "person": their recent public work — talks, posts, articles,
  open-source projects, publications, a recent role change and why it matters.
  Only when the profile gives something to go on.
- Every item must be specific enough that the answer would change a sentence in
  the outreach. Skip anything generic or already obvious from the inputs.
- If the inputs are thin, return fewer items rather than padding.

Respond with ONLY the JSON array — no code fences, no commentary, no leading or
trailing text.
`;

function extractText(msg: any): string {
  if (!msg || !Array.isArray(msg.content)) return "";
  return msg.content
    .filter((b: any) => b && b.type === "text")
    .map((b: any) => b.text || "")
    .join("");
}

function parseJsonArrayLoose(text: string): any[] | null {
  let t = (text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("[");
  const end = t.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(t.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const clean = (v: unknown) => String(v ?? "").trim();

function profileBlock(sp: any): string {
  if (!sp || typeof sp !== "object") return "(no LinkedIn profile captured)";
  const lines = [
    sp.name && `Name: ${sp.name}`,
    sp.headline && `Headline: ${sp.headline}`,
    sp.location && `Location: ${sp.location}`,
    (sp.current_title || sp.current_company) &&
      `Current: ${[sp.current_title, sp.current_company].filter(Boolean).join(" @ ")}`,
    Array.isArray(sp.past_roles) && sp.past_roles.length &&
      `Past: ${sp.past_roles.map((r: any) => [r?.title, r?.company].filter(Boolean).join(" @ ")).filter(Boolean).join("; ")}`,
    Array.isArray(sp.skills) && sp.skills.length && `Skills: ${sp.skills.join(", ")}`,
    sp.about && `About: ${clean(sp.about).slice(0, 600)}`,
  ].filter(Boolean);
  return lines.length ? lines.join("\n") : "(no LinkedIn profile captured)";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
  const ANTHROPIC_WORKSPACE_ID = Deno.env.get("ANTHROPIC_WORKSPACE_ID");
  const MODEL =
    Deno.env.get("ANTHROPIC_RESEARCH_MODEL") ||
    Deno.env.get("ANTHROPIC_EXTRACT_MODEL") ||
    DEFAULT_MODEL;

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

  const { data: company, error: companyErr } = await userClient
    .from("companies").select("*").eq("id", companyId).single();
  if (companyErr || !company) return json({ error: "not_found", message: "Company not found" }, 404);

  if (!ANTHROPIC_API_KEY) {
    return json({ error: "not_configured", message: "ANTHROPIC_API_KEY is not set on the server" }, 400);
  }

  const anthropicHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
  };
  if (ANTHROPIC_WORKSPACE_ID) anthropicHeaders["anthropic-workspace-id"] = ANTHROPIC_WORKSPACE_ID;

  const system = `${RESEARCH_GUIDE}\n\nRespond with ONLY the JSON array. No code fences, no commentary.`;
  const userMsg = [
    `Company: ${company.company || "(unknown)"}`,
    `Role / context: ${company.role || "(unknown)"}`,
    `Person: ${company.contact_name || "(no name given)"}`,
    "",
    "LinkedIn profile:",
    profileBlock(company.source_profile),
  ].join("\n");

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: anthropicHeaders,
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 800,
        system,
        messages: [{ role: "user", content: userMsg }],
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(data?.error?.message || `Claude API returned ${res.status}`);
    }

    const arr = parseJsonArrayLoose(extractText(data));
    if (!arr) {
      return json({ error: "suggest_failed", message: "Could not read research suggestions." }, 502);
    }

    const prompts = arr
      .slice(0, MAX_PROMPTS)
      .map((p: any, i: number) => ({
        id: `r${i + 1}`,
        topic: p?.topic === "person" ? "person" : "company",
        question: clean(p?.question),
        query: clean(p?.query),
        status: "suggested" as const,
        selected: true,
      }))
      .filter((p) => p.question);

    await userClient
      .from("companies")
      .update({ research_prompts: prompts, updated_at: new Date().toISOString() })
      .eq("id", companyId);

    return json({ ok: true, prompts });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Something went wrong suggesting research.";
    return json({ error: "suggest_failed", message }, 502);
  }
});
