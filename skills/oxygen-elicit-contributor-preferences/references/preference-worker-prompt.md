# Bounded preference worker prompt

Read `preference-context.json` only. It contains the final reusable lessons, their Chapter-local
Insight identities, reviewed evidence allowed for this task, and the completed Privacy aggregate.
Do not inspect raw history, rerun Privacy, call a provider, access SQLite or the Viewer, or infer
an answer, default, publication state, or release decision.

Write `preference-candidates.json` with exactly `probes`, `bulkDecisions`, and `setAside`. Questions
remain unanswered. Use only the reviewed evidence IDs supplied by the context. A probe must cite
events from its own `documentId`, declare `trajectory` or `meeting`, use a permitted signal and a
0–100 integer score, provide 2 or 3 distinct options, and set `allowOther` and `allowSkip` to true.
Do not add Other or Skip option rows. If no valid question is warranted, write the completed-zero
document with both arrays empty and `setAside: 0`.
