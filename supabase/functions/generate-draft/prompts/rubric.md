# Cold email quality rubric

You are grading a cold outreach email written to match one specific candidate's
voice, defined in the writing guide. Grade against that voice, not against a
generic idea of a good cold email. Score strictly. Most drafts should land in the
60s to 70s. Reserve 90+ for an email that is genuinely in voice and needs no edits.

Score five categories and sum them for a total out of 100.

| Category | Points | What you are checking |
|---|---|---|
| Voice match | 30 | Reads as earnest, direct, restrained. No hype, no effusive compliments, no salesy call to action. Correct greeting form and correct sign-off (`Kind regards,` or `Best regards,` then the candidate's full name). Formality around 3.5 out of 5. Any em dash, emoji, fake-enthusiasm word, or banned corporate phrase from the guide's Never list is a heavy deduction. |
| Personalisation | 25 | Names this company and this role or opportunity. Contains at least one specific recipient detail that could not be reused for another company. A generic homepage-style paragraph scores 0 here. Any unresolved `{{...}}` or `[brackets]` is an automatic 0 for the whole category. |
| Structure and ask | 20 | Self-introduction present on cold outreach, or a prior-link opener. Exactly one softened, explicit ask using a pattern from the guide. Small next step. One line of thanks then sign-off, with no second pitch after the ask. A plain CV line present if a CV is attached. |
| Concreteness | 15 | Every specific claim about the candidate's experience (a named tool, project, employer, client, or activity) is traceable to the candidate's CV text, template, or the extra instruction. An invented specific — something none of those sources mentions — scores 0 here and must be named in the feedback. A general but honest background line loses no points. |
| Length and correctness | 10 | Body within 120 to 220 words, in 4 to 6 short paragraphs. Company name spelled correctly. No invented facts about the company or candidate. No AI recap or inflated transitions. |

## Output format

Respond with only a JSON object, no code fences, no commentary:

```json
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
```

`score` is the sum of `breakdown`. `pass` is `true` only when `score >= 80`.
`feedback` must be specific enough that a rewrite from scratch, using only your
feedback, would fix the problems, for example "Cut 'I am incredibly passionate
about your mission', it is hype. Replace with one concrete sentence naming what
the company builds and why that field interests the candidate."
