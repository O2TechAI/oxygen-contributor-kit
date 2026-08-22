# Oxygen contributor agent instructions

When a user asks to collect, organize, review, or package project history:

1. Read `README.md` and `SOP.md`.
2. Use `skills/oxygen-ingest-project-history/SKILL.md` for collection.
3. Use `skills/oxygen-organize-review-export/SKILL.md` to classify mixed conversations by project,
   build one combined timeline per project, and launch the local Viewer.
4. Use `tools/llm_redact/prepare_ai_review_run.py` to collapse non-conversational events, then use
   `REDACTION_PROMPT.md`, `verify_coverage.py`, and `merge_and_apply.py` for AI redaction. Treat
   model findings as untrusted and never claim guaranteed anonymity.
5. Use `skills/oxygen-elicit-contributor-preferences/SKILL.md` after organization and AI privacy
   preparation. Present one batch of evidence-grounded questions and validate
   `preference-probes.json`.
6. After organization and AI privacy preparation have produced a reviewed input, delegate Project
   Story derivation and iterative local human review to
   `skills/oxygen-storytelling-review/SKILL.md`. Bind validated Story data to the existing
   canonical Viewer runtime; do not create an independent Storytelling frontend. `All set` creates
   Final Release Memory only and never approves publication. Then continue through Release preview,
   Preferences, and package review.
7. Never read credential files, private keys, tokens, cookies, browser profiles, or
   system/developer prompts.
8. Proactively show the Viewer when a visible browser surface exists, always provide its exact
   localhost URL, and do not require a password.
9. Keep every output `publication_approved=false` unless the contributor explicitly approves
   publication. Download or ZIP creation is not approval.
10. Never upload or publish automatically. Stop after producing and verifying the downloadable ZIP.
