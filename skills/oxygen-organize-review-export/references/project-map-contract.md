# Project map and semantic-manifest contract

Current ingest owns the deterministic contribution projection. Organization consumes only that
current projection and never reads raw trajectories, dropped records, or historical project maps.
An absent or invalid projection is a hard stop with an instruction to re-collect through current
ingest. There is no legacy migration, compatibility reader, fallback, or manual project-map edit.

## 1. Create the current skeleton

POSIX:

```bash
python3 skills/oxygen-organize-review-export/scripts/build_project_map.py work/<run> \
  --primary-project "<project>" --summary "<summary>"
```

Windows PowerShell:

```powershell
python .\skills\oxygen-organize-review-export\scripts\build_project_map.py `
  "work\<run>" --primary-project "<project>" --summary "<summary>"
```

The builder verifies current contribution-projection provenance, source and document identities,
the exact contribution universe, and the semantic source digest. The skeleton is the only accepted
Organization input. An older reviewed package remains immutable evidence and is not an input to
this command.

## 2. Prepare immutable bounded worker inputs

POSIX:

```bash
python3 skills/oxygen-organize-review-export/scripts/prepare_semantic_units.py \
  work/<run> work/<run>-organization
```

Windows PowerShell:

```powershell
python .\skills\oxygen-organize-review-export\scripts\prepare_semantic_units.py `
  "work\<run>" "work\<run>-organization"
```

Preparation writes `semantic-context.json`, `shards.json`, and immutable
`inputs/<shard-id>.json` files. It balances serialized UTF-8 bytes and content bytes while keeping
each qualified contribution ID in exactly one shard. Worker context contains only normalized
semantic fields: contribution and document identity, sequence, event type, actor type, timestamp,
and content. It excludes raw tool envelopes/results, raw commands/output, local storage paths,
actor identity, provider/model metadata, projection drop ledgers, and source secrets or metadata.

This preparation/validation step is provider-free. It does not make semantic grouping decisions.
The exact successful handoff marker is:

```text
PAUSE_FOR_BOUNDED_SEMANTIC_WORKERS
```

## 3. Bounded worker proposal and terminal receipt

Each external worker reads exactly one `inputs/<shard-id>.json` and returns one JSON array at
`handoffs/<shard-id>.proposals.json`. The worker uses the user's configured model and credentials;
semantic reasoning is not provider-free. A proposal has only these fields:

```json
{
  "unitId": "unit-source-boundary-decision",
  "kind": "decision_episode",
  "contributionIds": ["evt-..."],
  "storyProjection": {
    "label": "Source boundary",
    "summary": "The recorded discussion narrows the contribution source boundary."
  }
}
```

`duplicateOfUnitId` is allowed only for a `duplicate` unit and must name a current direct
non-duplicate unit. `storyProjection` is optional; its label is at most 120 UTF-8 bytes and its
summary at most 300 UTF-8 bytes. Allowed kinds are `discussion`, `decision_episode`,
`failed_attempt`, `experiment`, `correction`, `handoff`, `review_cycle`, `progression`, `routine`,
and `duplicate`.

Every shard contribution must occur exactly once across that worker's proposals. Use the same
stable `unitId` in multiple shards when one semantic episode crosses shard boundaries. Do not use
one unit per record, one unit per session, or future Story Chapters as a quota.

Record each worker's strict terminal receipt and content-bound output without calculating digests
or editing the generated project map:

```bash
python3 skills/oxygen-organize-review-export/scripts/record_semantic_worker.py \
  work/<run>-organization <shard-id> \
  work/<run>-organization/handoffs/<shard-id>.proposals.json
```

```powershell
python .\skills\oxygen-organize-review-export\scripts\record_semantic_worker.py `
  "work\<run>-organization" "<shard-id>" `
  "work\<run>-organization\handoffs\<shard-id>.proposals.json"
```

The receipt binds terminal status, shard ID, shard input digest, exact contribution IDs, output
path, output digest, and output count. The recorder and finalizer make no provider, model, network,
Viewer, or release call and do not store prompts or responses in product output.

## 4. Compose and install canonical authority

After every terminal receipt exists, run:

```bash
python3 skills/oxygen-organize-review-export/scripts/finalize_semantic_units.py \
  work/<run> work/<run>-organization
```

```powershell
python .\skills\oxygen-organize-review-export\scripts\finalize_semantic_units.py `
  "work\<run>" "work\<run>-organization"
```

Composition merges matching cross-shard `unitId` proposals only when kind, duplicate relation, and
bounded Story projection agree. It then proves the exact global union with no missing, foreign,
duplicate, or overlapping contribution. Missing, failed, stale, foreign, duplicated, overlapping,
or tampered receipts and outputs fail before installation. Completed-zero is invalid for a
nonempty universe.

The existing canonical project-map builder is the sole membership-digest, manifest-digest, and
revision authority. It sorts identities by UTF-8 bytes, validates duplicate topology and the 512
unit, 2,200,000 manifest-byte, and 325,000 Story-projection-byte limits, preserves unchanged unit
revisions, and advances only content-changed authority. Installation is atomic: failure leaves the
previous skeleton or finalized map byte-identical, and retrying the same complete input is
deterministic and idempotent.

Input and output path components must be literal physical components. Junctions, reparse points,
symlinks, existing file hard links, parent traversal, absolute worker paths, and writes outside the
explicit semantic output root fail closed. `publication_approved` remains `false`; Organization
does not own Viewer acceptance, Story review, release, upload, deployment, or publication.
