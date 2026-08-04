# Oxygen contributor agent instructions

When a user asks to collect, organize, review, or package project history:

1. Read `README.md` and `SOP.md`.
2. Use `skills/oxygen-ingest-project-history/SKILL.md` for collection.
3. Use `skills/oxygen-organize-review-export/SKILL.md` to classify mixed conversations by project,
   build one combined timeline per project, and launch the local Viewer.
4. Use `skills/oxygen-history-redaction/SKILL.md` for best-effort local release redaction. Read its
   policy and format references and never claim guaranteed anonymity.
5. Use `skills/oxygen-elicit-contributor-preferences/SKILL.md` after organization and privacy
   preparation. Present one batch of evidence-grounded questions and validate
   `preference-probes.json`.
6. Never read credential files, private keys, tokens, cookies, browser profiles, or
   system/developer prompts.
7. Proactively show the Viewer when a visible browser surface exists, always provide its exact
   localhost URL, and do not require a password.
8. Keep every output `publication_approved=false` unless the contributor explicitly approves
   publication. Download or ZIP creation is not approval.
9. Never upload or publish automatically. Stop after producing and verifying the downloadable ZIP.
