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

Each ordered candidate has exactly `id` and `summary`, matching the sole Story activation contract.
`summary` is a valid `oxygen.story:` JSON source. The preparation step projects only
`documentId`, `documentKind`, and exact imported item identities from the reviewed bundles; source
text and redacted text never enter the Preference context. The report's per-document counts and
category aggregate must exactly bind those bundles. A final Story Insight may cite only one of those
reviewed records. Missing, foreign, duplicate, cross-document, raw, unreviewed, rejected, incomplete,
stale, or malformed authority fails closed without replacing the output.

The output has exactly these fields:

```json
{
  "schema": "oxygen.preference-context",
  "reusableLessons": [],
  "insightIdentities": [],
  "reviewedEvidence": [],
  "autoRemoved": {"total": 0, "reversible": true, "categories": []}
}
```

`reusableLessons` is exactly Core's ordered final Insight lesson projection. `insightIdentities`
uses Chapter-local `{storyKey, insightId}` pairs. `reviewedEvidence` contains only Insight-cited
reviewed event identities. `autoRemoved` is derived only from the completed report after its counts
are recomputed from and matched to the exact reviewed bundles.

## Candidate and final bundle

The Agent writes exactly:

```json
{"probes": [], "bulkDecisions": [], "setAside": 0}
```

Candidate probes use the `/api/probes` camelCase nested shape: all fourteen probe keys, 2–3
distinct canonical options, valid `en`/`zh` presentations when supplied, `allowOther: true`, and
`allowSkip: true`. Candidate bulk decisions use the exact six API keys. Candidates cannot supply
digests, `autoRemoved`, defaults, answers, model/provider information, or publication state.
Other and Skip are flags, never option rows. A probe's evidence must belong to its document; every
bulk evidence ID must be in the reviewed authority.

The finalizer emits exactly nine API fields:

```json
{
  "workflowRunId": "run",
  "sourceRevision": 0,
  "inputDigest": "sha256",
  "outputDigest": "sha256",
  "outputCount": 0,
  "setAside": 0,
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
