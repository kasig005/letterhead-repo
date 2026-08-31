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
is attached to the email as a file. Everything you say about the candidate's
experience must come from the material you are given below — their CV text (when
present), their template, or the extra instruction. Do not invent experience
that none of those mention.

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
4. One short paragraph of evidence about the candidate — but ONLY skills, tools,
   projects, datasets, employers, or roles that appear in the candidate's CV
   text, their template, or the extra instruction below. Pick the 1 to 3 most
   relevant to this recipient. If none of those sources gives you anything
   specific, write one general line about the candidate's background and field
   instead. Never fill this in with invented specifics.
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
- Name specific languages, tools, datasets, employers, or projects only when the
  candidate's CV text, template, or instruction gives them to you. Do not supply
  specifics the candidate did not provide.
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
- Do not invent facts about the company or the recipient. If you were not given
  something specific about the company, keep the interest reason about the role
  or field, not a guess.
- Do not invent ANY experience for the candidate — no project, employer, tool,
  skill, client, or activity that is not in their CV text, their template, or
  the extra instruction. If that leaves little to say about the candidate, say
  less. A short honest email beats a fluent invented one.
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
| Concreteness | 15 | Every specific claim about the candidate's experience (a named tool, project, employer, client, or activity) is traceable to the candidate's CV text, template, or the extra instruction. An invented specific — something none of those sources mentions — scores 0 here and must be named in the feedback. A general but honest background line loses no points. |
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

// Channel: "linkedin" — a short DM instead of an email. No subject, no CV line.
const LINKEDIN_GUIDE = `# LinkedIn message writing guide

Write a short LinkedIn direct message (a connection note or first DM) from a
job-seeking candidate to a specific person. No subject line. No attachment.

Match the candidate's real voice (from their template and any examples given):
direct, earnest, professional, no hype, no salesy call to action. First person.

## Structure

1. Greeting: "Hi [First name]," — or "Hi," if no name is given.
2. One line on who you are and why you're reaching out to *them* specifically.
3. One concrete, specific reason for the interest — tied to their work, their
   company, or, if research notes are provided, something recent and real from
   those. Prefer a fact over a compliment.
4. One short line of evidence about the candidate, drawn ONLY from their CV text,
   their template, or the extra instruction — a named skill, tool, project, or
   role they were actually said to have. If you have nothing specific, write one
   general line about their background instead. Do not invent it.
5. One soft, explicit ask with a small next step — a brief chat, a pointer,
   whether they're open to connecting about a specific thing.
6. Sign off with the candidate's first name (or full name). No "Kind regards".

## Length and style

- 40 to 110 words. Hard cap 130. This is a DM, not an email.
- 2 to 4 short sentences or tiny paragraphs.
- Contractions are fine ("I'm", "I've", "I'd").
- No em dashes. No emoji. At most one exclamation mark, only if warranted.
- No "I hope this finds you well", no corporate filler, no fake enthusiasm.
- Do not invent facts — not about the person, and not about the candidate's
  experience. Every claim about what the candidate has done must come from their
  CV text, their template, or the extra instruction. With no research notes,
  keep the interest reason about the role or field.
- No leftover placeholder tokens.

## Output format

Respond with ONLY a JSON object, no code fences, no commentary:

\`\`\`json
{"body": "..."}
\`\`\`

\`body\` is the full message: greeting, message, sign-off with the name. There is
no subject.
`;
const LINKEDIN_RUBRIC = `# LinkedIn message quality rubric

Grade a short LinkedIn DM from a job-seeking candidate against their voice.
Score strictly. Most drafts land in the 60s to 70s. Reserve 90+ for a message
that is genuinely in voice and needs no edits.

Score four categories and sum them for a total out of 100.

| Category | Points | What you are checking |
|---|---|---|
| Voice match | 30 | Earnest, direct, restrained. No hype, no effusive compliments, no salesy call to action. First-name sign-off, not "Kind regards". Any em dash, emoji, fake-enthusiasm word, or corporate cliche is a heavy deduction. |
| Personalisation | 30 | Names this person and their company or work. One specific reason that could not be reused for someone else. If research notes were provided, the message uses at least one concrete point from them. A generic message scores 0 here. Any unresolved \`{{...}}\` or \`[brackets]\` is an automatic 0. |
| Structure and ask | 20 | Brief self-introduction, exactly one soft explicit ask with a small next step, first-name sign-off, no second pitch after the ask. |
| Length and correctness | 20 | 40 to 130 words. No subject line. Company and person names spelled correctly. No invented facts about the company, the person, or the candidate's experience — any specific the candidate was not said to have scores this category down and is named in the feedback. No AI recap phrases ("In summary", "Overall"). |

## Output format

Respond with ONLY a JSON object, no code fences, no commentary:

\`\`\`json
{
  "score": 0,
  "breakdown": { "voice": 0, "personalisation": 0, "structure": 0, "length": 0 },
  "pass": false,
  "feedback": "Concrete rewrite instructions, not praise."
}
\`\`\`

\`score\` is the sum of \`breakdown\`. \`pass\` is \`true\` only when \`score >= 80\`.
`;

function extractText(msg: any): string {
  if (!msg || !Array.isArray(msg.content)) return "";
  return msg.content
    .filter((b: any) => b && b.type === "text")
    .map((b: any) => b.text || "")
    .join("");
}

// Profile + research context, appended to the writer's target block for both
// channels when present.
function profileAndResearchBlock(company: any): string {
  const parts: string[] = [];
  const sp = company?.source_profile;
  if (sp && typeof sp === "object") {
    const lines = [
      sp.headline && `  headline: ${sp.headline}`,
      sp.location && `  location: ${sp.location}`,
      (sp.current_title || sp.current_company) &&
        `  current: ${[sp.current_title, sp.current_company].filter(Boolean).join(" @ ")}`,
      Array.isArray(sp.past_roles) && sp.past_roles.length &&
        `  past: ${sp.past_roles.map((r: any) => [r?.title, r?.company].filter(Boolean).join(" @ ")).filter(Boolean).join("; ")}`,
      Array.isArray(sp.skills) && sp.skills.length && `  skills: ${sp.skills.join(", ")}`,
      sp.about && `  about: ${String(sp.about).slice(0, 500)}`,
    ].filter(Boolean);
    if (lines.length) parts.push("Captured LinkedIn profile of the contact:\n" + lines.join("\n"));
  }
  if (company?.research_notes) {
    parts.push(
      `Research notes — use concrete points from these, do not contradict them:\n  ${String(company.research_notes).slice(0, 1200)}`,
    );
  }
  return parts.length ? "\n\n" + parts.join("\n\n") : "";
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

  // CV text is extracted once, client-side, when the CV is uploaded — read it
  // here rather than re-parsing the file.
  const { data: cvRow } = await userClient
    .from("cv_files").select("cv_text").eq("user_id", userId).maybeSingle();
  const cvText = cvRow?.cv_text ? String(cvRow.cv_text).slice(0, 5000) : "";

  // The per-contact "brief" (companies.intent) is the default steer; an
  // explicit payload.instruction overrides it for a one-off.
  const instruction = String(payload?.instruction || company.intent || "").slice(0, 1000);
  const senderName = template?.your_name || "the candidate";
  const channel = (payload?.channel || company.channel) === "linkedin" ? "linkedin" : "email";

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
    `Channel: ${channel === "linkedin" ? "LinkedIn direct message" : "email"}`,
    `Company: ${company.company || "(unknown)"}`,
    `Role / context: ${company.role || "(unknown)"}`,
    `Contact: ${company.contact_name || "(no name given)"}`,
    `Candidate's name (sign-off): ${senderName}`,
    "",
    "The candidate's own template, as a guide to their voice and background —",
    `subject: ${template?.subject || "(empty)"}`,
    `body:\n${template?.body || "(empty)"}`,
    instruction ? `\nWhat this outreach is about (follow this closely, shape the whole message around it): ${instruction}` : "",
  ].join("\n")
    + (cvText ? `\n\nThe candidate's CV (their real experience — take any specific evidence from here):\n${cvText}` : "")
    + profileAndResearchBlock(company);

  const writerGuide = channel === "linkedin" ? LINKEDIN_GUIDE : WRITING_GUIDE;
  const judgeGuide = channel === "linkedin" ? LINKEDIN_RUBRIC : RUBRIC;
  const writerSystem = `${writerGuide}\n\nRespond with ONLY the JSON object described above. No code fences, no commentary.`;
  const judgeSystem = `${judgeGuide}\n\nRespond with ONLY the JSON object described above. No code fences, no commentary.`;

  await userClient.from("companies").update({ status: "generating", error: null }).eq("id", companyId);

  interface Judged { score: number; breakdown: Record<string, number>; feedback: string }

  try {
    let attempt = 0;
    let draft: { subject: string; body: string } | null = null;
    let judged: Judged | null = null;
    // The loop keeps the highest-scoring attempt, not just the most recent —
    // a revision can regress, and we don't want to lose a good earlier draft.
    let best: { draft: { subject: string; body: string }; judged: Judged; attempt: number } | null = null;

    while (attempt < MAX_ATTEMPTS) {
      attempt++;
      if (attempt > 1) {
        await userClient.from("companies").update({ status: "generating" }).eq("id", companyId);
      }

      const prevDraftBlock = channel === "linkedin"
        ? `Your previous message:\n${draft?.body}`
        : `Your previous draft:\nSubject: ${draft?.subject}\nBody:\n${draft?.body}`;
      const breakdownLine = judged && judged.breakdown && Object.keys(judged.breakdown).length
        ? `\n\nLast scores by rubric category: ${Object.entries(judged.breakdown).map(([k, v]) => `${k} ${v}`).join(", ")}. Concentrate your fixes on the lowest categories.`
        : "";
      const writerUser = judged && draft
        ? `${targetBlock}\n\n${prevDraftBlock}\n\nA judge scored that draft ${judged.score}/100 and asked for these specific fixes:\n${judged.feedback}${breakdownLine}\n\nRevise the draft so it addresses every point above. Keep the parts that already work; change only what the feedback calls out, and do not reintroduce problems from an earlier draft.`
        : `${targetBlock}\n\nWrite a first draft.`;

      const w = await callClaude(WRITER_MODEL, writerSystem, writerUser, 1200, "low");
      if (!w.parsed || !w.parsed.body) throw new Error("Writer did not return a usable draft.");
      draft = { subject: String(w.parsed.subject || "").trim(), body: String(w.parsed.body || "").trim() };

      await userClient.from("companies").update({ status: "scoring" }).eq("id", companyId);

      const judgeUser = channel === "linkedin"
        ? `Company: ${company.company || "(unknown)"}\nRole: ${company.role || "the role"}\nContact: ${company.contact_name || "(no name)"}\n\nMessage:\n${draft.body}`
        : `Company: ${company.company || "(unknown)"}\nRole: ${company.role || "the role"}\n\nSubject: ${draft.subject}\n\nBody:\n${draft.body}`;
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

      if (!best || judged.score > best.judged.score) {
        best = { draft: { ...draft }, judged: { ...judged }, attempt };
      }

      // The row always holds the best draft seen so far.
      const b = best;
      const draftCols = channel === "linkedin"
        ? { generated_linkedin: b.draft.body }
        : { generated_subject: b.draft.subject || null, generated_body: b.draft.body };
      await userClient.from("companies").update({
        ...draftCols,
        generated_at: new Date().toISOString(),
        quality_score: b.judged.score,
        quality_attempts: attempt,
        quality_feedback: b.judged.feedback,
        updated_at: new Date().toISOString(),
      }).eq("id", companyId);

      if (judged.score >= PASS_THRESHOLD) break;
    }

    const chosen = best!;
    const passed = chosen.judged.score >= PASS_THRESHOLD;

    // What the writer actually drew on — for the in-app "How it was made" portal.
    const trace = {
      channel,
      writer_model: WRITER_MODEL,
      judge_model: JUDGE_MODEL,
      generated_at: new Date().toISOString(),
      final_score: chosen.judged.score,
      attempts: attempt,
      best_attempt: chosen.attempt,
      threshold: PASS_THRESHOLD,
      passed,
      inputs: {
        contact: {
          company: company.company || "",
          role: company.role || "",
          contact_name: company.contact_name || "",
        },
        template_subject: template?.subject || "",
        template_body: (template?.body || "").slice(0, 4000),
        used_cv_text: !!cvText,
        cv_text_chars: cvText.length,
        cv_text_excerpt: cvText.slice(0, 1500),
        used_source_profile: !!company.source_profile,
        source_profile: company.source_profile || null,
        used_research_notes: !!company.research_notes,
        research_notes: company.research_notes || null,
        instruction: instruction || "",
      },
      writer_context: targetBlock.slice(0, 12000),
    };

    await userClient.from("companies").update({
      status: passed ? "pending" : "needs_review",
      error: passed
        ? null
        : `Best score ${chosen.judged.score}/100 (attempt ${chosen.attempt} of ${attempt}) — under the ${PASS_THRESHOLD} bar.`,
      generation_trace: trace,
      updated_at: new Date().toISOString(),
    }).eq("id", companyId);

    return json({
      ok: true,
      passed,
      channel,
      score: chosen.judged.score,
      attempts: attempt,
      bestAttempt: chosen.attempt,
      threshold: PASS_THRESHOLD,
      subject: channel === "linkedin" ? "" : chosen.draft.subject,
      body: chosen.draft.body,
      feedback: chosen.judged.feedback,
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
