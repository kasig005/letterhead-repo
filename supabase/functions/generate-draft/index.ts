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

const WRITING_GUIDE = await Deno.readTextFile(new URL("./prompts/writing-guide.md", import.meta.url));
const RUBRIC = await Deno.readTextFile(new URL("./prompts/rubric.md", import.meta.url));

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
