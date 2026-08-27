# Oxygen contributor agent instructions

When a user asks to use the Oxygen Contributor Kit to collect, organize, review, or package project
history, use this file as the initial routing contract:

1. Resolve and verify the contributor-approved target project or input boundary.
2. Before collection, load the organizer Skill and start its sanitized Workflow Progress surface.
   Surface the exact localhost URL and keep one canonical local Viewer/run through the workflow.
3. Keep the final public workflow in this order: Collect, Organize, upstream source Privacy
   preparation, Build Project Story with bounded semantic workers, independent global sparse
   Insight pass, Story/Release Privacy candidate preparation, Preference-question generation,
   Project Story human review, Privacy Keep/Redact decisions, Preference answers, All set,
   local reviewed release.
4. Load a stage's owning Skill when that stage begins, then open only the specific contracts that
   Skill requires for the current work.

Stage ownership:

- **Target / Collect** — `skills/oxygen-ingest-project-history/SKILL.md`.
- **Organize / Viewer orchestration** — `skills/oxygen-organize-review-export/SKILL.md`.
- **Upstream source Privacy preparation** — `tools/llm_redact/REDACTION_PROMPT.md` and the existing
  reviewed-boundary tooling.
- **Build Project Story, Insight pass, and Story/Release Privacy candidate preparation** —
  delegate to `skills/oxygen-storytelling-review/SKILL.md` only after upstream source Privacy
  produces the privacy-prepared reviewed input.
- **Preference-question generation** —
  `skills/oxygen-elicit-contributor-preferences/SKILL.md` after reusable lessons and generated
  Insight candidates exist, using that same reviewed input without reopening raw history or
  rerunning Privacy. Generated questions are not confirmed preferences.
- **Project Story human review** — the Story Skill; load its review lifecycle only when human
  review begins.
- **Release handoff** — the organizer/export Skill plus canonical release validation.

Pause for the contributor at Project Story human review, Privacy Keep/Redact decisions, Preference
answers, `All set`, and release handoff. Do not fabricate Story edits, Privacy decisions,
preference answers, `All set`, or release/publication approval. Never widen the approved input
boundary, read credential or browser-profile data, upload automatically, or publish automatically.
`All set`, ZIP creation, download, and publication are separate; keep `publication_approved=false`
unless a separate future publication workflow exists.

Consult `README.md` for public or user-documentation questions. Consult `SOP.md` when a human asks
for the complete process, a stage interface remains unresolved after reading its owning Skill, or a
maintainer is auditing workflow ownership. Neither document is mandatory startup context for a
normal contributor workflow.
