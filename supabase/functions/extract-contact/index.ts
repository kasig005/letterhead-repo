import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// extract-contact — Quick Add helper.
//
// Takes raw page text (a job posting, team page, LinkedIn profile, email
// signature, ...) plus a `kind` hint and returns the fields a cold-outreach
// row needs. One Claude call, no retry loop, no scoring. This function NEVER
// touches the database — the client inserts the companies row from the
// response.
//
// Request:  { text: string, kind?: "page" | "linkedin", url?: string }
// Response: { ok: true, company, role, contact_name, contact_email,
//             source_profile? }   (source_profile only when kind === "linkedin")

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

You are given the raw text of a single web page or document, plus a \`kind\`
hint (\`page\` or \`linkedin\`). Pull out who a job-seeking candidate would address
outreach to, and about what.

## Always return

ONE JSON object with these keys:

{"company": "", "role": "", "contact_name": "", "contact_email": ""}

- company — the hiring or target organisation. Never a job board or ATS
  (LinkedIn, Indeed, Greenhouse, Workday, Lever, Ashby, SmartRecruiters,
  Glassdoor). On a posting hosted by one of those, use the real employer named
  in the posting. On a LinkedIn profile, use the person's CURRENT employer.
- role — the specific job title the outreach is about. On a job posting, the
  posted title. On a LinkedIn profile, the person's current title. If none is
  clear, "".
- contact_name — a specific named person to address. On a profile, the profile
  owner. On a posting, a named hiring manager or recruiter if the text names
  one, else "".
- contact_email — ONLY an email address written verbatim in the text. Copy it
  exactly. NEVER construct one from a name plus a company domain. NEVER guess a
  format. If the text has no literal address, "". An arbitration, legal, press,
  or generic abuse address is not a hiring contact — leave contact_email ""
  unless the address is clearly for reaching this person or their team.

## When kind is "linkedin"

Also include a \`source_profile\` object:

{
  "name": "",
  "headline": "",
  "location": "",
  "about": "",
  "current_title": "",
  "current_company": "",
  "past_roles": [ {"title": "", "company": ""} ],
  "skills": [ "" ]
}

- Fill only from the text. Anything absent -> "" or [].
- about — the profile's About / summary section, copied verbatim then trimmed to
  about 600 characters. Do not paraphrase.
- past_roles — previous positions, most recent first, at most 5.
- skills — listed skills or clearly recurring themes, at most 10.
- Ignore page furniture: "People you may know", "Promoted", "Activity",
  follower / connection counts, "Show all", navigation, cookie notices.

## General rules

- Any field you cannot fill -> "" or []. Never guess, never "N/A" / "unknown",
  never null.
- Do not normalise names. "ACME" stays "ACME", not "Acme Corporation".
- Prefer the most specific correct answer. If several roles are listed, pick the
  one the page is primarily about; if ambiguous, leave role "".

## Output

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

const clean = (v: unknown) => String(v ?? "").trim();

function normaliseProfile(raw: any, profileUrl: string) {
  const p = raw && typeof raw === "object" ? raw : {};
  const roles = Array.isArray(p.past_roles) ? p.past_roles : [];
  const skills = Array.isArray(p.skills) ? p.skills : [];
  return {
    name: clean(p.name),
    headline: clean(p.headline),
    location: clean(p.location),
    about: clean(p.about).slice(0, 800),
    current_title: clean(p.current_title),
    current_company: clean(p.current_company),
    past_roles: roles
      .slice(0, 5)
      .map((r: any) => ({ title: clean(r?.title), company: clean(r?.company) }))
      .filter((r: any) => r.title || r.company),
    skills: skills.slice(0, 10).map(clean).filter(Boolean),
    profile_url: profileUrl,
  };
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
  const kind = payload?.kind === "linkedin" ? "linkedin" : "page";
  const profileUrl = typeof payload?.url === "string" ? payload.url.slice(0, 500) : "";

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
  const userMsg = `kind: ${kind}\n${profileUrl ? `url: ${profileUrl}\n` : ""}\nPage text:\n\n${pageText}`;

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: anthropicHeaders,
      body: JSON.stringify({
        model: MODEL,
        max_tokens: kind === "linkedin" ? 1200 : 400,
        system,
        messages: [{ role: "user", content: userMsg }],
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

    const out: Record<string, unknown> = {
      ok: true,
      company: clean(parsed.company),
      role: clean(parsed.role),
      contact_name: clean(parsed.contact_name),
      contact_email: clean(parsed.contact_email),
    };
    if (kind === "linkedin") {
      out.source_profile = normaliseProfile(parsed.source_profile, profileUrl);
    }
    return json(out);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Something went wrong reading that text.";
    return json({ error: "extract_failed", message }, 502);
  }
});
