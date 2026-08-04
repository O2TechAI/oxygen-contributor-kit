# Oxygen Contributor Kit

This repository lets a contributor use their own coding agent to collect local project history,
organize it into project timelines, review privacy-sensitive material, recover useful working
preferences, inspect the result in a local Viewer, and download one ZIP. The kit does not upload
or publish data.

After cloning, ask the agent:

> Follow the Oxygen contributor SOP for this repository. Collect only my in-scope local history,
> organize it by project, prepare the privacy review, ask me the preference questions as one
> batch, open the local Viewer as soon as it is available, and finish with a downloadable ZIP.
> Do not upload or publish anything.

The agent must read [AGENTS.md](AGENTS.md) and [SOP.md](SOP.md) before acting.

## What the workflow produces

```text
repo / Claude export / meeting transcript or audio
                         |
                         v
              normalized local run
                         |
                         v
       project classification + 10-40 milestones
                         |
                         v
          privacy review + preference probes
                         |
                         v
        local Viewer + downloadable contribution ZIP
```

The final package remains `publication_approved=false` unless the contributor explicitly
approves publication. Producing or downloading a ZIP is not publication approval.

## Requirements

- Python 3.11+
- Node.js 22+ and npm
- Local Codex and/or Claude Code history for repository collection
- Optional meeting-audio dependencies and the contributor's own credentials for transcription
  or diarization; credentials must never enter the collected data
- Optional local Presidio/spaCy CPU environment for the release-redaction pass

## Included skills

Run the skills in this order:

1. [`oxygen-ingest-project-history`](skills/oxygen-ingest-project-history/SKILL.md) collects
   repository-related Codex/Claude sessions and allowed memory, imports Claude exports, and
   processes meeting text or audio.
2. [`oxygen-organize-review-export`](skills/oxygen-organize-review-export/SKILL.md) labels mixed
   conversations by project, selects the primary project, builds one combined timeline per
   project, launches the Viewer, and packages the reviewed run.
3. [`release-redactor`](skills/oxygen-history-redaction/SKILL.md) creates a local, normalized,
   best-effort release candidate and requires human privacy review. It does not guarantee
   anonymity.
4. [`oxygen-elicit-contributor-preferences`](skills/oxygen-elicit-contributor-preferences/SKILL.md)
   finds a small set of high-signal moments, asks evidence-grounded questions, and writes
   `preference-probes.json` without inventing preferences.

## Human quick start

Collection and organization can be started manually:

```bash
python3 tools/ingest/collect_repo_trajectories.py /path/to/repo \
  --out work/my-project

python3 skills/oxygen-organize-review-export/scripts/run_local_review.py \
  work/my-project
```

The second command prints a localhost URL, opens it when the environment supports browser
opening, and must remain running during review. No password is required.

The current Viewer displays organization progress, project timelines, source records, and HTML
and ZIP downloads. Preference probes are presented by the coding agent as one batch and stored in
`work/<run>/preference-probes.json`; do not claim that the current Viewer contains a probe-answer
UI. If a later compatible Viewer exposes those controls, answers must remain reversible and show
immediate feedback.

For the complete operational sequence, privacy gates, package contents, and handoff rules, follow
[SOP.md](SOP.md).
