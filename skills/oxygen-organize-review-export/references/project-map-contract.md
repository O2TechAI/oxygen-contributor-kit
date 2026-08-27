# Project map and semantic-manifest contract

The collector has already projected immutable raw source into a deterministic contribution
universe. Organization must read every projected natural-language contribution record and group it
into bounded semantic units. Do not repeat the source-relevance policy here and do not read dropped
tool envelopes, command/results, telemetry, or machine artifacts.

Create the skeleton with:

```text
python skills/oxygen-organize-review-export/scripts/build_project_map.py <run> \
  --primary-project <project> --summary <summary>
```

Then fill only `semantic_units` in `<run>/project-map.json`:

```json
{
  "schema_version": "1",
  "primary_project": "Oxygen",
  "summary": "Builds a privacy-reviewed contribution and Story workflow.",
  "semantic_units": [
    {
      "id": "unit-source-boundary-decision",
      "kind": "decision_episode",
      "members": [
        "evt-1111111111111111111111111111111111111111111111111111111111111111",
        "evt-2222222222222222222222222222222222222222222222222222222222222222"
      ],
      "storyProjection": {
        "label": "Source boundary",
        "summary": "The recorded discussion narrows contribution source to semantic traces."
      }
    }
  ],
  "semantic_manifest": null
}
```

The first skeleton has `semantic_manifest: null`. On a later source update, the skeleton preserves
the prior finalized manifest and editable units for inspection, but preserved output never becomes
revision authority implicitly. It is stale until explicit finalization replaces it and cannot be
attached to the Viewer because its source authority no longer matches.

Allowed kinds are `discussion`, `decision_episode`, `failed_attempt`, `experiment`, `correction`,
`handoff`, `review_cycle`, `progression`, `routine`, and `duplicate`. A `duplicate` unit also names
the exact current `duplicateOfUnitId` relation. `storyProjection` is optional and privacy-safe; its
label is at most 120 characters and summary at most 300 characters.

Unit boundaries follow meaning: a discussion, decision episode, failed attempt, experiment,
correction, handoff, review cycle, or meaningful progression. A filename, session, trajectory,
timestamp, individual record, or eventual Chapter is not an automatic boundary. Never create one
unit per record merely to satisfy exhaustiveness.

Every qualified contribution ID belongs to exactly one current semantic unit. No member may be
missing, repeated, foreign, or double-owned. Stable unit IDs persist while the meaning persists.
Do not supply revisions: the provider-free finalizer preserves an unchanged unit revision and
increments it only when content-bound membership or semantic projection changes. Exact membership
remains local/tool/server-owned and is never copied into Story output.

Finalize deterministically after grouping:

```text
python skills/oxygen-organize-review-export/scripts/build_project_map.py <run> \
  --primary-project <project> --summary <summary> --finalize
```

That command creates revision 1 and is safe to retry as revision 1. To update an already finalized
manifest, explicitly name the prior content-bound authority (the current project map is valid):

```text
python skills/oxygen-organize-review-export/scripts/build_project_map.py <run> \
  --primary-project <project> --summary <summary> --finalize \
  --previous <run>/project-map.json
```

The finalizer rejects forged revisions, stale digests, malformed duplicate topology, or implicit
lineage. A `duplicate` unit must point directly to one current non-duplicate unit; all other kinds
must omit `duplicateOfUnitId`.

Finalization computes content-bound member counts, membership digests, universe/source/manifest digests, sorts
identities, proves an exact disjoint union, and enforces 512 units, 2,200,000 serialized manifest
bytes, and 325,000 Story-facing projection bytes. These are measured UTF-8 byte limits: the
24,796-record BOM projection occupies 2,097,713 bytes with every unit label and summary at its
maximum, while its Story-facing projection occupies 317,229 bytes. Text and identity limits are
UTF-8 byte limits.
The source digest binds the semantic original plus the exact normalized ID, document, sequence,
event type, actor, timestamp, and content fields consumed as Story Evidence.
Raw-source digests remain projection provenance but do not invalidate unchanged filtered semantic
authority. The Viewer independently revalidates the same
authority before publication. Do not edit source files, timestamps, IDs, projection provenance, or
`publication_approved=false`.
