# Organizer input contract

Supported trajectory directory:

```text
run/
├── index.json
└── trajectories/
    └── <trajectory-id>/
        ├── manifest.json
        ├── events.jsonl
        ├── redaction.json
        └── artifacts/
```

Supported meeting directory:

```text
run/
└── meeting.json
```

Each trajectory event follows Oxygen v0.2 and should include `event_id`, `sequence`,
`event_type`, actor fields, timestamps, and a payload. The importer preserves the original
event JSON while deriving display content.

The organizer persists:

- `organization_category`
- `organization_confidence`
- `organization_reason`
- trajectory-level `formatted_summary_json`

The editable database is local. The offline HTML embeds only the organized snapshot.
