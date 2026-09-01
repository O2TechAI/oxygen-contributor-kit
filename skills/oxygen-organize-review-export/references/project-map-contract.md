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

The UTF-8 project summary is bounded by the existing 325,000-byte Story semantic-projection
budget. Every producer-valid `project-map.json` is bounded to 6,600,000 serialized UTF-8 bytes:
two unchanged 2,200,000-byte semantic-manifest budgets cover the intentional `semantic_units` and
`semantic_manifest` representations, and a third covers deterministic JSON framing plus the
remaining bounded project metadata. The builder checks the exact bytes its atomic writer emits.
This transport envelope is independent of source domain and historical unit or Chapter counts.

## 2. Freeze one registry and prepare immutable bounded mapping inputs

The workflow-owning parent first derives one project-local registry proposal from the complete
current Privacy-safe projected contribution universe. The registry is per-run semantic authority,
not a hard-coded product or domain vocabulary. Its input shape is:

```json
{
  "units": [{
    "unitId": "unit-source-boundary-decision",
    "kind": "decision_episode",
    "definition": "Records that establish the source-boundary decision.",
    "disambiguation": "Do not use for later implementation or validation records.",
    "storyProjection": {
      "label": "Source boundary",
      "summary": "The recorded discussion narrows the contribution source boundary."
    }
  }]
}
```

Definitions and disambiguation guidance are each limited to 300 UTF-8 bytes, and the canonical
registry is limited to 98,304 serialized UTF-8 bytes so it fits inside the default shard envelope.
Unit count, kind, duplicate topology, Story projection, control-character, and secret-safety bounds
reuse the canonical Organization limits. Empty and nonempty registries must exactly match empty and
nonempty contribution universes.

POSIX:

```bash
python3 skills/oxygen-organize-review-export/scripts/prepare_semantic_units.py \
  work/<run> work/<run>-organization work/<run>-semantic-registry.proposal.json
```

Windows PowerShell:

```powershell
python .\skills\oxygen-organize-review-export\scripts\prepare_semantic_units.py `
  "work\<run>" "work\<run>-organization" `
  "work\<run>-semantic-registry.proposal.json"
```

Preparation binds the registry to the exact project, source digest, and universe digest, then
writes `semantic-context.json`, `semantic-registry.json`, `shards.json`, and immutable
`inputs/<shard-id>.json` files. Every mapping input embeds the byte-identical canonical registry
and digest. The manifest carries each assignment's exact `inputPath`, `proposalPath`, and
`receiptPath`. Preparation balances serialized UTF-8 bytes and content bytes while keeping
each qualified contribution ID in exactly one shard. Worker context contains only normalized
semantic fields: contribution and document identity, sequence, event type, actor type, timestamp,
and content. It excludes raw tool envelopes/results, raw commands/output, local storage paths,
actor identity, provider/model metadata, projection drop ledgers, and source secrets or metadata.

This preparation/validation step is provider-free. It validates and freezes the parent-owned
registry but does not infer, rewrite, or repair semantic grouping decisions.
The exact successful handoff marker is:

```text
PAUSE_FOR_BOUNDED_SEMANTIC_WORKERS
```

## 3. Bounded worker proposal and terminal receipt

Each external worker reads exactly one manifest-declared `inputPath` and returns one JSON array at
that assignment's manifest-declared `proposalPath`. The worker uses the user's configured model
and credentials; semantic mapping is not provider-free. A proposal has only these fields:

```json
{
  "unitId": "unit-source-boundary-decision",
  "contributionIds": ["evt-..."]
}
```

Workers are mapping-only. `unitId` must exist in the frozen registry, and workers cannot declare,
omit, or override `kind`, duplicate authority, Story projection, definitions, or disambiguation.
In the registry, `duplicateOfUnitId` is allowed only for a `duplicate` unit and must name a current
direct non-duplicate unit. `storyProjection` is optional; its label is at most 120 UTF-8 bytes and
its summary at most 300 UTF-8 bytes. `kind` is required and is an open machine label matching exactly
`^[a-z][a-z0-9_]{0,63}$`. Ordinary labels including `direction_change`, `root_cause`,
`laboratory_observation`, and industry-specific lower-snake-case values require no enum edit,
registration, fallback, or compatibility mapping. `duplicate` is reserved for the direct
duplicate topology above. `routine` is reserved as the only kind that can authorize the later
`routine_non_narrative` Coverage disposition.

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

If proposal validation fails while the atomic `records/<shard-id>/` output-and-receipt directory is
absent, the failure is pre-receipt authoring feedback. The external
worker may explicitly replace only `handoffs/<shard-id>.proposals.json` and run the recorder again
against the same immutable shard input. Unknown registry IDs, extra worker-authored metadata, and
invalid mapping syntax fail before any output or receipt and exit nonzero with the fixed safe code
`SEMANTIC_WORKER_MAPPING_INVALID`;
malformed JSON, a non-array proposal, overlap, and incomplete shard coverage use the same
pre-receipt code. Invalid registry kind syntax fails during preparation. Neither path echoes
rejected values, contribution content, paths, tracebacks, or raw exception details. The recorder
performs no automatic retry, rewrite, fallback, or repair. The workflow-owning parent may replace
the proposal and explicitly invoke the recorder again, up to the already documented two correction
attempts, using the same immutable shard input. Authority, path, I/O, tamper, stale, and installed-
artifact failures remain fatal `SEMANTIC_WORKER_RECORD_INVALID` failures.
After the record directory exists, its durable artifact pair is immutable and any differing
resubmission fails closed. The recorder stages both files together and publishes the directory with
one no-clobber atomic rename; a staged-write or publication fault exposes neither final artifact and
allows a clean retry.

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

Composition applies kind, duplicate relation, and bounded Story projection only from the frozen
registry to every matching cross-shard `unitId`. It then proves the exact global union with no missing, foreign,
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
