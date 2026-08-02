# Project map contract

Write UTF-8 JSON at `<run>/project-map.json`:

```json
{
  "schema_version": "1",
  "primary_project": "Oxygen",
  "summary": "Builds a privacy-reviewed trajectory contribution and evaluation workflow.",
  "projects": [
    {"name": "Oxygen", "event_count": 12, "reason": "Sustained user intent and outputs"}
  ],
  "events": {
    "traj-example:evt-000002": {
      "project": "Oxygen",
      "confidence": 98,
      "summary": "Questions whether generated checklists are only a baseline."
    }
  }
}
```

- Event keys are `<trajectory_id>:<event_id>` so repeated IDs across trajectories cannot collide.
  A bare `event_id` remains accepted only for backward compatibility with single-trajectory runs.
- `project` is a stable project/workstream name, never an event or tool type.
- `confidence` is an integer from 0–100.
- `summary` is an AI-compressed, one-idea timeline description: at most 18 English words or
  32 Chinese characters. It must not repeat the raw source, timestamp, project name, or confidence.
- Include every event. Use `Unrelated / uncertain` instead of inventing a project.
- Do not copy secrets or sensitive raw text into summaries.
- Do not change source files, timestamps, IDs, or publication approval state.
