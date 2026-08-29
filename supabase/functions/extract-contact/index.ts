import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// extract-contact — Quick Add helper.
//
// Takes raw page text (a job posting, team page, LinkedIn profile, email
// signature, ...) and returns a single { company, role, contact_name,
// contact_email } object pulled straight from that text. One Claude call, no
// retry loop, no scoring. This function NEVER touches the database — the client
// inserts the companies row from the response.

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
const DEFAULT_EXTRACT_MODEL = "claude-haiku-4-5";
const MAX_TEXT = 20000;

// Prompt text is inlined here (not read from ./prompts/*.md at runtime): the
// Supabase deploy path used for this project does not bundle non-code asset
// files, so a Deno.readTextFile at boot crashes the worker before it can
// respond. The .md file in ./prompts/ is the editable source — re-inline it
// here by hand if you change it.
const EXTRACT_GUIDE = `# Contact extraction guide

You are given the raw text of a single web page or document — it might be a job
posting, a company "team" or "about" page, a LinkedIn profile, or an email
signature. Pull out who a job-seeking candidate would address a cold outreach
email to, and about what.

Return exactly ONE JSON object with exactly these four keys:

{"company": "", "role": "", "contact_name": "", "contact_email": ""}

## Field rules

- company — the hiring or target organisation itself. Never a job board, ATS, or
  recruiting platform: not "LinkedIn", "Indeed", "Greenhouse", "Workday",
  "Lever", "Ashby", "SmartRecruiters", "Glassdoor". If the page is a posting
  hosted on one of those, use the actual employer named in the posting.
- role — the specific job title if the text states one (e.g. "Backend Engineer",
  "Data Scientist, Forecasting"). If the page is a profile or team page with no
  single opening, leave it "".
- contact_name — a specific named person the email would go to (a hiring
  manager, recruiter, team lead, or the profile's owner) if the text names one.
  If no person is named, "".
- contact_email — ONLY an email address written verbatim in the text. Copy it
  exactly. NEVER build one from a name plus a company domain. NEVER guess a
  format. If the text contains no literal email address, "".

## General rules

- Any field you cannot fill from the text -> "" (an empty string). Never guess,
  never use a placeholder like "N/A" or "unknown", never use null.
- Do not invent, infer, or normalise. If the company name appears as "ACME"
  return "ACME", not "Acme Corporation".
- Prefer the most specific correct answer. If several roles are listed, pick the
  one the page is primarily about; if that is ambiguous, leave role "".

## Output format

Respond with ONLY the JSON object — no code fences, no commentary, no leading or
trailing text.
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
  const ANTHROPIC_WORKSPACE_ID = Deno.env.get("ANTHROPIC_WORKSPACE_ID");
  const MODEL = Deno.env.get("ANTHROPIC_EXTRACT_MODEL") || DEFAULT_EXTRACT_MODEL;

  const authHeader = req.headers.get("Authorization") || "";
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);

  let payload: any;
  try { payload = await req.json(); } catch { return json({ error: "bad_request", message: "Invalid JSON body" }, 400); }

  const rawText = payload?.text;
  if (typeof rawText !== "string" || !rawText.trim()) {
    return json({ error: "bad_request", message: "text is required" }, 400);
  }
  const pageText = rawText.slice(0, MAX_TEXT);

  if (!ANTHROPIC_API_KEY) {
    // The client treats this as "extraction unavailable" rather than a crash.
    return json({ error: "not_configured", message: "ANTHROPIC_API_KEY is not set on the server" }, 400);
  }

  const anthropicHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
  };
  // Identity-linked console keys reject the Messages API without this header.
  if (ANTHROPIC_WORKSPACE_ID) anthropicHeaders["anthropic-workspace-id"] = ANTHROPIC_WORKSPACE_ID;

  const system = `${EXTRACT_GUIDE}\n\nRespond with ONLY the JSON object. No code fences, no commentary.`;

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: anthropicHeaders,
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        system,
        messages: [{ role: "user", content: `Page text:\n\n${pageText}` }],
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(data?.error?.message || `Claude API returned ${res.status}`);
    }

    const parsed = parseJsonLoose(extractText(data));
    if (!parsed) {
      return json({ error: "extract_failed", message: "Could not read a contact from that text." }, 502);
    }

    const clean = (v: unknown) => String(v ?? "").trim();
    return json({
      ok: true,
      company: clean(parsed.company),
      role: clean(parsed.role),
      contact_name: clean(parsed.contact_name),
      contact_email: clean(parsed.contact_email),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Something went wrong reading that text.";
    return json({ error: "extract_failed", message }, 502);
  }
});
