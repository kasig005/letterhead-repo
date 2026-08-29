# Contact extraction guide

> Editable source. This text is also inlined as the `EXTRACT_GUIDE` string
> constant in `../index.ts` — the deploy path used for this project (Supabase
> MCP / Management API) ships only `.ts`/`.js`, so the function cannot read this
> file at runtime. If you edit this guide, re-paste it into that constant by
> hand.

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
