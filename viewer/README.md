# Oxygen local review viewer

This is the frontend bundled with the Oxygen Contributor Kit. Do not start or seed it directly
for the normal contribution workflow. From the parent `contributor-kit/` directory, run:

```bash
python3 skills/oxygen-organize-review-export/scripts/run_local_review.py work/<run>
```

The launcher starts password-free localhost-only access and imports the selected Oxygen ingest
output. The interface intentionally contains only organization progress, the primary-project
timeline, read-only source events, and HTML/ZIP downloads.

Each project has one combined timeline across all source trajectories, distilled to 10–40 key
milestones. Drag the divider to resize the project/source panel horizontally on desktop or
vertically on narrow screens.

SQLite/D1 is temporary local runtime state. **Download HTML** exports a read-only snapshot;
**Download ZIP** exports the final normalized package. Neither action uploads data.
