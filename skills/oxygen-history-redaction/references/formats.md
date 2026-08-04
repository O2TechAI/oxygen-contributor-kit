# Formats and invariants

## Case layout

```text
CASE_DIR/
  case.json
  approval.json
  automatic/
    data/
      trajectories/trajectory-000001/events.jsonl
      # or meeting-transcripts.json
  reviewed/
    data/...
  private/
    source.json
    policy.json
    pii-state.json
    presidio-custom-recognizers.json
    text-index.json
    findings.json
    suggested-mask-plan.json
    masks.json
    waivers.json
    apply-state.json
```

Only `reviewed/data/` enters a finalized archive. The archive also contains `NOTICE.md`, `redaction-summary.json`, and `release-manifest.json`.

## Normalized trajectory event

Every JSONL event has exactly these keys:

```json
{
  "schema_version": "release-redactor.event/1",
  "event_id": "event-000001",
  "trajectory_id": "trajectory-000001",
  "turn_id": "turn-000001",
  "sequence": 0,
  "event_type": "message",
  "actor": {"type": "user"},
  "payload": {"role": "user", "text": "Reviewable text"},
  "relations": []
}
```

For assistant text, both actor type and payload role are `assistant`.

Every non-conversational event uses the same envelope with:

```json
{
  "turn_id": null,
  "event_type": "action_label",
  "actor": {"type": "tool"},
  "payload": {"action_type": "tool_call"},
  "relations": []
}
```

The snippet shows only differing fields; the actual event still has the exact nine-key envelope. `actor` has exactly one key and an action payload has exactly one key. No source extension fields are permitted.

## Normalized meeting

```json
{
  "schema_version": "release-redactor.meeting/1",
  "records": [
    {
      "record_id": "record-000001",
      "sequence": 0,
      "speaker": "participant",
      "text": "Reviewable text"
    }
  ]
}
```

The top level and every record use exactly these keys.

## Text index

`private/text-index.json` is created only after Presidio, deterministic, and speaker filters finish. It is the exhaustive mutation allowlist:

```json
{
  "version": "1",
  "targets": [
    {
      "target_id": "text-00000001",
      "path": "data/trajectories/trajectory-000001/events.jsonl",
      "pointer": "/0/payload/text",
      "length": 123,
      "text_sha256": "64-lowercase-hex-characters",
      "source_kind": "trajectory-message"
    }
  ]
}
```

Paths are relative to `automatic/` or `reviewed/`. JSONL pointers treat the file as an array of line values. JSON pointers use RFC 6901 escaping. Plain text targets use an empty pointer.

`text-index` emits only metadata. The reviewer reads actual text directly from local `automatic/data/`.

## Batch mask plan

```json
{
  "version": "1",
  "targets": [
    {
      "target_id": "text-00000001",
      "text_sha256": "64-lowercase-hex-characters",
      "spans": [
        {
          "start": 10,
          "end": 30,
          "category": "private-personal"
        }
      ]
    }
  ]
}
```

Rules:

- `text_sha256` must exactly match the text index.
- Offsets are Python Unicode string offsets into `automatic` text and use `[start, end)`.
- Spans must be nonempty, in bounds, and non-overlapping.
- A span may fully contain automatic tags but may not start or end inside one.
- A full-turn span is valid.
- A target appearing again replaces that target’s complete previous span set.
- Targets absent from a later plan remain unchanged.
- The plan contains no raw selected text, replacement, quote, or reason.

`mask-text` converts the plan to `private/masks.json`. Each stored span gains `selected_sha256`; raw selected text is never stored. It then rebuilds `reviewed/` immediately from `automatic/`.

## Findings

Signals in the same sentence or within the policy merge gap are consolidated. Each finding stores safe coordinates and fingerprints:

```json
{
  "finding_id": "review-00000001",
  "target_id": "text-00000001",
  "path": "data/meeting-transcripts.json",
  "pointer": "/records/0/text",
  "signal_ids": ["private-personal", "commercial-strategy"],
  "categories": ["commercial-strategy", "private-personal"],
  "category": "private-personal",
  "severity": "high",
  "start": 10,
  "end": 30,
  "selected_sha256": "64-lowercase-hex-characters"
}
```

A finding is resolved only when one stored span fully contains `[start, end)` or one waiver names its exact finding ID.

`private/suggested-mask-plan.json` has the batch mask-plan schema and contains one span per consolidated finding. It is a starting point for semantic review, not evidence that review occurred.

## PII state

`private/pii-state.json` records no source text or detected values. It records:

- backend `presidio`;
- NLP engine `spacy`;
- device `cpu`;
- model and language;
- threshold;
- text-target count;
- raw detection count, merged tag count, and entity-type counts.
- ignored generic entity types, custom recognizer names, and the custom-recognizer bundle hash.

`private/presidio-custom-recognizers.json` is the normalized, content-free snapshot of the bundled recognizer specifications. The checker validates its hash against `pii-state.json`. The checker requires the PII state to match policy and cover every indexed text target.

## Approval

`approval.json` starts fail-closed. All four booleans must be exactly `true`, and all four role strings must be nonempty:

```json
{
  "semantic_review_complete": true,
  "original_contributor_reviewed": true,
  "privacy_reviewer_reviewed": true,
  "publication_approved": true,
  "review_roles": {
    "semantic": "semantic-reviewer",
    "original_contributor": "source-owner",
    "privacy": "privacy-reviewer",
    "publisher": "release-owner"
  },
  "version": "1"
}
```

Reviewer identities remain local and are not placed in the archive.

## Validation invariants

`check` verifies:

- `automatic/` still matches its preparation hash;
- the mask ledger and reviewed tree match `apply-state.json`;
- the file set contains only the normalized format;
- each text-index hash and length matches automatic text;
- the Presidio/spaCy CPU state matches policy and covers every text target;
- reviewed text equals deterministic tag rendering;
- all non-text values equal the normalized automatic baseline;
- normalized trajectory/meeting schemas use exact key sets and canonical values;
- deterministic sensitive rules do not match outside tags;
- tags are canonical;
- every semantic finding is fully resolved.

## Deterministic archive

Tar entries are sorted and normalized to uid/gid 0, mode `0644`, and mtime 0. Gzip mtime and filename are empty. Re-finalizing unchanged reviewed data produces identical bytes.
