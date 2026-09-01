<div align="center">

# Oxygen Contributor Kit

*Turn your own agent history into an AI-redacted, locally reviewed contribution without automatic upload or publication.*

[![SOP](https://img.shields.io/badge/SOP-READ_FIRST-2563eb?style=for-the-badge)](SOP.md)
[![Agent contract](https://img.shields.io/badge/AGENT-CONTRACT-1f2937?style=for-the-badge)](AGENTS.md)
[![Skills](https://img.shields.io/badge/SKILLS-4-7c3aed?style=for-the-badge)](#included-skills)
[![Upload](https://img.shields.io/badge/UPLOAD-NEVER_AUTOMATIC-dc2626?style=for-the-badge)](#local-boundary)

[![Python](https://img.shields.io/badge/PYTHON-3.11+-3776ab?style=for-the-badge&logo=python&logoColor=white)](#requirements)
[![Node](https://img.shields.io/badge/NODE-22+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](#requirements)
[![Redaction](https://img.shields.io/badge/REDACTION-AI_REVIEW-f59e0b?style=for-the-badge)](#ai-redaction)

<p>
  <strong>Leading Team: Estelle Zhang · Zihan Wang · Yuxiang Lin · Bruce Tian · Andrew Zhou · Henry Sun · Manling Li </strong>
</p>



<p>
  <a href="mailto:estelle.zhang@o2tech.ai">Become a contributor</a>
</p>


<!-- Hero image: drop the file at docs/hero.png and uncomment the line below.
<img src="docs/hero.png" alt="Oxygen Contributor Kit pipeline: collect, organize, redact, review, package" width="900">
-->

</div>

---

## The one-line version

Point your coding agent at this repo and say:

> Use the Oxygen Contributor Kit for this repository. Collect only my in-scope local history,
> organize it by project, prepare the privacy review, build Project Story and Preference questions,
> pause for my Story review, then collect my Preference answers, show Release Preview, and finish
> with a downloadable ZIP.
> Do not upload or publish anything.

The agent starts with [AGENTS.md](AGENTS.md), then opens each owning Skill when its stage begins.
[SOP.md](SOP.md) remains the complete human and maintainer reference, not mandatory whole-file
startup context for every Agent run.

---

## The pipeline

```text
  your repo  ·  Claude export  ·  meeting audio
                      │
                      ▼
        ①  COLLECT      only sessions whose cwd is inside the repo
                      │
                      ▼
        ②  ORGANIZE     project labels · one combined timeline
                       │
                       ▼
        ③  CHECK PRIVACY  prepared reviewed input · fail-closed validation
                       │
                       ▼
        ④  BUILD PROJECT STORY  evidence-derived Chapters · no numeric quota
                       │
                       ▼
        ⑤  REVIEW STORY  human review in the local Viewer · Agent pauses
                       │
                       ▼
        ⑥  RELEASE HANDOFF  Preferences · Release Preview · reviewed ZIP
```

`All set`, producing or downloading a ZIP, and answering a preference question are each separate
from publication. `publication_approved` remains `false` throughout this local-only workflow.

---

## Local boundary

- The Viewer binds to localhost. No password, because nothing else should be able to reach it.
- The localhost Viewer, working artifacts, and final package flow do not automatically upload or
  publish data. `publication_approved=false` remains unchanged.
- During Organization and Story authoring, the contributor-selected current coding Agent/model
  provider may process raw or private project material so semantic meaning and narrative quality
  survive. Oxygen does not silently switch providers or send Privacy-derived data to a second
  endpoint.
- Credential-shaped files are skipped at collection time, not filtered out later.
- The source Privacy backend sends **only conversational turns** to the configured model. Code,
  tool calls, tool output, and artifacts are stripped before that separate review step.

---

## AI redaction

Redaction uses the model already configured for the contributor's coding agent. Before model
review, `prepare_ai_review_run.py` converts every tool call, tool result, command, path, artifact,
and other non-conversational event into a fixed action label. Only conversational turns enter the
model review set.

The model produces offset-based findings, never a replacement copy of the run. The toolkit treats
those findings as untrusted, validates them, and stores accepted spans in the local Viewer. The
downloadable ZIP is built only after a completed pass with zero rejected spans, and it applies the
currently active Viewer decisions while excluding raw event envelopes.

### Model output is treated as untrusted

Every check below exists because the failure it catches actually happened:

| Check | Catches |
|---|---|
| Offsets re-verified against stored text | spans pointing at positions that do not exist |
| Category allowlist | invented categories reaching the review surface |
| `verify_coverage.py` (exits non-zero) | a worker reporting turns it never reviewed |
| Probe evidence must resolve | a question that cannot be reopened at its original moment |
| Empty input set is an error | a filter that matches nothing and reports success |

`audit_coverage.py` prints how much of a run the pass actually looked at. Run it. Conversational
turns can be a low single-digit percentage of the bytes a run would ship, and a pass over the
wrong input reports a healthy hit count while reviewing almost none of it.

---

## The Viewer

The existing local Viewer shell carries workflow progress and Organization progress; the Project
Story Timeline with Phases and Milestones; Chapter Story and Insights; Privacy choices;
Preferences; All set; Release Preview; and HTML/ZIP handoff.

Editing reviewed Story text invalidates only the affected Story Privacy targets. When the Viewer
shows `preparation_required`, use the single documented refresh sequence in
[`SOP.md`](SOP.md#refresh-story-privacy-after-a-story-edit): export the current reviewed snapshot,
prepare every changed-target shard, finalize the exact proposal set, import the bound bundle, then
continue the same local review. No database edits or hand-written authority JSON are part of that
workflow.

Redactions are stored as offsets and applied at render time, so the stored text is the untouched
original. That is what makes a decision reversible — and it is also why a Viewer serving a run is
serving unredacted text over its API. Never expose it beyond localhost without an authenticating
proxy in front.

---

## Requirements

- Python 3.11+
- Node.js 22+ and npm
- Local Codex and/or Claude Code history, for repository collection
- Optional: meeting-audio dependencies and your own transcription credentials — which must never
  enter the collected data

On native Windows and Linux/WSL, the official Viewer launcher verifies the configured Node/npm
pair against the exact `viewer/package.json` engine. It resolves the platform's real npm command
(`npm.cmd` on Windows), rejects `node_modules` created by another operating system, and rebuilds
missing or incompatible dependencies reproducibly with `npm ci` without changing the lockfile.

Meeting audio is optional and separate from the core workflow. Keep its dependencies in
`tools/ingest/.venv-audio`; the importer recognizes
`tools/ingest/.venv-audio/Scripts/python.exe` on Windows and
`tools/ingest/.venv-audio/bin/python` on POSIX. The launcher does not install audio packages or
credentials.

## Codex session discovery

Codex sessions are user-global, not repository-local. The default collector root is
`Path.home() / ".codex" / "sessions"`, which is normally
`C:\Users\<user>\.codex\sessions` on Windows and `~/.codex/sessions` on Linux/WSL. A
repository-local `.codex` is toolkit fixture/runtime space and is not searched by default.

Eligibility is intentionally strict: a session's recorded cwd must be the repository itself or a
child directory. Parent directories, sibling repositories, and sessions whose message bodies only
mention the repository are excluded. Therefore a successful global-store scan can correctly
return zero matches for a new worktree or for histories recorded under another repository path.

---

## Included skills

Run in this order:

1. **[`oxygen-ingest-project-history`](skills/oxygen-ingest-project-history/SKILL.md)** — collects
   repository-related Codex/Claude sessions and allowed memory, imports Claude exports, processes
   meeting text or audio.
2. **[`oxygen-organize-review-export`](skills/oxygen-organize-review-export/SKILL.md)** — labels
   mixed conversations by project, selects the primary project, builds one combined timeline per
   project, continues the progress-first Viewer, and packages the reviewed run.
3. **[`oxygen-storytelling-review`](skills/oxygen-storytelling-review/SKILL.md)** — transforms an
   already-reviewed project history into an evidence-linked, bilingual Project Story with
   iterative human confirmation that remains separate from publication.
4. **[`oxygen-elicit-contributor-preferences`](skills/oxygen-elicit-contributor-preferences/SKILL.md)**
   — before Story review opens, generates or validates evidence-grounded questions from reusable
   Insight candidates. Questions remain unanswered until explicit contributor action after review.

Supporting tools live in [`tools/llm_redact/`](tools/llm_redact/) (model backend, validators,
audits) and [`tools/ingest/`](tools/ingest/) (collection and import).

---

## Manual quick start

```bash
# 1. Terminal 1: resolve the target, reserve a free port, and show progress before collection.
python3 skills/oxygen-organize-review-export/scripts/run_local_review.py \
  --target /path/to/repo \
  --save-state /external/private-state/oxygen-session-<fresh-id>

# Record the exact URL and workflow run ID printed above, then use Terminal 2.
VIEWER_URL=http://127.0.0.1:<port>
WORKFLOW_RUN_ID=<run-id>
SOURCE_PRIVACY_RECEIPT=work/my-source-privacy-receipt.json
SOURCE_PRIVACY_EXPORT=work/my-review/current-public-source-privacy.json

# 2. Collect with fixed operational progress events only.
python3 tools/ingest/collect_repo_trajectories.py /path/to/repo --out work/my-project \
  --progress-url "$VIEWER_URL" --workflow-run-id "$WORKFLOW_RUN_ID"

# 3. Finalize the collected corpus in the same Viewer before Organization.
python3 skills/oxygen-organize-review-export/scripts/run_local_review.py work/my-project \
  --attach-url "$VIEWER_URL" --workflow-run-id "$WORKFLOW_RUN_ID" --collection-only

# 4. After the agent creates project-map.json, attach ordinarily to complete Organization.
python3 skills/oxygen-organize-review-export/scripts/run_local_review.py work/my-project \
  --attach-url "$VIEWER_URL" --workflow-run-id "$WORKFLOW_RUN_ID"

# 5. Build the AI review boundary.
python3 tools/llm_redact/prepare_ai_review_run.py \
  --run work/my-project --out work/my-review

# 6. See what a redaction pass would actually be reviewing.
python3 tools/llm_redact/audit_coverage.py work/my-review

# 7. Attach the reviewed boundary before creating dialogue assignments or a receipt.
python3 skills/oxygen-organize-review-export/scripts/run_local_review.py work/my-review \
  --attach-url "$VIEWER_URL" --workflow-run-id "$WORKFLOW_RUN_ID"

# 8. Extract only conversational turns from that current reviewed authority.
python3 tools/llm_redact/extract_dialogue.py work/my-review --out work/my-dialogue \
  --base-url "$VIEWER_URL" --workflow-run-id "$WORKFLOW_RUN_ID"

# 9. After the model writes one findings JSON per bundle, validate and merge.
python3 tools/llm_redact/verify_coverage.py \
  --dialogue work/my-dialogue --findings work/my-findings \
  --receipt "$SOURCE_PRIVACY_RECEIPT"
python3 tools/llm_redact/merge_and_apply.py \
  --dialogue work/my-dialogue --findings work/my-findings --out work/my-redaction \
  --receipt "$SOURCE_PRIVACY_RECEIPT"

# 10. Push validated spans into that exact Viewer, then export its current public authority.
python3 tools/llm_redact/push_redactions.py \
  --redacted work/my-redaction/redacted --base-url "$VIEWER_URL" \
  --receipt "$SOURCE_PRIVACY_RECEIPT"
python3 skills/oxygen-organize-review-export/scripts/run_local_review.py \
  --attach-url "$VIEWER_URL" --workflow-run-id "$WORKFLOW_RUN_ID" \
  --source-privacy-export "$SOURCE_PRIVACY_EXPORT"
```

For the native Windows sequence, follow the [canonical Windows sequence in SOP](SOP.md#native-windows-powershell-sequence).

Do not make a source-bearing attach between dialogue extraction and the corresponding push. It
changes the current source authority, so the existing assignments, findings, receipt, and
merged output are stale. Extract new assignments from the current Viewer and repeat review and
validation; do not re-sign, hand-edit, or reuse the old receipt.

Optional Windows audio uses a project-local environment only. Install its optional dependencies
there before use; text meeting import does not need them:

```powershell
$AudioPython = ".\tools\ingest\.venv-audio\Scripts\python.exe"
& $AudioPython -c "import faster_whisper"  # availability check only

$env:HF_TOKEN = "<current-user-token>"
try {
  python .\tools\ingest\import_meeting.py "D:\Meetings\meeting.m4a" `
    --out "work\meeting-run" --language en --date "2026-08-30"
}
finally {
  Remove-Item Env:\HF_TOKEN -ErrorAction SilentlyContinue
}
```

The progress-first launcher prints the localhost URL and stable workflow run ID before collection;
keep that owned process running through review. Download ZIP remains blocked
until the AI pass is complete, every bundle has worker output, and every rejected span has been
resolved. `push_redactions.py` reads `work/my-redaction/report.json` automatically and refuses to
mark the pass complete when coverage is missing.

Each official launcher invocation uses native Next with one fresh process-owned temporary local
SQLite database and binds directly to IPv4 loopback. The Viewer owns cleanup when it stops; no
database state is reused. By default the OS reserves an arbitrary free port and the launcher
announces it only after that exact port becomes healthy. There is no online deployment path. Use
`--port <number>` for a specific isolated port; an occupied port fails immediately with a clear
diagnostic and no unrelated process is stopped.

Resume only with the exact saved path printed by that launch, from the same original contributor-kit
checkout at the same Git HEAD. A different path, checkout, commit, or workflow run is rejected.

---

## What this does not promise

> **Best-effort redaction; no formal anonymity guarantee. Original-contributor final review is
> required before release.**

This kit reduces risk. It does not eliminate it, and it cannot tell you that a release candidate
is safe — only that its own checks passed. Read what you are about to publish.

For the complete operational sequence, privacy gates, package contents, and handoff rules, follow
[SOP.md](SOP.md).
