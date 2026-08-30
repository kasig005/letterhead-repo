# Research suggestion guide

> Editable source. This text is also inlined as the `RESEARCH_GUIDE` string
> constant in `../index.ts` — the deploy path used for this project (Supabase
> MCP / Management API) ships only `.ts`/`.js`, so the function cannot read this
> file at runtime. If you edit this guide, re-paste it into that constant by
> hand.

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
