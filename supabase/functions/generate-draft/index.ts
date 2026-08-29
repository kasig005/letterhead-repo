import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// generate-draft — Feature 1 + quality gate.
//
// writer -> judge loop: Claude drafts a tailored subject/body, a second Claude
// call scores it 0-100 against prompts/rubric.md, and anything under
// PASS_THRESHOLD is rewritten with the feedback, up to MAX_ATTEMPTS. The result
// (best draft, score, attempts, feedback) is stored on the companies row. A
// draft that never clears the bar leaves the row as `needs_review`; create-draft
// refuses to push such a row to Gmail unless the caller passes { force: true }.
// This function never touches Gmail itself.

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
const MAX_ATTEMPTS = 3;
const PASS_THRESHOLD = 80;
// Writer: a capable model (override with ANTHROPIC_MODEL). Judge: fast + cheap;
// a strong model isn't needed to score against an explicit rubric.
const DEFAULT_WRITER_MODEL = "claude-opus-5";
const DEFAULT_JUDGE_MODEL = "claude-haiku-4-5";

// Prompt text is inlined here (not read from ./prompts/*.md at runtime): the
// Supabase deploy path used for this project does not bundle non-code asset
// files, so a Deno.readTextFile at boot crashes the worker. The .md files in
// ./prompts/ remain the editable source — re-inline them here if you change them.
const WRITING_GUIDE = `# Cold email writing guide

You are drafting a short cold outreach email for a job-seeking candidate, to a
specific person at a specific company about a specific role or opportunity. A CV
is attached separately. Do not summarise the whole CV; give just enough concrete
evidence to earn a reply.

Match the candidate's real voice, described below. This voice was reverse-engineered
from the candidate's own sent emails. The sign-off name and any personal details
come from the context block you are given, not from this guide.

## Voice

- Direct, earnest, curious, professional. Not polished, not salesy, not effusive.
- First person throughout. Say who you are, why you are writing, and why this
  recipient specifically.
- Show interest with one concrete, specific reason, then connect it to the
  candidate's own experience.
- Restrained warmth. Use "really appreciate", "really interested", "keen",
  "would welcome". Avoid hype.
- Formality about 3.5 out of 5 for cold outreach.

## Greeting and sign-off

- Named person: \`Hi [First name],\`
- General inbox or no name given: \`Hi,\`
- Formal institution or team: \`Dear [Team or Name],\`
- Default sign-off: \`Kind regards,\` then the candidate's full name on the next line.
- Advice or networking email: \`Best regards,\` then the full name.
- "I hope you are well." or "Hope you're well." as a short second line is in voice
  and fine. Never "I hope this email finds you well."

## Structure

1. Greeting.
2. One-line self-introduction on cold outreach: name, course and year, university,
   and what you are asking about. If there is a prior link (an event attended, a
   referral, an earlier conversation, a follow-up), lead with that instead.
3. One specific reason this company or person interests you. Concrete, not a
   paragraph that could come from their homepage.
4. One short paragraph of concrete evidence: 1 to 3 real skills, tools, projects,
   datasets, or past roles. Prefer nouns and examples over claims about passion
   or excellence.
5. One clear, softened ask. Patterns that fit the voice: "If there is any scope
   for...", "I would welcome the chance to...", "I was wondering if you'd be open
   to...", "Would it be possible to...", "I would be grateful if you could...".
   Keep the next step small: a short call, brief conversation, advice, an
   interview slot, shadowing.
6. One line of thanks, then the sign-off. No second pitch after the ask.
7. If a CV is attached, one plain line: "I have attached my CV for reference."

## Length

- Body 120 to 200 words. Hard cap 220.
- 4 to 6 short paragraphs, 1 to 3 sentences each. No single dense block.

## Contractions

- Conversational sentences: "I'm", "I've", "I'd", "you're".
- Formal or factual sentences, especially the self-introduction: "I am", "I have",
  "I would".
- Mixed is correct. Do not force one form throughout.

## Do

- Include one recipient-specific detail that proves the email is not a template.
- State technical evidence concretely: name the languages, tools, datasets,
  employers, projects.
- Keep the ask polite and explicit.
- These phrases are in voice and fine to use: "I wanted to reach out", "I am
  writing to ask", "I was wondering", "I would welcome the chance", "I would
  really appreciate".

## Never

- No em dashes. Use a comma, a full stop, or "and".
- No emoji.
- No more than one exclamation mark, and only if rapport clearly exists.
- Not "I hope this email finds you well", "Dear Sir/Madam", "To whom it may concern".
- No corporate filler: "circle back", "touch base", "leverage synergies",
  "low-hanging fruit", "move the needle", "game-changer", "value-add",
  "uniquely positioned", "diverse skill set".
- No fake enthusiasm: "thrilled", "super excited", "incredibly excited",
  "absolutely delighted", unless genuinely warranted.
- No over-complimenting the recipient or company.
- No homepage-style company-summary paragraph.
- No more than one ask per email.
- No AI recap: "In summary", "Overall", "To conclude".
- No inflated transitions: "Furthermore", "Moreover", "Additionally", "It is worth
  noting", where a plain sentence works.
- Do not make every sentence the same length or every paragraph symmetrical.
- Do not invent facts about the company, the person, or the candidate. If you were
  not given something specific about the company, keep the interest reason about
  the role or field, not a guess.
- No leftover placeholder tokens (\`{{...}}\` or \`[brackets]\`) in the output.

## Output format

Respond with only a JSON object, no code fences, no commentary:

\`\`\`json
{"subject": "...", "body": "..."}
\`\`\`

- \`subject\` short and specific, in the style of the candidate's real subjects:
  "Internship Enquiry - Data Science / ML Engineering", "Seeking Advice on Getting
  Started in Property Investment". Never "Application" or "Job Inquiry".
- \`body\` contains the full email: greeting, paragraphs, thanks, sign-off, name.
`;
const RUBRIC = `# Cold email quality rubric

You are grading a cold outreach email written to match one specific candidate's
voice, defined in the writing guide. Grade against that voice, not against a
generic idea of a good cold email. Score strictly. Most drafts should land in the
60s to 70s. Reserve 90+ for an email that is genuinely in voice and needs no edits.

Score five categories and sum them for a total out of 100.

| Category | Points | What you are checking |
|---|---|---|
| Voice match | 30 | Reads as earnest, direct, restrained. No hype, no effusive compliments, no salesy call to action. Correct greeting form and correct sign-off (\`Kind regards,\` or \`Best regards,\` then the candidate's full name). Formality around 3.5 out of 5. Any em dash, emoji, fake-enthusiasm word, or banned corporate phrase from the guide's Never list is a heavy deduction. |
| Personalisation | 25 | Names this company and this role or opportunity. Contains at least one specific recipient detail that could not be reused for another company. A generic homepage-style paragraph scores 0 here. Any unresolved \`{{...}}\` or \`[brackets]\` is an automatic 0 for the whole category. |
| Structure and ask | 20 | Self-introduction present on cold outreach, or a prior-link opener. Exactly one softened, explicit ask using a pattern from the guide. Small next step. One line of thanks then sign-off, with no second pitch after the ask. A plain CV line present if a CV is attached. |
| Concreteness | 15 | Evidence is specific: named tools, languages, datasets, employers, projects. Not claims about passion, excellence, or being a great fit without backing. |
| Length and correctness | 10 | Body within 120 to 220 words, in 4 to 6 short paragraphs. Company name spelled correctly. No invented facts about the company or candidate. No AI recap or inflated transitions. |

## Output format

Respond with only a JSON object, no code fences, no commentary:

\`\`\`json
{
  "score": 0,
  "breakdown": {
    "voice": 0,
    "personalisation": 0,
    "structure": 0,
    "concreteness": 0,
    "length": 0
  },
  "pass": false,
  "feedback": "Concrete rewrite instructions, not praise. Point at exact phrases to cut or change and say what to replace them with."
}
\`\`\`

\`score\` is the sum of \`breakdown\`. \`pass\` is \`true\` only when \`score >= 80\`.
\`feedback\` must be specific enough that a rewrite from scratch, using only your
feedback, would fix the problems, for example "Cut 'I am incredibly passionate
about your mission', it is hype. Replace with one concrete sentence naming what
the company builds and why that field interests the candidate."
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
  const WRITER_MODEL = Deno.env.get("ANTHROPIC_MODEL") || DEFAULT_WRITER_MODEL;
  const JUDGE_MODEL = Deno.env.get("ANTHROPIC_JUDGE_MODEL") || DEFAULT_JUDGE_MODEL;

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
    // create-draft will fall back to template merge; the client treats this as
    // "skip generation" rather than a hard failure.
    return json({ error: "not_configured", message: "ANTHROPIC_API_KEY is not set on the server" }, 400);
  }

  const { data: company, error: companyErr } = await userClient
    .from("companies").select("*").eq("id", companyId).single();
  if (companyErr || !company) return json({ error: "not_found", message: "Company not found" }, 404);

  const { data: template } = await userClient
    .from("templates").select("*").eq("user_id", userId).single();

  const instruction = payload?.instruction ? String(payload.instruction).slice(0, 1000) : "";
  const senderName = template?.your_name || "the candidate";

  const anthropicHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
  };
  if (ANTHROPIC_WORKSPACE_ID) anthropicHeaders["anthropic-workspace-id"] = ANTHROPIC_WORKSPACE_ID;

  async function callClaude(model: string, system: string, userText: string, maxTokens: number, effort?: string) {
    const body: any = {
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userText }],
    };
    if (effort) body.output_config = { effort };
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: anthropicHeaders,
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(data?.error?.message || `Claude API returned ${res.status}`);
    }
    return { parsed: parseJsonLoose(extractText(data)), model: data?.model || model };
  }

  const targetBlock = [
    `Company: ${company.company || "(unknown)"}`,
    `Role / context: ${company.role || "(unknown)"}`,
    `Contact: ${company.contact_name || "(no name given)"}`,
    `Candidate's name (sign-off): ${senderName}`,
    "",
    "The candidate's own template, as a guide to their voice and background —",
    `subject: ${template?.subject || "(empty)"}`,
    `body:\n${template?.body || "(empty)"}`,
    instruction ? `\nExtra instruction from the candidate: ${instruction}` : "",
  ].join("\n");

  const writerSystem = `${WRITING_GUIDE}\n\nRespond with ONLY the JSON object described above. No code fences, no commentary.`;
  const judgeSystem = `${RUBRIC}\n\nRespond with ONLY the JSON object described above. No code fences, no commentary.`;

  await userClient.from("companies").update({ status: "generating", error: null }).eq("id", companyId);

  try {
    let attempt = 0;
    let draft: { subject: string; body: string } | null = null;
    let judged: { score: number; breakdown: Record<string, number>; feedback: string } | null = null;

    while (attempt < MAX_ATTEMPTS) {
      attempt++;
      if (attempt > 1) {
        await userClient.from("companies").update({ status: "generating" }).eq("id", companyId);
      }

      const writerUser = judged && draft
        ? `${targetBlock}\n\nYour previous draft:\nSubject: ${draft.subject}\nBody:\n${draft.body}\n\nJudge feedback (fix these specific issues):\n${judged.feedback}\n\nWrite a revised draft that addresses this feedback.`
        : `${targetBlock}\n\nWrite a first draft.`;

      const w = await callClaude(WRITER_MODEL, writerSystem, writerUser, 1200, "low");
      if (!w.parsed || !w.parsed.body) throw new Error("Writer did not return a usable draft.");
      draft = { subject: String(w.parsed.subject || "").trim(), body: String(w.parsed.body || "").trim() };

      await userClient.from("companies").update({ status: "scoring" }).eq("id", companyId);

      const judgeUser = `Company: ${company.company || "(unknown)"}\nRole: ${company.role || "the role"}\n\nSubject: ${draft.subject}\n\nBody:\n${draft.body}`;
      const j = await callClaude(JUDGE_MODEL, judgeSystem, judgeUser, 800);
      if (!j.parsed || typeof j.parsed.score !== "number") throw new Error("Judge did not return a usable score.");
      judged = {
        score: Math.round(j.parsed.score),
        breakdown: j.parsed.breakdown || {},
        feedback: String(j.parsed.feedback || "").trim(),
      };

      // Audit row — best effort, don't fail the loop over it.
      await userClient.from("email_revisions").insert({
        company_id: companyId, user_id: userId, attempt,
        subject: draft.subject, body: draft.body,
        score: judged.score, breakdown: judged.breakdown, feedback: judged.feedback,
      });

      await userClient.from("companies").update({
        generated_subject: draft.subject || null,
        generated_body: draft.body,
        generated_at: new Date().toISOString(),
        quality_score: judged.score,
        quality_attempts: attempt,
        quality_feedback: judged.feedback,
        updated_at: new Date().toISOString(),
      }).eq("id", companyId);

      if (judged.score >= PASS_THRESHOLD) break;
    }

    const passed = !!judged && judged.score >= PASS_THRESHOLD;

    await userClient.from("companies").update({
      status: passed ? "pending" : "needs_review",
      error: passed
        ? null
        : `Best score ${judged?.score ?? 0}/100 after ${attempt} attempt(s) — under the ${PASS_THRESHOLD} bar.`,
      updated_at: new Date().toISOString(),
    }).eq("id", companyId);

    return json({
      ok: true,
      passed,
      score: judged?.score ?? 0,
      attempts: attempt,
      threshold: PASS_THRESHOLD,
      subject: draft?.subject ?? "",
      body: draft?.body ?? "",
      feedback: judged?.feedback ?? "",
      writerModel: WRITER_MODEL,
      judgeModel: JUDGE_MODEL,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Something went wrong writing this draft.";
    await userClient.from("companies").update({
      status: "error", error: message, updated_at: new Date().toISOString(),
    }).eq("id", companyId);
    return json({ error: "generate_failed", message }, 502);
  }
});
