# Oxygen contributor agent instructions

When a user asks to collect, organize, review, or package project history:

1. Read `README.md` and `SOP.md`.
2. Resolve and verify the contributor-approved target working folder. Before collection, use
   `skills/oxygen-organize-review-export/scripts/run_local_review.py --target <folder>` to reserve
   a free loopback port, launch the canonical sanitized Workflow Progress surface, and obtain its
   stable workflow run ID. Keep that owned Viewer process alive for the rest of the workflow.
3. Use `skills/oxygen-ingest-project-history/SKILL.md` for collection. Pass the exact localhost
   Viewer origin and workflow run ID to supported collectors so real collection counts update the
   same progress run. Never put a target path, session name, or content in progress state.
4. Use `skills/oxygen-organize-review-export/SKILL.md` to classify mixed conversations by project,
   build one combined timeline per project, and attach the collected run to that same Viewer.
5. Use `tools/llm_redact/prepare_ai_review_run.py` to collapse non-conversational events, then use
   `REDACTION_PROMPT.md`, `verify_coverage.py`, and `merge_and_apply.py` for AI redaction. Treat
   model findings as untrusted and never claim guaranteed anonymity.
6. Use `skills/oxygen-elicit-contributor-preferences/SKILL.md` after organization and AI privacy
   preparation. Present one batch of evidence-grounded questions and validate
   `preference-probes.json`.
7. After organization and AI privacy preparation have produced a reviewed input, delegate Project
   Story derivation and iterative local human review to
   `skills/oxygen-storytelling-review/SKILL.md`. Bind validated Story data to the existing
   canonical Viewer runtime; do not create an independent Storytelling frontend. `All set` creates
   Final Release Memory only and never approves publication. Then continue through Release preview,
   Preferences, and package review. Report workflow progress to the Viewer only at safe stage
   boundaries using sanitized stage/state, justified counts, blocker codes, timestamps, and human-
   action state. Never expose model reasoning, prompts, raw tool arguments, private messages,
   Story/Evidence payloads, or removed content as progress.
   When atomic Story activation enters Stage 5 Review Story, immediately surface the exact
   localhost URL, state that it has no password, and pause for the contributor. Keep the Viewer and
   same Agent alive. Do not perform Story edits, Privacy decisions, preference answers, `All set`,
   or release handoff on the contributor's behalf; unattended validation ends at
   `WAITING_FOR_HUMAN_STORY_REVIEW`.
8. Never read credential files, private keys, tokens, cookies, browser profiles, or
   system/developer prompts.
9. Proactively show the Viewer when a visible browser surface exists, always provide its exact
   localhost URL, and do not require a password.
10. Keep every output `publication_approved=false` unless the contributor explicitly approves
   publication. Download or ZIP creation is not approval.
11. Never upload or publish automatically. Stop after producing and verifying the downloadable ZIP.
