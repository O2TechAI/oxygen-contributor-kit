# Oxygen local contribution SOP

## Goal

Collect only the contributor's in-scope project history, separate mixed-project content, prepare the
upstream source Privacy boundary, build and human-review Project Story, prepare Story/Release
Privacy candidates and Preferences, then finish with one local reviewed release ZIP. Nothing is
uploaded automatically.

## Desired completion criteria

The workflow is complete only when all of the following are true:

1. The contributor has been shown the local Viewer whenever a browser-visible frontend is
   available. The exact localhost URL is also provided, and no password is required.
2. The contributor has completed Project Story human review, Privacy Keep/Redact decisions, and
   Preference answers, then seen the redaction summary, Release Preview, exclusions, and unresolved
   warnings.
3. The contributor can download one verified `oxygen-contribution.zip`.
4. `publication_approved` remains `false` unless the contributor separately and explicitly
   approves publication.

Current runtime status: clean-room product completion is **NOT YET ACHIEVED** on this base.
Activation-time preparation receipts, Preference readiness binding, and the server-owned Story
Privacy decision authority are implemented. Final decision-only Chapter Privacy and Release Preview
UI/session hydration, All set gating, and reviewed-release transformation remain unimplemented.

## Final public order

Execute the workflow in this order:

```text
Collect
Organize
upstream source Privacy preparation
build Project Story using bounded semantic workers
independent global sparse Insight pass
Story/Release Privacy candidate preparation
Preference-question generation
Project Story human review
Privacy Keep/Redact decisions
Preference answers
All set
local reviewed release
```

Upstream source Privacy prepares the reviewed input boundary before Story generation. Story/Release
Privacy reviews release-safe Chapter/Release targets after the Story exists. Do not call both steps
only "Privacy"; report which boundary is active.

## Stable six-stage index

A stage Agent normally opens the owning Skill rather than this complete SOP. These anchors retain
the full human and maintainer path:

### Stage 1: Collect project history

Continue at [§2 Collect](#2-collect).

### Stage 2: Organize project

Continue at [§3 Organize by project](#3-organize-by-project).

### Stage 3: Prepare upstream source Privacy

Continue at [§4 Prepare upstream source Privacy review](#4-prepare-upstream-source-privacy-review).

### Stage 4: Build Project Story and candidate review artifacts

Continue at [§5 Build Project Story and Review Story](#5-build-project-story-and-review-story).

### Stage 5: Human Story, Privacy, and Preference review

Continue at [§5 Build Project Story and Review Story](#5-build-project-story-and-review-story).

### Stage 6: All set and release handoff

Continue at [§7 Prepare Preferences and Release Preview](#7-prepare-preferences-and-release-preview),
then complete §§8–9.

## 1. Establish the local boundary

- Resolve the repository or input path and confirm it belongs to the contributor.
- Inspect only accounts and paths in the contributor-approved scope.
- Never read or package credential files, private keys, tokens, cookies, browser profiles,
  system/developer prompts, or hidden model reasoning.
- Use only the contributor's configured model/API access. Do not require a bundled Oxygen key.
- Keep raw inputs, working files, redaction cases, and review metadata local.
- Download, ZIP creation, review, and publication are separate actions. None implies another.

Immediately after confirming the target, start the canonical progress-first Viewer **before any
collection**:

```bash
python3 skills/oxygen-organize-review-export/scripts/run_local_review.py \
  --target /path/to/repo
```

The launcher reserves an arbitrary free loopback port, opens the sanitized Workflow Progress UI,
and prints the exact Viewer origin plus stable workflow run ID. Keep the process running through
the remaining stages. Do not begin collection until this surface is healthy. It may store only a
target-confirmed flag, fixed stage/status/blocker codes, justified counts, timestamps, and human-
action state—never the target path, session names, reasoning, prompts, raw model/tool data,
private messages, Story/Evidence payloads, or removed content.

## 2. Collect

Read and follow `skills/oxygen-ingest-project-history/SKILL.md`. Choose the applicable input:

```bash
# Repository-related Codex and Claude Code history, with project-scoped memory.
python3 tools/ingest/collect_repo_trajectories.py /path/to/repo \
  --out work/repo-run --progress-url <viewer-url> --workflow-run-id <run-id>

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
  "D:\Coding Projects\my-project" --out "work\repo-run" `
  --progress-url "<viewer-url>" --workflow-run-id "<run-id>"

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

Check `work/<run>/index.json` for repository/Claude imports or
`work/<run>/meetings/<meeting-id>/meeting.json` for every meeting import. A single meeting uses the
same plural topology as a multi-meeting run; root `meeting.json` is not a supported input. Report
exact source, trajectory, meeting-record, warning, and failure counts. A newly cloned repository may
correctly have zero matching historical sessions. Confirm that credentials, caches, databases,
unrelated users, and unrelated repositories were excluded.

## 3. Organize by project

Read and follow `skills/oxygen-organize-review-export/SKILL.md`.

- Classify events by the project being discussed, not by event type or tool name.
- A conversation may contain several projects; split and label its events accordingly.
- Reconcile aliases for the same project across trajectories and meetings.
- Select the primary project from sustained contributor intent and substantive work.
- Create `work/<run>/project-map.json` while preserving source event IDs and timestamps.
- Build one combined chronological timeline per project across all matching trajectories. Never
  create one timeline per trajectory.
- Distill the primary-project timeline into evidence-derived milestones and Chapters. Apply no
  numeric quota; every selected Chapter must form one coherent, supported project-change arc.

Report how many source records and events were assigned to each project, what was excluded, and
which classification decisions remain uncertain.

Attach the organized run to the already-running progress Viewer so organization advances in the
same workflow run:

```bash
python3 skills/oxygen-organize-review-export/scripts/run_local_review.py work/repo-run \
  --attach-url <viewer-url> --workflow-run-id <run-id>
```

Do not start a second Viewer. When the prepared reviewed boundary or validated Story metadata
changes later, reattach that updated run to the same origin/run ID.

## 4. Prepare upstream source Privacy review

Use the contributor's configured AI model for redaction. The mandatory notice is:

> Best-effort redaction v0.1; no formal anonymity guarantee. Original-contributor final review is
> required before release.

This is the upstream source Privacy boundary. Its output is the reviewed input boundary used by
Story generation. It is distinct from later Story/Release Privacy candidates shown beside Chapter
or Release Preview content.

Use the canonical worker contract at `tools/llm_redact/REDACTION_PROMPT.md`; do not search for a
prompt by basename.

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

## 5. Build Project Story and Review Story

Once `work/<run>-review` is organized and has passed the required privacy preparation, read and
follow `skills/oxygen-storytelling-review/SKILL.md`. Derive project-specific Story data only from
that reviewed boundary and bind the validated result to the canonical Storytelling capability in
the existing Viewer and `viewer/lib/story-*` contracts. Do not build a separate Storytelling
application or copy project prose into reusable source.

Build the complete Project Story with bounded semantic workers, then run an independent global
sparse Insight pass. Prepare Story/Release Privacy candidates only through implemented candidate
authority; do not claim `oxygen.story` contains them. Generate Preference questions from reusable
lessons represented by generated Insight candidates before opening human review; questions remain
unanswered until explicit contributor action. If no valid question exists, validate a completed-zero
probe batch before review.

Opening Project Story for human review requires terminal results for Story generation, global
Insight pass, Story/Release Privacy candidate preparation, and Preference-question generation.
Completed-zero is a valid terminal result for the Insight and Preference lanes when no warranted
Insight or valid question exists. The composed launcher transport now requires the deterministic
Preference bundle and the `oxygen.story-preparation` manifest with coverage and Story candidates.
It imports the exact bundle before it requests Review Story activation, and fails closed on missing,
foreign, stale, malformed, or digest/count-mismatched authority. The tracked Story preparer,
recorder, existing Preference producer, and preparation finalizer create and bind those files.

Parent-owned semantic work starts with the public deterministic preparer. It accepts the canonical
Organization project map or bare semantic manifest through one bounded parser, freezes the exact
assigned identities and input digest, and installs immutable provider-safe worker input before a
proposal exists. Story, Insight, and Story Privacy remain multi-shard lanes, and the
workflow-owning parent enumerates every nonempty manifest shard for them. Preference intentionally
uses exactly one global bounded worker because it produces one deduplicated questionnaire
authority, capped at 12 probes by default and 20 maximum; never fan Preference out. When host
subagents are available, assignments run automatically with at most three live at once. Each
assignment reads exactly one Privacy-safe immutable `inputPath` and writes only its proposal.
Workers never write receipts, final manifests, SQLite, Viewer APIs, revisions, activation state,
release state, or publication state. Internal host subagents are not product provider/API calls,
require no separate API key, and receive no raw/private source beyond the prepared input.

Every `story`-lane subagent assignment must convey this ordered contract before dispatch:

1. Read `skills/oxygen-storytelling-review/references/narrative-writing-contract.md` completely.
2. Read `skills/oxygen-storytelling-review/references/story-data-contract.md` completely.
3. Then read exactly the assignment's one generated Privacy-safe `inputPath`.
4. Write only that assignment's proposal.

Do not dispatch a Story worker until the assignment names both contract paths, the actual generated
`inputPath`, and the proposal-only write boundary. No other data input is part of that assignment.

Finalized Coverage `ownerId` is the sole Story Chapter-ownership source. The Story preparer keeps
every owner's represented units in one complete, Privacy-safe, self-contained bundle and balances
shards only by whole-bundle bytes. Story workers return phase-free proposals. On a subagent-capable
host the parent does not write Story prose, People, Evidence choices, titles, overviews, or blocks.
It waits for every proposal, orders complete Chapters with the production comparator, assigns only
Phase IDs and labels, injects canonical Coverage and exclusions, and invokes one complete Story
batch recorder. No Story receipt exists before full-package validation; all outputs and exactly one
receipt per shard install together. Insight remains a separate later pass.

Each assignment gets one initial proposal plus at most two automatic proposal-only correction attempts. `correctionAttemptCount` is
assignment-local, counts corrections only, excludes the initial proposal, and is always `0..2`;
never sum it across a multi-shard lane. Every correction uses the byte-identical immutable input,
and every invalid initial or correction attempt leaves both output and receipt absent. Only a fixed
safe pre-receipt authoring-validation code is correctable. If the second correction fails, stop the
lane safely, report correction exhaustion and the last safe validation code, and do not continue
downstream. Authority, immutability, containment, path, I/O, infrastructure, and corrupt-state
failures stop immediately and are never correctable. This is not a contributor pause and may never
rewrite durable output. If host subagents are genuinely unavailable, the parent processes the same
assignments serially, reports
`executionMode=serial_capability_limited`, and uses the identical recorder/finalizer authority.
`PAUSE_FOR_BOUNDED_SEMANTIC_WORKERS` is an internal orchestration boundary. Revision authority and
all Viewer mutations remain with the parent/server lane; no worker may silently expand scope or
repair another lane.

Story uses at most two lane-wide correction waves. Replacing a rejected Story proposal or replacing
only the transient parent Phase assignment consumes the same wave; there is no separate Phase retry
budget. Every failed Story wave leaves all Story outputs and receipts absent. Static tests prove the
contract and batch boundary, while later E2E evidence proves actual host-subagent spawning.

Coverage draft rows use only `{unitId, disposition, ownerId}` for represented units or
`{unitId, disposition, exclusionReason}` for excluded units. After successful activation, the exact
submitted coverage manifest becomes the prior accepted authority for regeneration. Rejected output
never becomes prior authority.

The contributor reviews the Project Story, Chapters, Insights, Story/Release Privacy candidates
when present, Preference questions, and exact evidence through the iterative direct edit -> Apply
review loop. Direct editing is the current canonical edit path. Already-existing Delete/Revise/Add
records may be rendered only after exact validation and resolve through the same review ledger.
`All set` creates a human-confirmed Final Release Memory; it does not publish, package
automatically, or set `publication_approved=true`. The Agent pauses as soon as Stage 5 Review Story
activates, again for unresolved Privacy decisions and Preference answers, again for All set, and
again for release handoff.

Use the Viewer workflow-progress surface for user-facing execution status. Update it only at safe
workflow boundaries with sanitized stage/state, real counts where a denominator exists, blocker
codes, timestamps, and human-action state. Do not expose chain-of-thought, prompts, raw model/tool
output, private messages, Story/Evidence content, or removed material through progress.

## 6. Continue and show the Viewer

The progress-first Viewer from §1 is still running. Attach the safe reviewed run to that same
origin and workflow run ID:

```bash
python3 skills/oxygen-organize-review-export/scripts/run_local_review.py \
  work/<run>-review --attach-url <viewer-url> --workflow-run-id <run-id>

# Import only the validated spans produced by merge_and_apply.py.
python3 tools/llm_redact/push_redactions.py \
  --redacted work/<run>-redaction/redacted --base-url <viewer-url>
```

The initial launcher validates Node/npm, resolves the platform-native npm command, repairs missing
or cross-OS `node_modules` with lockfile-preserving `npm ci`, and starts native Next with one fresh
process-owned temporary local SQLite database for this official launcher invocation. The Viewer
owns cleanup when it stops; local database state is not reused. It reserves an OS-selected free
`127.0.0.1` port by default and announces only the exact healthy URL. There is no online deployment
path. An explicit occupied `--port` fails immediately without killing the owning process or
silently falling back.

### Native Windows PowerShell sequence

Run Terminal A from the contributor-kit root. It uses a fixed local port and workflow run ID so
Terminal B can attach without hidden state. Start PowerShell in the contributor-kit root and change
only `$Target` to the contributor-approved project path.

```powershell
$Kit = (Get-Location).Path
$Target = "D:\Coding Projects\my-project"
$Viewer = "http://127.0.0.1:3210"
$WorkflowRun = "oxygen-local-review-001"
Set-Location -LiteralPath $Kit

python .\skills\oxygen-organize-review-export\scripts\run_local_review.py `
  --target "$Target" --workflow-run-id "$WorkflowRun" --port 3210 --no-browser
```

Keep Terminal A running. Run Terminal B from the same contributor-kit root after Collect,
Organize, and upstream source Privacy preparation have produced the reviewed boundary:

```powershell
$Kit = (Get-Location).Path
$Run = "work\repo-run"
$Review = "work\repo-run-review"
$Dialogue = "work\repo-run-dialogue"
$Findings = "work\repo-run-findings"
$Redaction = "work\repo-run-redaction"
$Viewer = "http://127.0.0.1:3210"
$WorkflowRun = "oxygen-local-review-001"
Set-Location -LiteralPath $Kit

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
# Reattach the reviewed boundary to the Viewer already running from §1.
python .\skills\oxygen-organize-review-export\scripts\run_local_review.py `
  "$Review" --attach-url "$Viewer" --workflow-run-id "$WorkflowRun"

# Push only the validated spans produced by merge_and_apply.py.
python .\tools\llm_redact\push_redactions.py `
  --redacted "$Redaction\redacted" `
  --base-url "$Viewer"

python .\skills\oxygen-organize-review-export\scripts\run_local_review.py `
  --attach-url "$Viewer" --workflow-run-id "$WorkflowRun" --story-event started

python .\skills\oxygen-organize-review-export\scripts\run_local_review.py `
  --attach-url "$Viewer" --workflow-run-id "$WorkflowRun" --story-event progress `
  --story-completed 4 --story-total 4

node .\skills\oxygen-storytelling-review\scripts\finalize_story_coverage.mjs `
  "$Review\project-map.json" `
  "$Review\story-coverage-draft.json" `
  "$Review\story-coverage-manifest.json" `
  --source-privacy "$Review\current-public-source-privacy.json"
```

## Composition sequence (implemented transport)

Use one transport root and the current Viewer source revision. For each prepared lane, the parent
performs this lifecycle without contributor intervention:

1. For Story, Insight, and Story Privacy, read the lane's `shards.json` and enumerate every
   deterministic shard. For Preference, require exactly one global shard and one bounded worker;
   do not fan the questionnaire authority out.
2. Dispatch available host subagents with at most three live at once. Each receives exactly one
   `inputPath` and may write only its proposal. If subagents are unavailable, process those same
   assignments serially and set `executionMode=serial_capability_limited`.
   For every `story`-lane assignment, first convey the complete-read requirements for
   `skills/oxygen-storytelling-review/references/narrative-writing-contract.md` and
   `skills/oxygen-storytelling-review/references/story-data-contract.md`; only after both reads may
   the worker read its named generated `inputPath` and write its proposal.
3. Wait for every Story proposal, place exactly one `<shard-id>.json` file in the proposal-only
   directory, order all complete Chapters with the production comparator, create one transient
   unversioned Phase assignment, and invoke the Story batch recorder once. For other lanes, run the
   recorder with that manifest shard ID and proposal path.
4. If the recorder returns a fixed safe pre-receipt authoring-validation code while output and
   receipt are both absent, return it automatically to the same assignment for at most two
   proposal-only corrections. Preserve the byte-identical input and allow only the proposal to
   change. Count only corrections, so assignment-local `correctionAttemptCount` is `0..2` and does
   not include the initial proposal.
   For Story, replacing only the non-authoritative parent Phase assignment is also allowed and
   consumes the same lane-wide correction wave.
5. If the second correction fails, stop the lane safely, report correction exhaustion and the last
   safe validation code, and do not continue downstream. Stop immediately without correction for
   authority, immutability, containment, path, I/O, infrastructure, or corrupt-state failures.
6. For Story, require the atomically installed complete records directory with exactly one terminal
   receipt per expected shard. For other lanes, require one terminal subordinate receipt per
   assignment. Verify exact union and no overlap, then compose/finalize.
7. Continue automatically to the next dependent lane or to the next genuine human-review boundary.

For each reached lane, retain E2E evidence for `executionMode`, `lane`, `shardCount`,
`spawnedSubagentCount`, `maxConcurrentSubagents`, `correctionAttemptCount`, and
`terminalReceiptCount`. The parent owns all recorder/finalizer commands and every Viewer mutation.
The non-Story commands containing `<manifest-shard-id>` and `<proposal-path>` below are executed
once for each enumerated shard, not typed or scheduled by the contributor.

```powershell
$Transport = "$Review\story-preparation"
$StoryProposals = "$Review\story-proposals"
$StoryPhases = "$Review\story-phases.json"
$SourceRevision = 0 # Replace with the current source revision reported by this Viewer run.

node .\skills\oxygen-storytelling-review\scripts\prepare_story_preparation.mjs `
  prepare story "$Review\project-map.json" `
  "$Review\story-coverage-manifest.json" `
  "$Review\current-public-source-privacy.json" `
  "$Review" "$Transport"
# Parent dispatches every Story shard (maximum three live), collects one phase-free
# <shard-id>.json proposal per shard, orders all Chapters, and writes one transient Phase assignment.
node .\skills\oxygen-storytelling-review\scripts\record_story_preparation.mjs `
  "$Transport" story "$StoryProposals" "$StoryPhases" `
  --correction-attempt-count 0
node .\skills\oxygen-storytelling-review\scripts\prepare_story_preparation.mjs `
  compose story "$Transport" "$Review\story-base-candidates.json"

node .\skills\oxygen-storytelling-review\scripts\prepare_story_preparation.mjs `
  prepare insight "$Review\story-base-candidates.json" "$Transport"
# Parent dispatches every Insight manifest shard (maximum three live), waits, then records each proposal.
node .\skills\oxygen-storytelling-review\scripts\record_story_preparation.mjs `
  "$Transport" insight "<manifest-shard-id>" "<proposal-path>"
node .\skills\oxygen-storytelling-review\scripts\prepare_story_preparation.mjs `
  compose final "$Transport" "$Review\story-candidates.json"

node .\skills\oxygen-storytelling-review\scripts\prepare_story_preparation.mjs `
  prepare story_privacy "$Review\story-candidates.json" "$Transport"
# Parent dispatches every Story Privacy manifest shard (maximum three live), waits, then records each proposal.
node .\skills\oxygen-storytelling-review\scripts\record_story_preparation.mjs `
  "$Transport" story_privacy "<manifest-shard-id>" "<proposal-path>"

python .\skills\oxygen-elicit-contributor-preferences\scripts\prepare_preference_context.py `
  --story-candidates "$Review\story-candidates.json" `
  --redacted "$Redaction\redacted" --privacy-report "$Redaction\report.json" `
  --output "$Review\preference-context.json"
node .\skills\oxygen-storytelling-review\scripts\prepare_story_preparation.mjs `
  prepare preference "$Review\story-candidates.json" `
  "$Review\preference-context.json" "$Transport"
# Parent dispatches the one global Preference worker, waits, then validates and records its proposal.
python .\skills\oxygen-elicit-contributor-preferences\scripts\validate_probes.py `
  --context "$Review\preference-context.json" `
  --candidates "<proposal-path>" `
  --workflow-run-id "$WorkflowRun" --source-revision $SourceRevision `
  --output "$Review\preference-bundle.json"
node .\skills\oxygen-storytelling-review\scripts\record_story_preparation.mjs `
  "$Transport" preference "<manifest-shard-id>" "$Review\preference-bundle.json"

node .\skills\oxygen-storytelling-review\scripts\finalize_story_preparation.mjs `
  "$Review\project-map.json" "$Review\story-candidates.json" "$Transport" `
  "$Review\preference-bundle.json" "$Review\story-preparation-manifest.json" `
  --workflow-run-id "$WorkflowRun" --source-revision $SourceRevision
```

The Story and Insight passes are dependent. Story Privacy and Preference become sibling-ready only
after final Story composition and may then run in either order. Workers never write receipts or
digests; the recorder owns those fields. See the Story Skill transport reference for the exact
lane proposal shapes.

Story preparation freezes one minimal validation-authority bundle from the exact reviewed source
generation, current semantic manifest, and current Coverage manifest. It projects private actor
identity to equality-only tokens and applies current final Source Privacy redactions before any
narrative reaches a worker input. The Story recorder and preparation finalizer both call the
unchanged Viewer `validateStorySourcePackage`; a complete Story failure creates no receipt, and a
forged or stale pair cannot create terminal preparation authority.

With those four artifacts produced and validated, launcher ready is:

```powershell
python .\skills\oxygen-organize-review-export\scripts\run_local_review.py `
  --attach-url "$Viewer" --workflow-run-id "$WorkflowRun" --story-event ready `
  --coverage-manifest "$Review\story-coverage-manifest.json" `
  --story-candidates "$Review\story-candidates.json" `
  --preference-bundle "$Review\preference-bundle.json" `
  --preparation-manifest "$Review\story-preparation-manifest.json"

if ($LASTEXITCODE -eq 0) {
  Copy-Item -LiteralPath "$Review\story-coverage-manifest.json" `
    -Destination "$Review\story-coverage-manifest.accepted.json" -Force
}
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

When a validated Story atomically advances the same Viewer to Stage 5 Review Story, this browser
handoff happens immediately, before evaluator QA or any release work. Surface the exact URL, say
that no password is required, and pause with the Viewer and originating Agent alive. Do not invent
human edits, Privacy choices, preference answers, `All set`, or publication state. In unattended
validation the correct terminal state is `WAITING_FOR_HUMAN_STORY_REVIEW`, not a completed package
handoff. Resume release/package work only after the contributor says the review is complete.

The Viewer must show organization progress, project groups, the primary project, one combined
timeline per project, evidence-derived primary-project Chapters, source-event evidence, and visible
HTML/ZIP download actions. Do not describe unsupported annotation controls as available.

Required final surfaces, with current runtime status:

- Final decision-only Chapter Privacy/Release Preview is **NOT YET IMPLEMENTED** on this base.
  Production still exposes obsolete category/delete controls, so clean-room product completion is
  blocked until the Viewer implements the contract below and implemented candidate authority
  supplies candidates.
- Required Privacy review and Release Preview expose only the release-safe projection for
  deterministic or contributor-confirmed safe content. Only `needs_confirmation` rows are
  decision-editable. Those rows show the minimum locally permitted original when present, the
  current safe projection, a safe uncertainty explanation, and exactly two actions: Keep or Redact.
  Unavailable original content is never reconstructed. Pending confirmation blocks Story/package
  release. Do not expose Raw Evidence or suppressed content through Insight review.
- `Preferences` presents generated probes and records explicit answers (§7). Generated questions
  are not confirmed preferences.

Both tabs report `running` with live progress while their pass is in flight, so an empty result is
never mistaken for a finished one. Redactions are stored as offsets and applied at render time —
`items.content` holds the untouched original, which is what makes a decision reversible. Because of
that, a Viewer serving a run is serving unredacted text over its API; never expose it beyond
localhost without an authenticating proxy in front.

## 7. Prepare Preferences and Release Preview

After reusable lessons and Insights exist, read and follow
`skills/oxygen-elicit-contributor-preferences/SKILL.md` on the same privacy-prepared reviewed input.
This question-generation step must run before human review opens. Do not reopen raw project history
or independently run another redaction workflow. If no valid questions exist, record a validated
completed-zero batch before review.

1. Work on the primary-project events unless the contributor asks to include other projects.
2. Reuse the validated privacy summary and reviewed exclusions already attached to the input.
3. Find friction signals such as repeated corrections, long exchanges, late rejection, decision
   reversal, explicit rules, or sustained meeting disagreement.
4. Merge duplicate signals and produce at most 12 probes by default, with a hard limit of 20.
   Report how many qualifying moments were set aside.
5. For each probe, provide a self-contained recap of at most three sentences and two or three
   mutually exclusive, evidence-grounded choices, plus “Something else” and “Nothing worth
   recording here.”
6. Present all probes as one batch. Do not interrupt the contributor once per event.
7. Write the exact three-field `preference-candidates.json`, then use the existing Preference
   producer to create the nine-field bundle. The full copyable commands are in the implemented
   composition sequence above.

```bash
python3 skills/oxygen-elicit-contributor-preferences/scripts/validate_probes.py \
  --context work/<run>-review/preference-context.json \
  --candidates work/<run>-review/preference-candidates.json \
  --workflow-run-id <run-id> --source-revision <current-source-revision> \
  --output work/<run>-review/preference-bundle.json
```

Native Windows PowerShell equivalent:

```powershell
python .\skills\oxygen-elicit-contributor-preferences\scripts\validate_probes.py `
  --context "$Review\preference-context.json" `
  --candidates "$Review\preference-candidates.json" `
  --workflow-run-id "$WorkflowRun" --source-revision $SourceRevision `
  --output "$Review\preference-bundle.json"
```

Only explicit answers become checklist preferences. Unanswered and skipped probes produce no
preference. Questions and answers are Preference authority, not Story review-session state. Every
confirmed preference retains its source evidence IDs. A preference answer is not publication
approval. If no valid probe exists, record a validated completed-zero result; do not infer that the
contributor has no preferences.

The Viewer implements probe-answer controls in its `Preferences` tab. The launcher imports the
validated deterministic Preference bundle during the four-file ready transport; the contributor then
answers in the browser.

Each probe shows its recap, its offered options, `Nothing worth recording here`, a free-text
`Something else`, and its source evidence IDs. Every recorded answer displays what was stored and
offers `clear`, which returns the probe to unanswered rather than recording a refusal. A probe with
no answer produces no preference. Answers live in the `probes` table and are exported with the run;
`preference-probes.json` remains the interchange format for anything outside the Viewer.

## 8. Review and build the ZIP

Ask the contributor to inspect:

- included sources and project assignments;
- primary-project Chapters against source evidence;
- Project Story Chapters, Insights, required Privacy decisions, exact evidence, and any
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
  local databases and logs, private review artifacts, model scratch output, and local virtual
  environments.
- Inspect the ZIP member list after creation and reject unexpected absolute paths, `..` entries,
  symlinks, or excluded files.
- Open the packaged HTML locally and verify that it states nothing was uploaded.
- Make the ZIP directly downloadable through the Viewer's visible action. If that action is not
  available, provide an immediately usable clickable local file/download link.
- Do not finish with only a filesystem path the contributor cannot access.

Before final handoff, run:

```powershell
python .\skills\oxygen-organize-review-export\tests\test_run_local_review.py
python -m py_compile .\skills\oxygen-organize-review-export\tests\test_run_local_review.py
Push-Location -LiteralPath ".\viewer"
node --test .\tests\workflow-contracts.test.mjs
npm test
npm run lint
npx tsc --noEmit --strict
npm run build
Pop-Location
git diff --check
git status --short
```

## 9. Handoff and stop

Tell the contributor:

- the exact Viewer URL and that it has no password;
- included inputs, project groups, primary project, and Chapter count;
- exact privacy-removal counts and any unresolved privacy review;
- probe count, confirmed preference count, and set-aside count;
- exclusions and uncertainties;
- the exact ZIP filename and clickable download action/link;
- the value of `publication_approved`.

Stop after local handoff. Never upload, stage, publish, submit, commit, or push unless the
contributor separately asks for that action.
