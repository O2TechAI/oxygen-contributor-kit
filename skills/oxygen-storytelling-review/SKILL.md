---
name: oxygen-storytelling-review
description: Build and human-review Oxygen's final Project Story from a privacy-prepared reviewed contribution boundary. Use after Collect, Organize, and upstream source Privacy preparation; reuse the existing local Viewer and never approve publication.
---

# Oxygen Storytelling Review

Use this Skill to turn the reviewed input boundary into the final unversioned Oxygen Story products:

```text
oxygen.story:
oxygen.story
oxygen.story-review-session
oxygen.reviewed-story
```

The Skill is executable documentation, not a second workflow engine. The launcher starts or attaches the local Viewer and posts safe workflow events. Story writing, Insight selection, Privacy review, Preferences, and release handoff remain explicit workflow work with human pauses.

## Routed References

Read the referenced file completely before doing that work.

| Work | Load | Gate |
|---|---|---|
| Build Story | [product-contract.md](references/product-contract.md), [story-data-contract.md](references/story-data-contract.md), [privacy-evidence-boundary.md](references/privacy-evidence-boundary.md), [narrative-writing-contract.md](references/narrative-writing-contract.md) | The candidate uses `oxygen.story:` and `schema: "oxygen.story"` and is validated against reviewed evidence and coverage authority. |
| Human review | [chapter-review-lifecycle.md](references/chapter-review-lifecycle.md), [ui-interaction-contract.md](references/ui-interaction-contract.md) | The Viewer is the only review surface. Apply review, All set, and release are separate human gates. |
| Localization present | [bilingual-contract.md](references/bilingual-contract.md) | English Story/release authority is canonical. Any localized presentation is optional and non-blocking unless the product code implements it safely. |
| Final acceptance | [validation-checklist.md](references/validation-checklist.md) | Run the listed deterministic, build, browser, clean-room, and residual-scan gates before handoff. |

## Non-negotiable boundaries

Canonical Toolkit boundary: reuse the repository Viewer and Story runtime. `viewer/lib/timeline.ts`
parses the current Story source, `viewer/lib/story-readiness.ts` owns readiness validation and
atomic workflow activation, and release reconstruction remains server-owned.

Direct typing, caret insertion, selection replacement/deletion, Undo/Redo, Apply review, All set,
and release handoff stay in the existing Viewer/review contracts. Do not create a second workflow
runner, provider client, database repair path, schema adapter, or hidden JSON-surgery lane.

The workflow must be executable by a completely fresh, contextless Agent using only public
instructions and the reviewed input boundary. Never expose chain-of-thought, prompts,
private latent reasoning, raw model/tool payloads, suppressed content, or release-unsafe Evidence
through progress, Insight review, release preview, HTML, or ZIP output.

## Final Public Flow

Use this order exactly:

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

Keep the two Privacy boundaries distinct:

- Upstream source Privacy prepares the reviewed input boundary before Story generation. It removes or replaces source material and blocks release while required source redaction decisions remain unresolved.
- Story/Release Privacy reviews release-safe Story targets after the Story candidate exists. On this base, `oxygen.story` does not contain Privacy candidates and the hydrated Story session does not restore top-level candidate decisions; if Story/Release Privacy candidates are required for a run but no implemented candidate authority exists, stop before claiming review or release readiness.

## Readiness Terminal Rule

Opening Project Story for human review requires terminal results for all four preparation lanes:

- Story generation;
- independent global sparse Insight pass, including an explicit completed-zero result when no Insight is warranted;
- Story/Release Privacy candidate preparation;
- Preference-question generation, including an explicit completed-zero result when no valid question is warranted.

Preference questions must be generated before the human review UI opens by using reusable lessons represented by generated Insight candidates. They remain unanswered questions until the contributor acts; never report them as confirmed preferences. If no valid question is warranted, validate a completed-zero probe batch before review.

The composed ready transport requires four files: coverage manifest, Story candidates, deterministic
Preference bundle, and `oxygen.story-preparation` manifest. It imports the exact Preference bundle
before it requests Review Story activation and accepts completed-zero Preference output. The
Preference producer and preparation finalizer are parallel composition dependencies, not files in
this isolated launcher branch; do not add a stub or fallback.

## Human Pauses

Pause and wait for explicit contributor action at each of these points:

- unresolved Privacy Keep/Redact decisions;
- contributor Preference answers;
- Story review;
- All set;
- release handoff.

Do not fabricate a decision, infer an answer from silence, click through review on behalf of the contributor, or treat a generated candidate as approval.

## Viewer And Workflow Identity

The canonical Viewer is local only. It must be the same origin and workflow run throughout the run.

Start PowerShell in the contributor-kit root, then start the progress-first Viewer before collection if it is not already running. This command uses a fixed local port and workflow run ID so later commands are executable without hidden state:

```powershell
$Kit = (Get-Location).Path
$Target = "D:\Coding Projects\my-project"
$Viewer = "http://127.0.0.1:3210"
$WorkflowRun = "oxygen-local-review-001"
Set-Location -LiteralPath $Kit

python .\skills\oxygen-organize-review-export\scripts\run_local_review.py `
  --target "$Target" --workflow-run-id "$WorkflowRun" --port 3210 --no-browser
```

Keep that PowerShell window running. Start the second PowerShell window in the same contributor-kit root, then attach the organized reviewed run to that same Viewer/run:

```powershell
$Kit = (Get-Location).Path
$Review = "work\repo-run-review"
$Viewer = "http://127.0.0.1:3210"
$WorkflowRun = "oxygen-local-review-001"
Set-Location -LiteralPath $Kit

python .\skills\oxygen-organize-review-export\scripts\run_local_review.py `
  "$Review" --attach-url "$Viewer" --workflow-run-id "$WorkflowRun"
```

Do not start a second Viewer for Story work.

## Build Project Story

Before generating the Story candidate, mark the existing workflow as building Story:

```powershell
python .\skills\oxygen-organize-review-export\scripts\run_local_review.py `
  --attach-url "$Viewer" --workflow-run-id "$WorkflowRun" --story-event started
```

Optional real progress may be reported only with known counts:

```powershell
python .\skills\oxygen-organize-review-export\scripts\run_local_review.py `
  --attach-url "$Viewer" --workflow-run-id "$WorkflowRun" --story-event progress `
  --story-completed 4 --story-total 4
```

Use Master-owned bounded semantic workers only for drafts and checks. The desired contract requires the owning Agent to prepare deterministic inputs first:

- create an immutable input digest;
- assign explicit semantic unit IDs;
- write byte/content-balanced shard manifests;
- launch separate bounded workers for Story writing, Insight reasoning, Privacy reasoning, and Preference-question reasoning;
- require a receipt from every worker with input digest, shard ID, unit IDs covered, output path, and terminal status;
- validate exact union coverage and no overlap across shard manifests and receipts;
- deterministically deduplicate and compose outputs;
- keep revision authority, activation, and release decisions in the owning Agent/server lane;
- fail closed on any missing, foreign, stale, overlapping, or scope-expanded receipt.

No worker may silently expand scope, reopen raw history, repair another lane, or treat another lane's failure as success.

The provider-free deterministic shard/receipt validator and its activation binding are **REQUIRED/NOT YET IMPLEMENTED**. Until that exists, do not claim exact union/no-overlap across worker shards has been executably validated. The owning Agent remains responsible for final artifact shape, coverage finalization, activation, and human-pause enforcement.

Generate these local artifacts from `work/<run>-review`:

```text
project-map.json
story-coverage-draft.json
story-coverage-manifest.json
story-candidates.json
preference-probes.json
```

`story-candidates.json` is a bounded JSON array of rows shaped only as:

```json
[
  { "id": "existing-imported-item-id", "summary": "oxygen.story:{...}" }
]
```

The ID must already exist in the reviewed input. The summary payload must satisfy [story-data-contract.md](references/story-data-contract.md). The launcher and server derive source identity; they are not provider clients and do not write Story prose.

## Coverage Finalizer

Write the unit-level coverage draft with `rows` only. Each row must have exactly one of these shapes:

```json
{ "unitId": "unit-a", "disposition": "represented", "ownerId": "chapter-a" }
{ "unitId": "unit-b", "disposition": "excluded", "exclusionReason": "routine_non_narrative" }
```

Then run the provider-free finalizer:

```powershell
node .\skills\oxygen-storytelling-review\scripts\finalize_story_coverage.mjs `
  "$Review\project-map.json" `
  "$Review\story-coverage-draft.json" `
  "$Review\story-coverage-manifest.json"
```

For regeneration, pass `--previous` only with the exact coverage manifest that was submitted in the last successful activation. Copy or rename the submitted file as accepted only after `--story-event ready` succeeds. A rejected activation output never becomes prior authority.

```powershell
$AcceptedCoverage = "$Review\story-coverage-manifest.accepted.json"
node .\skills\oxygen-storytelling-review\scripts\finalize_story_coverage.mjs `
  "$Review\project-map.json" `
  "$Review\story-coverage-draft.json" `
  "$Review\story-coverage-manifest.json" `
  --previous "$AcceptedCoverage"
```

Never invent coverage revisions or digests in model output.

## Composed Activation Transport

The exact sequence is: prepare Preference context -> bounded Agent candidates -> deterministic
Preference bundle -> preparation finalizer -> launcher ready with four files. The finalizer supplies
the exact terminal receipts for story, insight, story_privacy, and preference.

Request activation only after those composition dependencies produce the four validated files:

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

Activation revalidates the exact source package, semantic manifest, coverage manifest, source revision, and active digest. Success moves the workflow to Review Story with `storySourceSchema: "oxygen.story"` and `storySessionSchema: "oxygen.story-review-session"`. Failure keeps Story building or blocked; retry only after fixing the validated cause.

## Review, Preferences, And Release

The contributor reviews the Story in the Viewer. The review session contains only the implemented fields documented in [chapter-review-lifecycle.md](references/chapter-review-lifecycle.md). It does not store Preference answers. Preference questions are generated and validated before the human review opens, then remain unanswered until the contributor explicitly answers in the Preferences authority.

Final decision-only Chapter Privacy/Release Preview is **NOT YET IMPLEMENTED** on this base. Production still exposes obsolete category/delete controls, so clean-room product completion is blocked. Required Release Preview behavior is release-safe projection only: deterministic or contributor-confirmed safe content shows safe projection only; `needs_confirmation` is the only actionable state; actions are exactly Keep/Redact; pending content may show only the minimum permitted original and safe projection; unavailable originals are never reconstructed; pending confirmation blocks release. Originals, review metadata, evidence IDs, anchors, and Story review ledgers never enter `oxygen.reviewed-story`, `oxygen-reviewed-story.html`, or `oxygen-contribution.zip`.

All set confirms the current reviewed Story locally. It does not publish, upload, merge, push, or set `publication_approved=true`.

## Completion Standard

This work is complete only when a fresh contributor Agent can execute the public workflow from the reviewed boundary without prior chat context, hidden prompts, JSON surgery, database repair, code edits, or maintainer rescue. On this base that standard is **NOT YET MET** because the final Chapter Privacy/Release Preview UI, project All set, release gating, and clean-room completion remain unimplemented. The final package remains local, provider-free after approved generation steps, and carries `publication_approved=false`.

Run final verification from the repository root:

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
