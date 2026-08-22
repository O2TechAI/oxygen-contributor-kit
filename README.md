<div align="center">

# Oxygen Contributor Kit

*Turn your own agent history into an AI-redacted, locally reviewed contribution without automatic upload or publication.*

[![SOP](https://img.shields.io/badge/SOP-READ_FIRST-2563eb?style=for-the-badge)](SOP.md)
[![Agent contract](https://img.shields.io/badge/AGENT-CONTRACT-1f2937?style=for-the-badge)](AGENTS.md)
[![Skills](https://img.shields.io/badge/SKILLS-3-7c3aed?style=for-the-badge)](#included-skills)
[![Upload](https://img.shields.io/badge/UPLOAD-NEVER_AUTOMATIC-dc2626?style=for-the-badge)](#local-boundary)

[![Python](https://img.shields.io/badge/PYTHON-3.11+-3776ab?style=for-the-badge&logo=python&logoColor=white)](#requirements)
[![Node](https://img.shields.io/badge/NODE-22+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](#requirements)
[![Redaction](https://img.shields.io/badge/REDACTION-AI_REVIEW-f59e0b?style=for-the-badge)](#ai-redaction)

<p>
  <strong>Contributors: Estelle Zhang · Zihan Wang · Yuxiang Lin · Andrew Zhou · Henry Sun · Zidi Xiong · Manling Li </strong>
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

> Follow the Oxygen contributor SOP for this repository. Collect only my in-scope local history,
> organize it by project, prepare the privacy review, ask me the preference questions as one
> batch, open the local Viewer as soon as it is available, and finish with a downloadable ZIP.
> Do not upload or publish anything.

The agent reads [AGENTS.md](AGENTS.md) and [SOP.md](SOP.md) before it touches anything.

---

## The pipeline

```text
  your repo  ·  Claude export  ·  meeting audio
                      │
                      ▼
        ①  COLLECT      only sessions whose cwd is inside the repo
                      │
                      ▼
        ②  ORGANIZE     project labels · one combined timeline · 10-40 milestones
                      │
                      ▼
        ③  PREPARE      every non-conversational event becomes a bare action label
                      │              (code, commands, paths, artifacts: gone)
                      ▼
        ④  REDACT       your configured AI model, then fail-closed validation
                      │
                      ▼
        ⑤  REVIEW       local Viewer: release preview · edit · delete · answer probes
                      │
                      ▼
        ⑥  PACKAGE      one ZIP, publication_approved = false
```

Producing or downloading a ZIP **is not** publication approval. Neither is answering a preference
question. Each is a separate, explicit act.

---

## Local boundary

- The Viewer binds to localhost. No password, because nothing else should be able to reach it.
- Raw inputs, working files, model findings, and review metadata stay local.
- Credential-shaped files are skipped at collection time, not filtered out later.
- The model backend sends **only conversational turns**, and only to the model you have already
  configured. Code, tool calls, tool output, and artifacts are stripped before that point and are
  never sent.

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

Three tabs, all local:

- **Timeline** — the combined project timeline and its milestones.
- **Release preview** — every event that would ship, original beside release version. Change a
  span's category or delete it; both take effect immediately. Deletion is soft, so the decision
  stays auditable.
- **Preferences** — the probe batch, with evidence IDs. An unanswered or cleared probe records
  **no** preference; silence is never read as agreement.

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
   project, launches the Viewer, packages the reviewed run.
3. **[`oxygen-elicit-contributor-preferences`](skills/oxygen-elicit-contributor-preferences/SKILL.md)**
   — finds high-signal friction moments and asks evidence-grounded questions, without inventing
   preferences.

Supporting tools live in [`tools/llm_redact/`](tools/llm_redact/) (model backend, validators,
audits) and [`tools/ingest/`](tools/ingest/) (collection and import).

---

## Manual quick start

```bash
# 1. collect
python3 tools/ingest/collect_repo_trajectories.py /path/to/repo --out work/my-project

# 2. after the agent creates project-map.json, build the AI review boundary
python3 tools/llm_redact/prepare_ai_review_run.py \
  --run work/my-project --out work/my-review

# 3. see what a redaction pass would actually be reviewing
python3 tools/llm_redact/audit_coverage.py work/my-review

# 4. extract only conversational turns for the configured model
python3 tools/llm_redact/extract_dialogue.py work/my-review --out work/my-dialogue

# 5. after the model writes one findings JSON per bundle, validate and merge
python3 tools/llm_redact/verify_coverage.py \
  --dialogue work/my-dialogue --findings work/my-findings
python3 tools/llm_redact/merge_and_apply.py \
  --dialogue work/my-dialogue --findings work/my-findings --out work/my-redaction

# 6. review locally; keep this process running
python3 skills/oxygen-organize-review-export/scripts/run_local_review.py work/my-review

# 7. in another terminal, push validated spans into the Viewer
python3 tools/llm_redact/push_redactions.py \
  --redacted work/my-redaction/redacted
```

Native Windows PowerShell uses the same workflow without `python -X utf8`, `chcp`, WSL, or a
localhost fallback:

```powershell
$Repo = "D:\Coding Projects\my-project"
$Run = "work\my-project"
$Review = "work\my-review"
$Dialogue = "work\my-dialogue"
$Findings = "work\my-findings"
$Redaction = "work\my-redaction"
$Port = 3296

# 1. Collect from C:\Users\<user>\.codex\sessions by default.
python .\tools\ingest\collect_repo_trajectories.py "$Repo" `
  --out "$Run"

# 2. After the agent creates project-map.json, prepare the safe review boundary.
python .\tools\llm_redact\prepare_ai_review_run.py `
  --run "$Run" --out "$Review"
python .\tools\llm_redact\audit_coverage.py "$Review"
python .\tools\llm_redact\extract_dialogue.py "$Review" `
  --out "$Dialogue"

# 3. After the configured AI model writes one findings file per bundle.
python .\tools\llm_redact\verify_coverage.py `
  --dialogue "$Dialogue" --findings "$Findings"
python .\tools\llm_redact\merge_and_apply.py `
  --dialogue "$Dialogue" --findings "$Findings" --out "$Redaction"

# 4. Keep the official local Viewer running during review.
python .\skills\oxygen-organize-review-export\scripts\run_local_review.py `
  "$Review" --port $Port

# 5. In another PowerShell terminal, push only validated findings.
python .\tools\llm_redact\push_redactions.py `
  --redacted "$Redaction\redacted" `
  --base-url "http://127.0.0.1:$Port"
```

Optional Windows audio uses a project-local environment only. Install its optional dependencies
there before use; text meeting import does not need them:

```powershell
$AudioPython = ".\tools\ingest\.venv-audio\Scripts\python.exe"
& $AudioPython -c "import faster_whisper"  # availability check only

$env:HF_TOKEN = "<current-user-token>"
try {
  python .\tools\ingest\import_meeting.py "D:\Meetings\meeting.m4a" `
    --out "work\meeting-run" --language en --no-publish
}
finally {
  Remove-Item Env:\HF_TOKEN -ErrorAction SilentlyContinue
}
```

Step 6 prints a localhost URL and must keep running during review. Download ZIP remains blocked
until the AI pass is complete, every bundle has worker output, and every rejected span has been
resolved. `push_redactions.py` reads `work/my-redaction/report.json` automatically and refuses to
mark the pass complete when coverage is missing.

Each official launch uses a fresh process-owned D1 runtime and binds Vinext directly to the
requested IPv4 loopback port. Existing `viewer/.wrangler` data is never reused or deleted. Use
`--port <number>` for an isolated non-default port; an occupied port fails immediately with a
clear diagnostic and no unrelated process is stopped.

---

## What this does not promise

> **Best-effort redaction v0.1; no formal anonymity guarantee. Original-contributor final review is
> required before release.**

This kit reduces risk. It does not eliminate it, and it cannot tell you that a release candidate
is safe — only that its own checks passed. Read what you are about to publish.

For the complete operational sequence, privacy gates, package contents, and handoff rules, follow
[SOP.md](SOP.md).
