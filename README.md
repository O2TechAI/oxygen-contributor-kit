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

On Linux/WSL, the official Viewer launcher verifies the configured Node/npm pair against the
exact `viewer/package.json` engine. If dependencies are absent or were created by a different
operating system, it rebuilds them reproducibly with `npm ci` and leaves the lockfile unchanged.

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
