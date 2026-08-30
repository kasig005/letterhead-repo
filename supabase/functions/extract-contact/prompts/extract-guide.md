# Contact extraction guide

> Editable source. This text is also inlined as the `EXTRACT_GUIDE` string
> constant in `../index.ts` — the deploy path used for this project (Supabase
> MCP / Management API) ships only `.ts`/`.js`, so the function cannot read this
> file at runtime. If you edit this guide, re-paste it into that constant by
> hand.

You are given the raw text of a single web page or document, plus a `kind`
hint (`page` or `linkedin`). Pull out who a job-seeking candidate would address
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

Also include a `source_profile` object:

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
