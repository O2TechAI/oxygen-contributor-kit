# Bounded preference worker prompt

Read `preference-context.json` only. It contains the final reusable lessons, their Chapter-local
Insight identities, the completed Privacy aggregate, and regular `reviewedEvidence` rows with
exactly `{documentId,eventId,documentKind,sequence,role,timestamp,redactedText}`. The rows are
already limited to Insight-cited reviewed evidence and sorted by UTF-8 `documentId`, numeric
`sequence`, and UTF-8 `eventId`.
Do not inspect raw history, rerun Privacy, call a provider, access SQLite or the Viewer, or infer
an answer, default, publication state, or release decision.

Write `preference-candidates.json` with exactly `probes`, `bulkDecisions`, and `setAside`. Questions
remain unanswered. Use only the supplied reviewed rows and their canonical `redactedText`; never
look for raw text or uncited neighboring turns. A probe must cite
events from its own `documentId`, declare `trajectory` or `meeting`, use a permitted signal and a
0–100 integer score, provide 2 or 3 distinct options, and set `allowOther` and `allowSkip` to true.
Do not add Other or Skip option rows. If no valid question is warranted, write the completed-zero
document with both arrays empty and `setAside: 0`.
