# Preference probe contract

Write UTF-8 JSON at `<run>-review/preference-probes.json`. Project Map and Preference Probe keep
their independent `schema_version` fields; that is not a Story product version.

```json
{
  "schema_version": "1",
  "primary_project": "Oxygen",
  "generated_from": "project-map.json",
  "auto_removed": {
    "total": 37,
    "reversible": true,
    "categories": [
      {"kind": "credential", "count": 12},
      {"kind": "user_path", "count": 19},
      {"kind": "third_party_contact", "count": 6}
    ]
  },
  "bulk_decisions": [
    {
      "id": "bulk-interpersonal",
      "kind": "interpersonal_criticism",
      "count": 41,
      "question": "Found 41 passages criticizing a named person or organization. Remove them?",
      "default": "keep",
      "answer": null,
      "evidence_sample": ["evt-000123", "evt-000188", "evt-000241"]
    }
  ],
  "probes": [
    {
      "id": "probe-01",
      "document_id": "traj-abc123",
      "document_kind": "trajectory",
      "event_ids": ["evt-000042", "evt-000045", "evt-000047"],
      "timestamp": "2026-07-21T09:14:00Z",
      "signal": "repeated_correction",
      "score": 87,
      "turns": 6,
      "recap": "While adding the login page, the agent edited the production config three times. You reverted it each time and said to stop touching deploy/.",
      "question": "Anything here you want the agent to remember?",
      "options": [
        {"id": "A", "text": "Ask me before changing anything under deploy/"},
        {"id": "B", "text": "Propose a plan before editing files, don't edit first"},
        {"id": "C", "text": "Keep infrastructure changes on a separate branch"}
      ],
      "allow_other": true,
      "allow_skip": true,
      "answer": null
    }
  ],
  "set_aside": 3
}
```

## Field rules

- `auto_removed` contains exactly `total`, `reversible`, and `categories`; each category contains
  exactly `kind` and `count`. Unknown fields are invalid and must never be forwarded or packaged.
- `total` and every `count` are non-negative integers, `reversible` is a boolean, and `categories`
  is an array with no duplicate `kind` entries.
- `kind` is one of `credential`, `private-personal`, `sensitive`, `internal-metric`,
  `internal-timeline`, `mosaic-reidentification`, `user_path`, or `third_party_contact`.
- `auto_removed.total` must equal the sum of `categories[].count`. Contributors act on this
  number; an inconsistent one is a bug, not a rounding difference.
- `auto_removed` never contains removed content, only counts by kind.
- `bulk_decisions[].default` is always `"keep"`. Removal requires a deliberate answer.
- `probes[].event_ids` are source `event_id` values and must exist in the run. Every probe is
  reopenable at its original moment; a probe without valid evidence is unverifiable and must be
  dropped rather than shipped.
- `probes[].document_kind` is `"trajectory"` or `"meeting"`. Both are in scope.
- `signal` is one of `repeated_correction`, `long_exchange`, `late_rejection`,
  `decision_reversal`, `explicit_rule`, `sustained_disagreement`.
- `score` is an integer 0–100, used only for ranking and for choosing what to set aside.
- `recap` is at most 3 sentences, self-contained, in the contributor's language, and quotes no
  content removed in Stage 1.
- `options` holds 2 or 3 entries, each grounded in this probe's evidence, mutually exclusive, and
  separately actionable. Never emit a generic option to reach three.
- `allow_other` and `allow_skip` are always `true`.
- `set_aside` is the number of qualifying moments dropped by the cap. Report it to the
  contributor; silently truncating reads as "we found ten moments" when there were thirty.
- A completed-zero generation result is represented by a valid document with `probes: []`,
  `set_aside: 0`, exact `auto_removed` counts, and no fabricated answers.

## Answers

The contributor's response is written back into the same file:

- `probes[].answer` becomes `{"choice": "A"}`, `{"choice": "other", "text": "..."}`, or
  `{"choice": "skip"}`.
- `bulk_decisions[].answer` becomes `"remove"`, `"keep"`, or `"inspect"`.

`null` means unanswered. Never coerce `null` into a preference — an unanswered probe carries no
information, and treating it as agreement silently invents data the contributor never confirmed.

Confirmed answers (`A`/`B`/`C`/`other`) become checklist entries on `document_id`, carrying
`event_ids` as evidence. Skipped and unanswered probes produce nothing.

Do not change source files, timestamps, event IDs, or `publication_approved`.
