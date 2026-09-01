# Preference producer contract

Preference-question generation is a two-file, local-only handoff. The bounded Agent receives
`preference-context.json` and writes only `preference-candidates.json`; the deterministic finalizer
is the sole producer of the Viewer API bundle. There is no HTTP, SQLite, provider client, answer,
release, or publication action in either script.

## Context preparation

`prepare_preference_context.py` accepts only the existing unversioned workflow artifacts:

```text
story-candidates.json       [{"id":"existing-imported-item-id","summary":"oxygen.story:{...}"}]
<redaction>/redacted/*.json exact reviewed bundles produced by merge_and_apply.py
<redaction>/report.json     exact completed merge report with zero rejects and zero missing workers
```

Each candidate has exactly `id` and `summary`, matching the sole Story activation contract. Context
preparation sorts that plain array by the UTF-8 bytes of candidate `id` before projecting lessons,
Insight identities, or evidence, so input reordering cannot change context bytes or digests.
`summary` is a valid `oxygen.story:` JSON source. The preparation step projects only Insight-cited
rows from the reviewed bundles. In the regular context each row has exactly
`{documentId,eventId,documentKind,sequence,role,timestamp,redactedText}`; `redactedText` is copied
from the canonical reviewed bundle after verification. Raw source text, uncited neighboring turns,
paths, provider metadata, and Privacy internals never enter the Preference context. The report's
per-document counts and
category aggregate must exactly bind those bundles. Every redaction span must be in the producer's
deterministic non-overlapping order and use one of its six categories: `credential`,
`private-personal`, `sensitive`, `internal-metric`, `internal-timeline`, or
`mosaic-reidentification`. Preparation recomputes `redacted_text` with `merge_and_apply.py`'s sole
tag transformation and requires a byte-for-byte match. A final Story Insight may cite only one of
those reviewed records. Missing, foreign, duplicate, cross-document, raw, unreviewed, rejected,
incomplete, stale, or malformed authority fails closed without replacing the output.

The output has exactly these fields:

```json
{
  "schema": "oxygen.preference-context",
  "reusableLessons": [],
  "insightScope": [],
  "reviewedEvidence": [],
  "autoRemoved": {"total": 0, "reversible": true, "categories": []}
}
```

`reusableLessons` is exactly Core's ordered final Insight lesson projection. Every lesson and
`insightScope` row carries the exact Chapter-local `{storyKey, insightId, insightAuthorityDigest}`
triple, where the digest binds the full canonical Insight content. `reviewedEvidence` contains only Insight-cited
reviewed event identities. `autoRemoved` is derived only from the completed report after its counts
are recomputed from and matched to the exact reviewed bundles. Rows are ordered by UTF-8
`documentId`, numeric `sequence`, and UTF-8 `eventId`. Regeneration keeps its separate
identity-only `reviewedEvidence` shape and schema-specific validation.

## Candidate and final bundle

The Agent writes exactly:

```json
{"probes": [], "bulkDecisions": [], "setAside": 0}
```

Candidate probes use the `/api/probes` camelCase nested shape: all seventeen probe keys, including
one exact `storyKey`, `insightId`, and `insightAuthorityDigest` triple from `insightScope`, plus 2–3
distinct canonical options, valid `en`/`zh` presentations when supplied, `allowOther: true`, and
`allowSkip: true`. Copy each `insightAuthorityDigest` exactly from `insightScope`; candidates must
not invent any other digest. Candidate bulk decisions use the exact six API keys. Candidates cannot
supply `autoRemoved`, defaults, answers, model/provider information, or publication state.
Other and Skip are flags, never option rows. A probe's evidence must belong to its document; every
bulk evidence ID must be in the reviewed authority. The producer binds `documentKind` to the exact
reviewed bundle that supplied each cited identity; Core POST independently rechecks that kind and
the item owner against its SQLite document snapshot.

Stable IDs reject all ASCII controls. Safe display text rejects ASCII controls except tab, LF, and
CR, matching Core's safe-text boundary. `sourceRevision` is a positive safe integer in
`1..9007199254740991`; every other integer that crosses into JavaScript is a nonnegative safe
integer no larger than `9007199254740991`. Canonical-option comparison performs ECMAScript
whitespace trimming, removes trailing ASCII `.` characters, and folds only ASCII `A`–`Z`;
non-ASCII characters remain verbatim so Python and JavaScript cannot diverge by Unicode runtime
tables.

The finalizer emits exactly ten API fields:

```text
{
  "workflowRunId": "run",
  "sourceRevision": <positive current Viewer source revision>,
  "inputDigest": "sha256",
  "outputDigest": "sha256",
  "outputCount": 0,
  "setAside": 0,
  "insightScope": [],
  "probes": [],
  "bulkDecisions": [],
  "autoRemoved": {"total": 0, "reversible": true, "categories": []}
}
```

`inputDigest` is the SHA-256 of Core's canonical reusable-lesson array. `outputDigest` is the
SHA-256 of Core's canonical `canonicalPreferenceQuestionBatch`, sorted by UTF-8 `type:id`.
`outputCount` is `probes.length + bulkDecisions.length`. The finalizer sorts outer candidate
arrays deterministically. Completed-zero requires empty arrays, `setAside: 0`, and output digest
`4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`.

Invalid finalization never creates or changes its output file.
Completed-zero describes the empty `probes` and `bulkDecisions` arrays; it never permits a zero
`sourceRevision`.

## Accepted-Insight regeneration

The Toolkit Agent refreshes only questions whose linked Insight is accepted/applied and whose
current authority digest differs. It must export current authority, write one changed probe per
exported target, run bounded validation, and import the validated bundle:

```powershell
python .\skills\oxygen-organize-review-export\scripts\run_local_review.py --attach-url $ViewerUrl --workflow-run-id $WorkflowRunId --preference-regeneration-export .\preference-regeneration-context.json
python .\skills\oxygen-elicit-contributor-preferences\scripts\validate_probes.py --regeneration --context .\preference-regeneration-context.json --candidates .\preference-regeneration-candidates.json --output .\preference-regeneration-import.json
python .\skills\oxygen-organize-review-export\scripts\run_local_review.py --attach-url $ViewerUrl --workflow-run-id $WorkflowRunId --preference-regeneration-import .\preference-regeneration-import.json
```

The Agent reads only the exported context. Candidates contain exactly `probes`,
`bulkDecisions: []`, and `setAside: 0`; preserve each target `id`, `storyKey`, and `insightId`, copy
the current `insightAuthorityDigest`, and change question/options/presentations bytes. Stop on any
export, validation, stale-authority, or import error; never invent or retry with hand-built authority.
Successful import archives replaced question bytes, clears their answers, leaves Story review state
unchanged, and requires the contributor to answer each regenerated active Preference again.
