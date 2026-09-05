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
preparation preserves the activated Story candidate order and each Story's Insight order in
`reusableLessons`; this is the narrative authority and is not reordered by candidate ID or Insight
ID.
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

`reusableLessons` is exactly Core's activated Story/Insight narrative-order lesson projection and
each lesson also carries its linked canonical Story `language`. Language is presentation metadata,
not identity; [the Story language contract](../../oxygen-storytelling-review/references/bilingual-contract.md)
owns its derivation and propagation.
`insightScope` is independently canonicalized by UTF-8 `storyKey` and then UTF-8 `insightId`.
Every lesson and scope row carries the exact Chapter-local
`{storyKey, insightId, insightAuthorityDigest}` triple, where the digest binds the full canonical
Insight content. Scope membership must be a one-to-one identity/digest match with
`reusableLessons`; positional equality is neither required nor accepted as authority.
`reviewedEvidence` contains only Insight-cited
reviewed event identities. `autoRemoved` is derived only from the completed report after its counts
are recomputed from and matched to the exact reviewed bundles. Rows are ordered by UTF-8
`documentId`, numeric `sequence`, and UTF-8 `eventId`. Regeneration keeps its separate
identity-only `reviewedEvidence` shape and schema-specific validation.

## Candidate and final bundle

The Agent writes exactly:

```json
{"probes": [], "bulkDecisions": [], "setAside": 0}
```

The existing [candidate validator](../scripts/validate_probes.py) is the executable owner. The
following types document its current fields, not a second schema. Each probe has exactly seventeen
keys; each bulk candidate has exactly six. Workers return these candidates only; the parent runs
the deterministic finalizer that adds the ten API bundle fields below.

```ts
type PreferenceOption = { id: string; text: string };
type ProbeCandidate = {
  id: string;
  storyKey: string;
  insightId: string;
  insightAuthorityDigest: string;
  documentId: string;
  documentKind: string;
  eventIds: string[];
  timestamp: string | null;
  signal: "repeated_correction" | "long_exchange" | "late_rejection"
    | "decision_reversal" | "explicit_rule" | "sustained_disagreement";
  score: number;
  turns: number;
  recap: string;
  question: string;
  options: PreferenceOption[];
  presentations: Partial<Record<"en" | "zh", {
    recap: string; question: string; options: PreferenceOption[];
  }>>;
  allowOther: true;
  allowSkip: true;
};
type BulkCandidate = {
  id: string;
  kind: string;
  count: number;
  question: string;
  evidenceSample: string[];
  presentations: Partial<Record<"en" | "zh", { question: string }>>;
};
```

Copy one exact `storyKey`/`insightId`/`insightAuthorityDigest` triple from `insightScope`; never invent
another digest. Probe IDs and bulk IDs are unique across the batch, and each Chapter-local Insight
may have at most one probe. `documentKind` is the cited reviewed document's exact current value,
matching `^[a-z][a-z0-9_]{0,63}$`; do not coerce an unfamiliar valid kind to `trajectory` or `meeting`.
A probe cites 1–500 unique `eventIds` from its own document with that same kind. Bulk `kind` is safe,
nonempty explanatory text, not a Privacy decision or category override; `evidenceSample` has 0–500
unique reviewed event IDs. Do not generate new Privacy decisions.

`score` is an integer in 0–100; `turns`, `count`, and `setAside` are nonnegative safe integers.
Use only supplied reviewed evidence, never uncited neighboring turns. A probe has 2–3 options with
unique IDs and distinct, evidence-grounded text; generic advice is invalid. Each probe presentation
has exactly recap/question/options; its options have the same IDs, count, and order as canonical
options. The linked Story language presentation is mandatory. Bulk presentations may be empty;
otherwise each `en` or `zh` entry has exactly question. Other and Skip remain true flags, never
option rows. Cap probes at 12 by default and the combined probe/bulk batch at 20 maximum. An empty
batch has both arrays empty and `setAside: 0`; never manufacture questions to avoid completed-zero.

IDs and safe text are nonempty after trimming, with limits measured as UTF-16 code units: 20,000
by default, 1,000 for cited event IDs, and 200 for option IDs. `timestamp` is either null or safe
text. Candidates cannot supply `autoRemoved`, defaults, answers, model/provider information, or
publication state.
Both reviewed `en` and `zh` presentations may coexist. The required linked language must exist and
validate without fallback, synthesis, or translation; extra reviewed presentation does not change
question, option, Insight-binding, or answer identity.
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
Each regeneration `reusableLessons` row carries the linked Story `language` as display metadata;
`insightScope`, targets, question identity, and answers remain language-free. Validation and Core
POST require that language's reviewed presentation without fallback, while allowing extra reviewed copy.
Successful import archives replaced question bytes, clears their answers, leaves Story review state
unchanged, and requires the contributor to answer each regenerated active Preference again.
