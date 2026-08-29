import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

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

function sanitizeHeader(s: string) {
  return String(s || "").replace(/[\r\n]+/g, " ").trim();
}

function firstName(name: string) {
  const n = (name || "").trim().split(/\s+/)[0];
  return n || "there";
}

function mergeTemplate(row: any, tpl: any) {
  const fn = firstName(row.contact_name);
  const sub = (s: string) =>
    (s || "")
      .replaceAll("{{company}}", row.company || "")
      .replaceAll("{{role}}", row.role || "the role")
      .replaceAll("{{contactFirstName}}", fn)
      .replaceAll("{{contactName}}", row.contact_name || "")
      .replaceAll("{{yourName}}", tpl.your_name || "");
  return { subject: sub(tpl.subject), body: sub(tpl.body) };
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function toBase64Url(b64: string) {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function wrapBase64(b64: string) {
  return b64.replace(/(.{76})/g, "$1\r\n");
}

function buildMimeMessage(opts: {
  to: string; subject: string; body: string;
  attachment: { filename: string; mimeType: string; base64: string };
}) {
  const boundary = "bnd_" + crypto.randomUUID().replace(/-/g, "");
  const subjectEncoded = /[^\x00-\x7F]/.test(opts.subject)
    ? `=?UTF-8?B?${bytesToBase64(new TextEncoder().encode(opts.subject))}?=`
    : opts.subject;

  const lines = [
    `To: ${sanitizeHeader(opts.to)}`,
    `Subject: ${sanitizeHeader(subjectEncoded)}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    wrapBase64(bytesToBase64(new TextEncoder().encode(opts.body))),
    ``,
    `--${boundary}`,
    `Content-Type: ${sanitizeHeader(opts.attachment.mimeType)}; name="${sanitizeHeader(opts.attachment.filename)}"`,
    `Content-Disposition: attachment; filename="${sanitizeHeader(opts.attachment.filename)}"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    wrapBase64(opts.attachment.base64),
    ``,
    `--${boundary}--`,
    ``,
  ];
  return lines.join("\r\n");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID");
  const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET");

  const authHeader = req.headers.get("Authorization") || "";
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);
  const userId = userData.user.id;

  let payload: any;
  try { payload = await req.json(); } catch { return json({ error: "bad_request", message: "Invalid JSON body" }, 400); }
  const companyId = payload?.companyId;
  if (!companyId) return json({ error: "bad_request", message: "companyId is required" }, 400);

  const { data: company, error: companyErr } = await userClient
    .from("companies").select("*").eq("id", companyId).single();
  if (companyErr || !company) return json({ error: "not_found", message: "Company not found" }, 404);

  if (!company.contact_email || !company.contact_email.includes("@")) {
    await userClient.from("companies").update({ status: "error", error: "Missing or invalid contact email", updated_at: new Date().toISOString() }).eq("id", companyId);
    return json({ error: "bad_request", message: "Missing or invalid contact email" }, 400);
  }

  const { data: template } = await userClient.from("templates").select("*").eq("user_id", userId).single();
  const { data: cvMeta } = await userClient.from("cv_files").select("*").eq("user_id", userId).single();

  if (!cvMeta) {
    await userClient.from("companies").update({ status: "error", error: "No CV uploaded yet", updated_at: new Date().toISOString() }).eq("id", companyId);
    return json({ error: "no_cv", message: "Upload a CV first" }, 400);
  }

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return json({ error: "not_configured", message: "Google OAuth credentials are not configured on the server yet" }, 500);
  }

  await userClient.from("companies").update({ status: "creating", error: null }).eq("id", companyId);

  try {
    const { data: tokenRow, error: tokenErr } = await adminClient
      .from("google_tokens").select("refresh_token").eq("user_id", userId).single();
    if (tokenErr || !tokenRow) throw new Error("Google account not connected — sign in again and allow Gmail access.");

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: tokenRow.refresh_token,
        grant_type: "refresh_token",
      }),
    });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok || !tokenJson.access_token) {
      throw new Error("Couldn't refresh your Google access — reconnect Gmail and try again.");
    }
    const accessToken = tokenJson.access_token;

    const { data: cvBlob, error: cvErr } = await adminClient.storage.from("cv-files").download(cvMeta.storage_path);
    if (cvErr || !cvBlob) throw new Error("Couldn't read your stored CV file.");
    const cvBytes = new Uint8Array(await cvBlob.arrayBuffer());
    const cvBase64 = bytesToBase64(cvBytes);

    // Prefer an LLM-generated draft (Feature 1, written by the generate-draft
    // function) when the row has one; otherwise fall back to naive token merge.
    const fallback = mergeTemplate(company, template || {});
    const hasGenerated = typeof company.generated_body === "string" && company.generated_body.trim().length > 0;
    const finalSubject = hasGenerated
      ? (company.generated_subject && company.generated_subject.trim().length > 0
          ? company.generated_subject
          : fallback.subject)
      : fallback.subject;
    const finalBody = hasGenerated ? company.generated_body : fallback.body;

    const mime = buildMimeMessage({
      to: company.contact_email,
      subject: finalSubject,
      body: finalBody,
      attachment: { filename: cvMeta.filename, mimeType: cvMeta.mime_type, base64: cvBase64 },
    });
    const rawMessage = toBase64Url(bytesToBase64(new TextEncoder().encode(mime)));

    const draftRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: { raw: rawMessage } }),
    });
    const draftJson = await draftRes.json();
    if (!draftRes.ok) {
      throw new Error(draftJson?.error?.message || "Gmail rejected this draft.");
    }

    await userClient.from("companies").update({
      status: "drafted", error: null, draft_id: draftJson.id, updated_at: new Date().toISOString(),
    }).eq("id", companyId);

    return json({ ok: true, draftId: draftJson.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Something went wrong creating this draft.";
    await userClient.from("companies").update({ status: "error", error: message, updated_at: new Date().toISOString() }).eq("id", companyId);
    return json({ error: "draft_failed", message }, 502);
  }
});
