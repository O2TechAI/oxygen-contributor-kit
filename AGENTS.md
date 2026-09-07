# Oxygen contributor agent instructions

When a user asks to use the Oxygen Contributor Kit to collect, organize, review, or package project
history, use this file as the initial routing contract:

1. Resolve and verify the contributor-approved target project or input boundary.
2. Before collection, load the organizer Skill and start its sanitized Workflow Progress surface.
   Surface the exact localhost URL and keep one canonical local Viewer/run through the workflow.
3. Keep the final public workflow in this order: Collect, Organize, upstream source Privacy
   preparation as mandatory release authority, Build Project Story with bounded semantic workers,
   independent global sparse
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
  establishes the reviewed source authority. The workflow parent selects Story owners from, and
  gives Story and Insight workers, the exact bound raw reviewed narrative through the
  contributor-selected current provider. Source Privacy spans are mandatory for release; they are
  not applied to that narrative before Story authoring.
- **Preference-question generation** —
  `skills/oxygen-elicit-contributor-preferences/SKILL.md` after reusable lessons and generated
  Insight candidates exist, using that same reviewed input without reopening raw history or
  rerunning Privacy. Generated questions are not confirmed preferences.
- **Project Story human review** — the Story Skill; load its review lifecycle only when human
  review begins.
- **Release handoff** — the organizer/export Skill plus canonical release validation.

Repository-development Agents are outside the Toolkit runtime contract. Official documentation, code identifiers,
comments, and default UI copy use English; preserve explicitly bilingual/localized text, source-language
content, quotations, and language-specific test data. Runtime workers read only
one assigned immutable input and write only its proposal. The parent alone runs recorders and
finalizers, installs authority, proves exact union/no overlap, mutates Viewer state, and waits for
terminal receipts. Workers never reopen raw history, expand scope, or repair another lane.
The common ceiling is three live host subagents and one initial proposal plus at most two
parent-orchestrated proposal-only corrections against unchanged input. Only a stage's fixed safe
pre-receipt authoring-validation code permits correction; authority, immutability, containment,
path, I/O, infrastructure, and corrupt-state failures stop immediately. Exhaustion stops the lane,
except for the narrow Story editorial takeover defined in its transport. Installed outputs and
receipts remain immutable. Stage contracts define their execution and terminal gates.

Use the existing role-specific dispatch contracts; do not copy them into a second prompt protocol:

- Organization mapping: read [Mapping proposal](skills/oxygen-organize-review-export/references/project-map-contract.md#mapping-proposal); registry preparation and orchestration remain parent-owned in the Organize Skill.
- Story, Insight, Story Privacy, and Preference: [worker reading routes](skills/oxygen-storytelling-review/references/story-preparation-transport.md#worker-reading-routes) and [dispatch and recording](skills/oxygen-storytelling-review/references/story-preparation-transport.md#dispatch-and-recording). The parent must convey the exact lane's reading route, actual generated inputPath, and proposal destination before dispatch.
- Source Privacy: the canonical REDACTION_PROMPT above; verification, merge, apply, and receipts remain parent-owned.

Pause for the contributor at Project Story human review, Privacy Keep/Redact decisions, Preference
answers, `All set`, and release handoff. These explicit review and decision boundaries are the only
contributor pauses. Do not fabricate Story edits, Privacy decisions,
preference answers, `All set`, or release/publication approval. Never widen the approved input
boundary, read credential or browser-profile data, upload automatically, or publish automatically.
`All set`, ZIP creation, download, and publication are separate; keep `publication_approved=false`
unless a separate future publication workflow exists.

Consult `README.md` for public or user-documentation questions. Consult `SOP.md` when a human asks
for the complete process, a stage interface remains unresolved after reading its owning Skill, or a
maintainer is auditing workflow ownership. Neither document is mandatory startup context for a
normal contributor workflow.
