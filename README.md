# Oxygen Contributor Kit

Clone this repository and ask your coding agent:

> Use the Oxygen contributor skills to collect the history for this repository, organize it, and open the local review viewer. Do not upload anything.

The agent should then read [AGENTS.md](AGENTS.md) and [SOP.md](SOP.md). The normal flow is:

```text
repo / Claude export / meeting
              ↓
Oxygen v0.2 ingest output
              ↓
project-level organization across trajectories
              ↓
English review viewer
              ↓
self-contained HTML preview + final ZIP
```

Nothing is uploaded by this kit. Collection outputs are unapproved until the original
contributor reviews them.

## Requirements

- Python 3.11+
- Node.js 22+
- npm
- Codex and/or Claude Code local session directories for repo collection
- Optional: `ffmpeg`/audio dependencies and the user's own Hugging Face token for diarization

## Skills

- [`oxygen-ingest-project-history`](skills/oxygen-ingest-project-history/SKILL.md):
  collect repo-related Codex/Claude sessions and memory, import Claude exports, or process meetings.
- [`oxygen-organize-review-export`](skills/oxygen-organize-review-export/SKILL.md):
  load an ingest output, show progress, review the project timeline, and export HTML plus a final ZIP.

## Human quick start

```bash
# 1. Collect conversations related to a repository.
python3 tools/ingest/collect_repo_trajectories.py /path/to/repo \
  --out work/my-project

# 2. Open the local organizer and import that output.
python3 skills/oxygen-organize-review-export/scripts/run_local_review.py \
  work/my-project
```

The second command prints the local URL. Keep the process running while reviewing. The
localhost-only Viewer does not require a password. It proactively opens the browser; if that is
unavailable, the agent must give you the URL. Use **Download ZIP** to get the normalized data,
project map, and an HTML viewer that opens directly from disk.

The ingest skill in this kit is the portable customer version of the original Oxygen ingest
workflow. Its implementation remains under `tools/ingest/`.
