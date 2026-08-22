# Oxygen local contribution SOP

## Goal

Collect only the contributor's in-scope project history, separate mixed-project content, build a
concise chronological account of the primary project, prepare a best-effort privacy-reviewed
candidate, recover confirmed working preferences, show the local review surface, and finish with
one downloadable ZIP. Nothing is uploaded automatically.

## Completion criteria

The workflow is complete only when all of the following are true:

1. The contributor has been shown the local Viewer whenever a browser-visible frontend is
   available. The exact localhost URL is also provided, and no password is required.
2. The contributor has seen the collection counts, project classification, redaction summary,
   preference questions, exclusions, and unresolved warnings.
3. The contributor can download one verified `oxygen-contribution.zip`.
4. `publication_approved` remains `false` unless the contributor separately and explicitly
   approves publication.

## 1. Establish the local boundary

- Resolve the repository or input path and confirm it belongs to the contributor.
- Inspect only accounts and paths in the contributor-approved scope.
- Never read or package credential files, private keys, tokens, cookies, browser profiles,
  system/developer prompts, or hidden model reasoning.
- Use only the contributor's configured model/API access. Do not require a bundled Oxygen key.
- Keep raw inputs, working files, redaction cases, and review metadata local.
- Download, ZIP creation, review, and publication are separate actions. None implies another.

## 2. Collect

Read and follow `skills/oxygen-ingest-project-history/SKILL.md`. Choose the applicable input:

```bash
# Repository-related Codex and Claude Code history, including allowed memory.
python3 tools/ingest/collect_repo_trajectories.py /path/to/repo \
  --out work/repo-run

# claude.ai export ZIP, JSON, file, or directory.
python3 tools/ingest/import_anthropic_export.py export.zip \
  --out work/claude-run

# Meeting notes/transcript or local audio. Audio remains local.
python3 tools/ingest/import_meeting.py meeting.m4a \
  --out work/meeting-run --language en --no-publish
```

Native Windows PowerShell equivalents are:

```powershell
python .\tools\ingest\collect_repo_trajectories.py `
  "D:\Coding Projects\my-project" --out "work\repo-run"

python .\tools\ingest\import_anthropic_export.py `
  "D:\Downloads\export.zip" --out "work\claude-run"

python .\tools\ingest\import_meeting.py `
  "D:\Meetings\meeting.txt" --out "work\meeting-run" --no-publish
```

Codex collection searches the user-global `Path.home() / ".codex" / "sessions"` by default:
normally `C:\Users\<user>\.codex\sessions` on Windows and `~/.codex/sessions` on
Linux/WSL. Repository-local `.codex` directories are ignored toolkit fixture/runtime space, not
default Codex session storage. Include only sessions whose recorded cwd is exactly the target
repository or a child. Exclude parent, sibling, and body-mention-only sessions. A zero-match result
can therefore mean that the global store was searched successfully but contains no cwd-scoped
history for this worktree path.

Optional Windows audio dependencies belong in
`tools\ingest\.venv-audio\Scripts\python.exe`; text meeting import does not require them. When a
user supplies a Hugging Face token for optional local audio, scope it to the current process and
remove it afterwards:

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

Do not pass `--publish` and do not stage, upload, or submit the result.

Check `work/<run>/index.json` and, when present, `work/<run>/meeting.json`. Report exact source,
trajectory, meeting-record, warning, and failure counts. A newly cloned repository may correctly
have zero matching historical sessions. Confirm that credentials, caches, databases, unrelated
users, and unrelated repositories were excluded.

## 3. Organize by project

Read and follow `skills/oxygen-organize-review-export/SKILL.md`.

- Classify events by the project being discussed, not by event type or tool name.
- A conversation may contain several projects; split and label its events accordingly.
- Reconcile aliases for the same project across trajectories and meetings.
- Select the primary project from sustained contributor intent and substantive work.
- Create `work/<run>/project-map.json` while preserving source event IDs and timestamps.
- Build one combined chronological timeline per project across all matching trajectories. Never
  create one timeline per trajectory.
- Distill the primary-project timeline to 10-40 meaningful milestones. Use the agent to rewrite
  each milestone as a short, one-idea description while retaining the original timestamp and
  evidence IDs.

Report how many source records and events were assigned to each project, what was excluded, and
which classification decisions remain uncertain.

## 4. Prepare privacy review

Use the contributor's configured AI model for redaction. The mandatory notice is:

> Best-effort redaction v0.1; no formal anonymity guarantee. Original-contributor final review is
> required before release.

First create the AI review boundary from the organized raw run:

```bash
python3 tools/llm_redact/prepare_ai_review_run.py \
  --run work/<run> --out work/<run>-review
```

This preserves conversational text and stable evidence IDs, but every non-conversational agent
action, tool call, shell command, output, artifact, and source metadata becomes a fixed action
label. Run all subsequent model, probe, Viewer, and package steps on `work/<run>-review`, never on
the raw ingest directory.

Do not send source text to a third-party redaction or PII-scrubbing service. The contributor's own
configured model access is not a third-party service in this sense and is permitted under §1.

`tools/llm_redact` sends only the prepared conversational turns to the contributor's own
configured model. Code, tool calls, tool output, source paths, and artifacts have already been
replaced by fixed labels and are never sent.

Use a mid-tier model or better. The smallest tier of a model family is a false economy here: in
comparison runs it returned a materially higher rate of offsets that did not exist, reported
coverage counts it had not actually reviewed, and missed findings in the highest-severity
categories that a larger model caught. Validate whichever you choose — the checks below exist
because a redaction pass that fails quietly looks exactly like one that succeeded.

A model can return an offset that does not exist, a category outside the allowlist, or a coverage
count it did not actually review;
`tools/llm_redact/merge_and_apply.py` and `verify_coverage.py` reject each of those rather than
letting them reach the release candidate. Report the rejection count alongside the hit count — a
pass with zero rejections and a pass whose failures were dropped silently look identical otherwise.
`verify_coverage.py` exits non-zero on a mismatch and is meant to gate the pipeline, not to be read
by eye; run it against the probe pass too.

Two failures found the hard way, both of which look like success:

- **Run the model pass on the prepared review run, never on the raw run.** Conversational turns can be a
  low single-digit percentage of the bytes a run would ship — the rest is artifact content the
  low single-digit percentage of the raw bytes. A pass over the raw run reports a healthy hit
  count while never reviewing tool or artifact content. The prepared review run ensures those
  events can ship only as bare labels. Run `tools/llm_redact/audit_coverage.py` against it.
- **A filter that matches nothing must fail, not pass.** A coverage gate over an empty bundle can
  otherwise print `0 trajectories checked, 0 mismatched` and look successful. Every helper must
  exit non-zero on an empty input set.

Important boundaries:

- Keep the raw organized run unchanged and local. Redaction acts on the prepared review run; an
  undo means rebuilding from retained local source, not publishing raw content.
- Report exact automatic-redaction totals and per-category counts, including an explicit zero.
- Do not expose removed text in summaries, logs, or `preference-probes.json`.
- Semantic findings require review; never silently bulk-waive them.
- The Viewer stores accepted findings as editable offsets. Soft-deleted spans do not enter the
  ZIP; every active span does.
- ZIP export must remain blocked while the AI pass is missing, running, or has rejected spans.
- If model access is unavailable or a fail-closed check fails, report the blocker and do not
  claim the release candidate is safe.

## 5. Elicit confirmed preferences

Read and follow
`skills/oxygen-elicit-contributor-preferences/SKILL.md` after project organization and after unsafe
content has been excluded from the review copy.

1. Work on the primary-project events unless the contributor asks to include other projects.
2. Report the exact automatic-removal counts from the privacy pass.
3. For judgement-call content such as named-person criticism, ask one bulk question per category:
   remove, keep, or inspect. Default to keep when unanswered.
4. Find friction signals such as repeated corrections, long exchanges, late rejection, decision
   reversal, explicit rules, or sustained meeting disagreement.
5. Merge duplicate signals and produce at most 12 probes by default, with a hard limit of 20.
   Report how many qualifying moments were set aside.
6. For each probe, provide a self-contained recap of at most three sentences and two or three
   mutually exclusive, evidence-grounded choices, plus “Something else” and “Nothing worth
   recording here.”
7. Present all probes as one batch. Do not interrupt the contributor once per event.
8. Write `work/<run>-review/preference-probes.json` and validate it:

```bash
python3 skills/oxygen-elicit-contributor-preferences/scripts/validate_probes.py \
  work/<run>-review
```

Only explicit answers become checklist preferences. Unanswered and skipped probes produce no
preference. Every confirmed preference retains its source evidence IDs. A preference answer is
not publication approval.

The Viewer implements probe-answer controls in its `Preferences` tab. Generate the batch, push it
with `tools/llm_redact/push_probes.py`, and let the contributor answer in the browser:

```bash
python3 tools/llm_redact/push_probes.py \
  --probes work/<run>-probes --dialogue work/<run>-dialogue \
  --summary work/<run>-review/preference-probes.json --limit 12
```

Each probe shows its recap, its offered options, `Nothing worth recording here`, a free-text
`Something else`, and its source evidence IDs. Every recorded answer displays what was stored and
offers `clear`, which returns the probe to unanswered rather than recording a refusal. A probe with
no answer produces no preference. Answers live in the `probes` table and are exported with the run;
`preference-probes.json` remains the interchange format for anything outside the Viewer.

## 6. Prepare Storytelling Review

Once `work/<run>-review` is organized and has passed the required privacy preparation, read and
follow `skills/oxygen-storytelling-review/SKILL.md`. Derive project-specific Story data only from
that reviewed boundary and bind the validated result to the canonical Storytelling capability in
the existing Viewer (`InlineWorkspace`, `StoryChapterEditor`, and their `viewer/lib/story-*`
contracts). Do not build a separate Storytelling application or copy project prose into reusable
source.

The contributor reviews the Project Story, Chapters, inline insight, Privacy candidates, and exact
evidence through the iterative annotation → Apply review loop. `All set` creates a human-confirmed
Final Release Memory; it does not publish, package automatically, or set
`publication_approved=true`. After Story review, continue through the existing Release preview,
Preferences, and ZIP flow below.

## 7. Launch and show the Viewer

Start the local review server:

```bash
python3 skills/oxygen-organize-review-export/scripts/run_local_review.py \
  work/<run>-review
```

On native Windows and Linux/WSL the launcher validates Node/npm, resolves the platform-native npm
command, repairs missing or cross-OS `node_modules` with lockfile-preserving `npm ci`, binds
directly to `127.0.0.1`, and creates fresh launch-owned D1 state. Do not move or delete
`.wrangler`; the official launcher never reuses it. To select a non-default port, pass
`--port <number>`. If the port is occupied, startup fails immediately without killing the owning
process.

After the server is healthy, push the validated AI spans from another terminal:

```bash
python3 tools/llm_redact/push_redactions.py \
  --redacted work/<run>-redaction/redacted
```

### Native Windows PowerShell sequence

Run this from the contributor-kit root. It uses an arbitrary free port and the canonical IPv4
loopback URL; it does not require `python -X utf8`, `chcp`, WSL, or persistent environment edits.

```powershell
$Run = "work\repo-run"
$Review = "work\repo-run-review"
$Dialogue = "work\repo-run-dialogue"
$Findings = "work\repo-run-findings"
$Redaction = "work\repo-run-redaction"
$Probes = "work\repo-run-probes"
$Port = 3298

python .\tools\llm_redact\prepare_ai_review_run.py `
  --run "$Run" --out "$Review"
python .\tools\llm_redact\audit_coverage.py "$Review"
python .\tools\llm_redact\extract_dialogue.py "$Review" `
  --out "$Dialogue"

# After the configured AI model writes one findings JSON per dialogue bundle:
python .\tools\llm_redact\verify_coverage.py `
  --dialogue "$Dialogue" --findings "$Findings"
python .\tools\llm_redact\merge_and_apply.py `
  --dialogue "$Dialogue" --findings "$Findings" --out "$Redaction"
python .\skills\oxygen-elicit-contributor-preferences\scripts\validate_probes.py `
  "$Review"

# Terminal 1: keep the official Viewer running through review and download.
python .\skills\oxygen-organize-review-export\scripts\run_local_review.py `
  "$Review" --port $Port

# Terminal 2: push only validated findings and probes to that exact Viewer.
python .\tools\llm_redact\push_redactions.py `
  --redacted "$Redaction\redacted" `
  --base-url "http://127.0.0.1:$Port"
python .\tools\llm_redact\push_probes.py `
  --probes "$Probes" --dialogue "$Dialogue" `
  --summary "$Review\preference-probes.json" --limit 12 `
  --base-url "http://127.0.0.1:$Port"
```

The push command automatically reads the adjacent `report.json`. It refuses incomplete worker
coverage and carries the validator's rejected count into the Viewer, where any nonzero count blocks
ZIP creation until the findings are corrected and the pass is rerun.

As soon as it is healthy:

1. Proactively open it in the contributor's visible browser when supported.
2. Always print and send the exact localhost URL, even when automatic opening succeeds.
3. Reuse an available in-app browser or visible frontend surface.
4. If opening is unavailable, provide a clickable URL and state that no password is required.
5. Keep the process alive until review/download finishes or the contributor asks to stop.

The Viewer must show organization progress, project groups, the primary project, one combined
timeline per project, 10-40 concise primary-project milestones, source-event evidence, and visible
HTML/ZIP download actions. Do not describe unsupported annotation controls as available.

Two further tabs are available once their passes have run:

- `Redaction review` lists **every** event that would ship, not only the changed ones, so the tab
  is a release preview rather than a diff. Events with a hit show the original beside the release
  version; the rest show the single text that would be published. Each span carries its category,
  the reason it was marked, and controls to change the category or delete the decision. Deleting is
  a soft delete: the span stops applying but the record stays auditable.
- `Preferences` presents the probe batch and records answers (§5).

Both tabs report `running` with live progress while their pass is in flight, so an empty result is
never mistaken for a finished one. Redactions are stored as offsets and applied at render time —
`items.content` holds the untouched original, which is what makes a decision reversible. Because of
that, a Viewer serving a run is serving unredacted text over its API; never expose it beyond
localhost without an authenticating proxy in front.

## 8. Review and build the ZIP

Ask the contributor to inspect:

- included sources and project assignments;
- primary-project milestones against source evidence;
- Project Story Chapters, inline insight, required Privacy decisions, exact evidence, and any
  unresolved Story annotations;
- AI-redaction counts, rejected-span count, and semantic review decisions;
- bulk judgement-call decisions;
- confirmed preference answers and skipped/unanswered probes;
- exclusions and unresolved warnings.

Download `oxygen-contribution.zip` from the Viewer. The reviewed package should contain:

```text
oxygen-contribution/
├── manifest.json
├── data/                         # reviewed trajectories, memory, and meetings
├── project-map.json              # project labels and project timelines
├── preference-probes.json        # questions and explicit answers, when generated
├── privacy/                      # safe aggregate notice/summary, no private review ledger
└── review/
    └── oxygen-local-viewer.html
```

Requirements:

- The manifest records exact counts, warnings, source types, creation time, exclusions, and
  `publication_approved`.
- Package only AI-reviewed release data with all active spans applied. Never package raw inputs,
  original event envelopes, private findings, reviewer identities, local runtime state, or
  original secrets.
- Block ZIP generation if the AI pass is absent, incomplete, or reports any rejected span.
- Exclude `.env*`, auth files, tokens, cookies, private keys, browser profiles, `node_modules`,
  caches, `.wrangler`, databases, logs, model scratch output, and local virtual environments.
- Inspect the ZIP member list after creation and reject unexpected absolute paths, `..` entries,
  symlinks, or excluded files.
- Open the packaged HTML locally and verify that it states nothing was uploaded.
- Make the ZIP directly downloadable through the Viewer's visible action. If that action is not
  available, provide an immediately usable clickable local file/download link.
- Do not finish with only a filesystem path the contributor cannot access.

## 9. Handoff and stop

Tell the contributor:

- the exact Viewer URL and that it has no password;
- included inputs, project groups, primary project, and milestone count;
- exact privacy-removal counts and any unresolved privacy review;
- probe count, confirmed preference count, and set-aside count;
- exclusions and uncertainties;
- the exact ZIP filename and clickable download action/link;
- the value of `publication_approved`.

Stop after local handoff. Never upload, stage, publish, submit, commit, or push unless the
contributor separately asks for that action.
