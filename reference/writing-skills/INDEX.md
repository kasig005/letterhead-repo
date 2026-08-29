# Writing reference — vendored from Varnan-Tech/opendirectory

Source: https://github.com/Varnan-Tech/opendirectory/tree/main/skills
Downloaded 2026-08-29. These are read-only references for refining
`supabase/functions/generate-draft/prompts/writing-guide.md` and `rubric.md`.
Not wired into the app.

| File | What it gives you |
|---|---|
| `human-tone.SKILL.md` | **Start here.** 18 concrete "AI tell" patterns with before/after rewrites. Section 6 = cold-email tells. Full word blocklist in §11. "Voice Calibration" section (lines ~36-54) is exactly the method for building a from-samples voice guide. |
| `human-tone.README.md` | Short overview / how the skill is meant to be invoked. |
| `outreach-sequence-builder.SKILL.md` | Hard cold-email rules: body < 100 words, first sentence about THEM, only `{{first_name}}` as a variable, banned jargon list, each follow-up adds new value. |
| `outreach-sequence-builder.sequence-format.md` | The touch-by-touch structure of a sequence (what each email should do). |
| `outreach-sequence-builder.signal-playbook.md` | Per-trigger angles (post-fundraise, hiring, competitor switch, launch, etc.) — useful once Feature 2 (enrichment) feeds real signals. |
| `outreach-sequence-builder.output-template.md` | Example finished output format. |
| `claude-md-generator.SKILL.md` | How to write instruction files a model actually follows: tight, only non-obvious rules, no em dashes, concrete constraints over prose. Apply this to how `writing-guide.md` itself is written. |
| `claude-md-generator.section-guide.md` | Section-by-section rubric for the above. |
| `show-hn-writer.hn-rules.md` | Authentic-voice rules for a skeptical audience — anti-hype, plain claims. |
| `linkedin-post-generator.linkedin-format.md` | Another worked "voice -> rules" spec, useful as a structural template for our own guide. |

## Takeaways to fold into `writing-guide.md`

- Replace the current vague "be warm and direct" guidance with **checkable rules**
  (word blocklist, length cap, "first line is about them", contraction style).
- Add an explicit **banned-phrase list** (from human-tone §6 + §11).
- Keep the body **under ~100 words** (tighter than the current 90-150).
- Every draft must be **complete** — no `[bracket]` placeholders, only `{{first_name}}`.
- The guide file itself: no em dashes, bullet rules not paragraphs (claude-md-generator).
- Real personalization needs real facts — pairs with Feature 2 (enrichment); until then
  keep the hook on the role, not guessed company facts.
