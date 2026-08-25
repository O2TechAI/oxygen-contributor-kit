# Oxygen local review viewer

This is the frontend bundled with the Oxygen Contributor Kit. Do not start or seed it directly
for the normal contribution workflow. From the parent `contributor-kit/` directory, run:

```bash
python3 skills/oxygen-organize-review-export/scripts/run_local_review.py work/<run>
```

The launcher starts password-free localhost-only access and imports the selected Oxygen ingest
output. The interface intentionally contains only organization progress, the primary-project
timeline, read-only source events, and HTML/ZIP downloads.

Each project has one combined timeline across all source trajectories, distilled to
evidence-supported meaningful milestones without a numeric quota. Drag the divider to resize the
project/source panel horizontally on desktop or vertically on narrow screens.

SQLite/D1 is temporary local runtime state. **Download HTML** exports a read-only snapshot;
**Download ZIP** applies every active AI-redaction span and exports the normalized package without
raw event envelopes. ZIP export is blocked until the AI pass completes with zero rejected spans.
Neither action uploads data.

One Viewer state directory owns at most one established workflow run for its lifetime. Start a new
Viewer through the launcher, with a fresh state directory, for another project or workflow; reusing
one state directory as multi-run history is unsupported.
