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

Supported meeting directory for both one-meeting and multi-meeting runs:

```text
run/
└── meetings/
    ├── <meeting-id-a>/
    │   └── meeting.json
    └── <meeting-id-b>/
        └── meeting.json
```

The plural `meetings/` directory and `trajectories/` directory may coexist in one run. A root
`meeting.json` is invalid. Every meeting dataset retains a distinct `meeting_id`; each imported
record ID remains qualified as `<meeting-id>:<record-id>`. Transcript contents are not
concatenated, and source document count does not determine Story or Chapter count.

Each trajectory event follows Oxygen v0.2 and should include `event_id`, `sequence`,
`event_type`, actor fields, timestamps, and a payload. The importer preserves the original
event JSON while deriving display content.

The organizer persists:

- `organization_category`
- `organization_confidence`
- `organization_reason`
- trajectory-level `formatted_summary_json`

The editable database is local. The offline HTML embeds only the organized snapshot.
