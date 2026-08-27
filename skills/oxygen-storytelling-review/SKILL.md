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

## Final Public Flow

Use this order exactly:

```text
Collect
Organize
upstream source Privacy preparation -> reviewed input boundary
Build Project Story and independent global Insight pass
Story/Release Privacy candidate preparation
Preference-question generation
human Story, Privacy, and Preference review
All set
local reviewed release
```

Keep the two Privacy boundaries distinct:

- Upstream source Privacy prepares the reviewed input boundary before Story generation. It removes or replaces source material and blocks release while required source redaction decisions remain unresolved.
- Story/Release Privacy reviews release-safe Story targets after the Story candidate exists. On this base, `oxygen.story` does not contain Privacy candidates and the hydrated Story session does not restore top-level candidate decisions; if Story/Release Privacy candidates are required for a run but no implemented candidate authority exists, stop before claiming review or release readiness.

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

Start the progress-first Viewer before collection if it is not already running:

```bash
python3 skills/oxygen-organize-review-export/scripts/run_local_review.py \
  --target /path/to/repo
```

Attach the organized reviewed run to that same Viewer/run:

```bash
python3 skills/oxygen-organize-review-export/scripts/run_local_review.py work/<run>-review \
  --attach-url <viewer-url> --workflow-run-id <run-id>
```

`<viewer-url>` must be the exact local origin printed by the launcher, for example `http://127.0.0.1:<port>`. `<run-id>` must be the exact stable workflow run ID. Do not start a second Viewer for Story work.

## Build Project Story

Before generating the Story candidate, mark the existing workflow as building Story:

```bash
python3 skills/oxygen-organize-review-export/scripts/run_local_review.py \
  --attach-url <viewer-url> --workflow-run-id <run-id> --story-event started
```

Optional real progress may be reported only with known counts:

```bash
python3 skills/oxygen-organize-review-export/scripts/run_local_review.py \
  --attach-url <viewer-url> --workflow-run-id <run-id> --story-event progress \
  --story-completed <n> --story-total <n>
```

Use bounded subagents only for drafts and checks:

- Story writer: reads only the reviewed input boundary, writes candidate Chapters, People, Story blocks, and Evidence references, and reports uncertainty.
- Independent Insight pass: reads the completed candidate Story after Chapter coverage is complete, proposes zero or more warranted Insights, and may return none.

The owning Agent remains responsible for deterministic validation, final artifact shape, coverage finalization, activation, and human-pause enforcement.

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

Write the unit-level coverage draft with `rows` only. Then run the provider-free finalizer:

```bash
node skills/oxygen-storytelling-review/scripts/finalize_story_coverage.mjs \
  work/<run>-review/project-map.json \
  work/<run>-review/story-coverage-draft.json \
  work/<run>-review/story-coverage-manifest.json
```

For regeneration, pass `--previous` only with the last server-accepted normalized coverage authority:

```bash
node skills/oxygen-storytelling-review/scripts/finalize_story_coverage.mjs \
  work/<run>-review/project-map.json \
  work/<run>-review/story-coverage-draft.json \
  work/<run>-review/story-coverage-manifest.json \
  --previous work/<run>-review/server-accepted-story-coverage.json
```

Never invent coverage revisions or digests in model output. A rejected activation output is not prior authority.

## Activation

After Story data, Evidence references, and normalized coverage all validate, request atomic activation:

```bash
python3 skills/oxygen-organize-review-export/scripts/run_local_review.py \
  --attach-url <viewer-url> --workflow-run-id <run-id> --story-event ready \
  --coverage-manifest work/<run>-review/story-coverage-manifest.json \
  --story-candidates work/<run>-review/story-candidates.json
```

Activation revalidates the exact source package, semantic manifest, coverage manifest, source revision, and active digest. Success moves the workflow to Review Story with `storySourceSchema: "oxygen.story"` and `storySessionSchema: "oxygen.story-review-session"`. Failure keeps Story building or blocked; retry only after fixing the validated cause.

## Review, Preferences, And Release

The contributor reviews the Story in the Viewer. The review session contains only the implemented fields documented in [chapter-review-lifecycle.md](references/chapter-review-lifecycle.md). It does not store Preference answers. Preference questions are generated from reusable lessons and Insights, may be prepared before the human review opens, and remain unanswered until the contributor explicitly answers in the Preferences authority.

Release Preview shows only the release-safe projection. When source Privacy has `needs_confirmation`, it may show the minimum permitted local original beside the current safe projection, a safe uncertainty reason, and Keep/Redact. Unavailable originals are never reconstructed. Originals, review metadata, evidence IDs, anchors, and Story review ledgers never enter `oxygen.reviewed-story`, `oxygen-reviewed-story.html`, or `oxygen-contribution.zip`.

All set confirms the current reviewed Story locally. It does not publish, upload, merge, push, or set `publication_approved=true`.

## Completion Standard

This work is complete only when a fresh contributor Agent can execute the public workflow from the reviewed boundary without prior chat context, hidden prompts, JSON surgery, database repair, code edits, or maintainer rescue. The final package remains local, provider-free after approved generation steps, and carries `publication_approved=false`.
