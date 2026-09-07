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

The workflow parent reads this Skill once on entering Story. Workers use only their explicit
[worker reading routes](references/story-preparation-transport.md#worker-reading-routes); entering
one lane does not require the parent or worker to read every sibling or later-stage contract.
Read named sections completely. A section range includes all intervening sections; whole-file
entries mean the entire file. Reuse already-read unchanged instructions within the same task.

| Work | Required reading | Gate |
|---|---|---|
| Build parent | [narrative-writing-contract.md](references/narrative-writing-contract.md), whole file; [story-data-contract.md](references/story-data-contract.md#source-prefix-and-schema) from Source Prefix And Schema through [Activation Submission](references/story-data-contract.md#activation-submission); [story-preparation-transport.md](references/story-preparation-transport.md), whole file; privacy [Two Privacy Boundaries](references/privacy-evidence-boundary.md#two-privacy-boundaries), [Provider Processing And Final Export Boundary](references/privacy-evidence-boundary.md#provider-processing-and-final-export-boundary), [Reviewed Boundary Is The Ceiling](references/privacy-evidence-boundary.md#reviewed-boundary-is-the-ceiling). | Current reviewed source, owner-atomic proposals, editorial acceptance, and canonical recording/activation authority. |
| Source language selection | [bilingual-contract.md](references/bilingual-contract.md), whole file before Story preparation. | One run-bound language policy; no per-language authority. |
| Insight, Story Privacy, Preference dispatch | Each exact lane's [worker reading route](references/story-preparation-transport.md#worker-reading-routes); the Preference parent also follows its [owning Skill](../oxygen-elicit-contributor-preferences/SKILL.md). | Frozen dependent input; parent-owned validation and recording. |
| Human review and release | [chapter-review-lifecycle.md](references/chapter-review-lifecycle.md), [ui-interaction-contract.md](references/ui-interaction-contract.md), and [privacy-evidence-boundary.md](references/privacy-evidence-boundary.md), whole files. | Viewer-only review; separate Apply review, All set, and release decisions. |
| Product/maintenance acceptance | [product-contract.md](references/product-contract.md) and [validation-checklist.md](references/validation-checklist.md), whole files. | Product behavior and repository-development verification; not extra contributor-runtime tests. |

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
Story/Release Privacy total proposal preparation
Preference-question generation
Chapter human review: Story -> Insight -> Privacy drafts -> Review summary -> Apply review
source Privacy Keep/Redact decisions
Preference answers
All set
local reviewed release
```

Keep the two Privacy boundaries distinct:

- Upstream source Privacy binds mandatory release authority to the reviewed source before Story generation and blocks release while required source redaction decisions remain unresolved. During Organize and Story authoring, the contributor-selected current Agent/provider may process the exact bound raw reviewed source; this does not authorize release, upload, publication, or a provider switch.
- Story/Release Privacy reviews release-safe Story targets after the Story candidate exists. The Agent authors one meaning-preserving proposal for every target, while candidates remain explanatory metadata. The hydrated Story session stores pending Privacy drafts; Chapter Apply commits them with Story/Insight edits to the existing server-owned target authority.

## Readiness Terminal Rule

Opening Project Story for human review requires terminal results for all four preparation lanes:

- Story generation;
- independent global sparse Insight pass, including an explicit completed-zero result when no Insight is warranted;
- Story/Release Privacy total proposal preparation;
- Preference-question generation, including an explicit completed-zero result when no valid question is warranted.

Preference questions must be generated before the human review UI opens by using reusable lessons represented by generated Insight candidates. They remain unanswered questions until the contributor acts; never report them as confirmed preferences. If no valid question is warranted, validate a completed-zero probe batch before review.

The composed ready transport requires four files: coverage manifest, Story candidates, deterministic
Preference bundle, and `oxygen.story-preparation` manifest. It imports the exact Preference bundle
before it requests Review Story activation and accepts completed-zero Preference output. The
tracked public preparer, recorder, Preference producer, and preparation finalizer create and bind
those files without handwritten digests, receipts, or authority JSON.

## Human Pauses

Pause and wait for explicit contributor action at each of these points:

- unresolved Privacy target choices;
- contributor Preference answers;
- Story review;
- All set;
- release handoff.

Do not fabricate a target choice, infer an answer from silence, click through review on behalf of the contributor, or treat an Agent proposal as approval.

## Viewer And Workflow Identity

The Organizer-owned existing Viewer/run is canonical. Carry the exact `$Viewer`, `$WorkflowRun`,
and `$Review` values from Organizer through Story work. Follow the [Organizer-owned launch and
resume sequence](../oxygen-organize-review-export/SKILL.md#continue-the-same-progress-first-viewer)
for launch or resume, and never start a second Viewer.

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

Follow the single [Story preparation transport](references/story-preparation-transport.md):
prepare immutable assignments, convey each [worker reading route](references/story-preparation-transport.md#worker-reading-routes)
with literal input/proposal paths, collect proposals, and run the parent-owned record/compose/finalize
commands. The transport owns concurrency, correction budgets, the narrow pre-receipt Story takeover,
and atomic output/receipt installation; do not reconstruct those protocols here.

Before Coverage finalization, the parent selects global Chapter owners by coherent narrative arc,
not semantic-unit/source/meeting counts. Each complete owner bundle stays together. Read every
phase-free proposal in full and apply [Parent Editorial Acceptance](references/narrative-writing-contract.md#parent-editorial-acceptance)
before assigning the smallest coherent global Phase sequence and recording the complete Story batch.
A worker writes only its assigned proposal. Recorders, finalizers, exact union/no overlap, Viewer
mutations, and terminal completion belong to the parent. Story, Insight, and Story Privacy are
multi-shard lanes; Preference is exactly one global bounded worker. Human pauses remain only at
explicit review and decision boundaries.

## Coverage Finalizer

First export current Source Privacy authority from the same Viewer/run:

```powershell
python .\skills\oxygen-organize-review-export\scripts\run_local_review.py `
  --attach-url "$Viewer" --workflow-run-id "$WorkflowRun" `
  --source-privacy-export "$Review\current-public-source-privacy.json"
```

Then follow [Coverage Authority](references/story-data-contract.md#coverage-authority), the sole
owner of draft shapes, exclusions, finalizer commands, current Source Privacy validation, and
regeneration's `--previous` rule. Never invent revisions/digests or reuse a rejected activation
output as prior accepted authority.

## Composed Activation Transport

The [public transport sequence](references/story-preparation-transport.md#public-powershell-sequence)
prepares and records Story, composes base Story, prepares/records Insight, composes final Story,
prepares/records Story Privacy and Preference, then finalizes activation authority. The recorder
creates receipts; the Preference producer owns its exact bundle. Workers never open parent-only
validation authority. The recorder and finalizer reuse `validateStorySourcePackage`.

Run the copyable commands in
[story-preparation-transport.md](references/story-preparation-transport.md), then request activation
only after those commands and Coverage finalization produce the four validated files:

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

Activation revalidates the exact source package, semantic manifest, coverage manifest, source revision, and active digest. Success moves the workflow to Review Story with `storySourceSchema: "oxygen.story"` and `storySessionSchema: "oxygen.story-review-session"`. Failure keeps Story building or blocked; fix the validated cause before submitting again.

## Review, Preferences, And Release

The contributor reviews the Story in the Viewer. The review session contains only the implemented fields documented in [chapter-review-lifecycle.md](references/chapter-review-lifecycle.md). It does not store Preference answers. Preference questions are generated and validated before the human review opens, then remain unanswered until the contributor explicitly answers in the Preferences authority.

AI Insight cards remain separate from Story prose and appear beside their one anchored paragraph;
on narrow screens they follow it immediately. The exact bound reviewed source Quote and its anchor are
read-only while the explanatory fields are reviewed. Human-created Insight keeps its distinct exact
user-selected Story-substring Quote origin and lifecycle. Release uses the accepted source Quote,
not Story paragraph text, and strips anchor and Evidence identities.

Each Chapter contains its Privacy original/proposal/reason and accept, edit, or exact noncredential-public controls. Choices are durable drafts until the contributor's single Apply review commits this Chapter's Story, Insight, and Privacy choices atomically. Custom edits and pending accepted Insights receive prospective Privacy preparation through the existing workflow parent. Release Preview is read-only and compares local originals with expected release wording; suggestions, drafts, waiting-for-review text, and applied choices are clearly distinguished. Originals, review metadata, evidence IDs, anchors, and Story review ledgers never enter `oxygen.reviewed-story`, `oxygen-reviewed-story.html`, or `oxygen-contribution.zip`.

### Refresh reviewed Story Privacy

During review the parent watches the existing workflow `storyReviewVersion`, checks Story Privacy preparation needs after durable draft changes, and continues the existing refresh route. After a Story, Insight, or custom Privacy edit, treat `preparation_required` as a resumable authority refresh and
follow the parent-owned procedure in [`SOP.md`](../../SOP.md#refresh-story-privacy-after-a-story-edit).
Keep the same localhost Viewer and workflow run, use a new private directory, and never repair SQLite
or author an import bundle by hand. Each worker writes the canonical total Story Privacy output
defined only in [story-preparation-transport.md](references/story-preparation-transport.md) for its
generated assigned targets. Credential
occurrences are never publishable, and HTML and ZIP consume the exact same contributor-selected bytes.

All set confirms the current reviewed Story locally. It does not publish, upload, merge, push, or set `publication_approved=true`.

## Completion Standard

Story preparation is complete only when a fresh contributor Agent can execute the public workflow's
Story preparation transport from the reviewed boundary without prior chat context, hidden prompts, JSON surgery, database
repair, code edits, or maintainer rescue. A specific run reaches product completion only after the
implemented Chapter Privacy review, Chapter All set decisions, Preference answers, and final release
confirmation are satisfied for the current authority. The final package remains local, provider-free
after approved generation steps, and carries `publication_approved=false`.

Repository-development verification belongs to CI and maintainers; it is not part of contributor runtime.
