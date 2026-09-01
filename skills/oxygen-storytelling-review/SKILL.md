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
| Build Story | [product-contract.md](references/product-contract.md), [story-data-contract.md](references/story-data-contract.md), [story-preparation-transport.md](references/story-preparation-transport.md), [privacy-evidence-boundary.md](references/privacy-evidence-boundary.md), [narrative-writing-contract.md](references/narrative-writing-contract.md) | Public prepare/record/compose commands bind the `oxygen.story:` candidate with `schema: "oxygen.story"` to reviewed semantic, worker, Privacy, and Preference authority. |
| Human review | [chapter-review-lifecycle.md](references/chapter-review-lifecycle.md), [ui-interaction-contract.md](references/ui-interaction-contract.md) | The Viewer is the only review surface. Apply review, All set, and release are separate human gates. |
| Localization present | [bilingual-contract.md](references/bilingual-contract.md) | Follow the single canonical run-bound Story language policy; do not create per-language authorities. |
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
Story/Release Privacy total proposal preparation
Preference-question generation
Project Story human review
Privacy target choices
Preference answers
All set
local reviewed release
```

Keep the two Privacy boundaries distinct:

- Upstream source Privacy binds mandatory release authority to the reviewed source before Story generation and blocks release while required source redaction decisions remain unresolved. During Organize and Story authoring, the contributor-selected current Agent/provider may process the exact bound raw reviewed source; this does not authorize release, upload, publication, or a provider switch.
- Story/Release Privacy reviews release-safe Story targets after the Story candidate exists. The Agent authors one meaning-preserving proposal for every target, while candidates remain explanatory metadata. The hydrated Story session does not own target choices; the server-owned target authority does.

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

Use parent-owned bounded semantic workers only for drafts and checks. The tracked public transport
requires the owning Agent to prepare deterministic inputs first:

- create an immutable input digest;
- establish one global Chapter-owner skeleton by coherent narrative arc across the complete
  bound reviewed semantic projection, never by defaulting or mechanically copying `ownerId` from
  `unitId` and never from a golden count;
- derive canonical Chapter owners only from finalized Coverage `ownerId`;
- write byte-balanced Story shards containing indivisible complete owner bundles;
- automatically enumerate every nonempty Story, Insight, and Story Privacy shard and run those as multi-shard lanes;
- run Preference as exactly one global bounded worker producing one deduplicated questionnaire authority, capped at 12 probes by default and 20 maximum;
- collect and read every phase-free Story proposal in full before creating any Story receipt;
- bind one eight-question parent editorial acceptance to the exact digest of every current proposal;
- assign the smallest coherent Phase sequence once across the complete production-ordered and
  editorially accepted Chapter set, then run one Story batch recorder;
- require exactly one terminal receipt per Story shard after global validation;
- validate exact union coverage and no overlap across shard manifests and receipts;
- deterministically deduplicate and compose outputs;
- keep revision authority, activation, and release decisions in the owning Agent/server lane;
- fail closed on any missing, foreign, stale, overlapping, or scope-expanded receipt.

When host subagents are available, the parent must dispatch them in waves of no more than three
live at once; silently performing all semantic reasoning in the parent is invalid. Each assignment
reads exactly one immutable provider-bound `inputPath` and writes only its proposal. Workers never
write receipts, final manifests, SQLite, Viewer APIs, revisions, activation state, release state,
or publication state. The parent exclusively runs recorders, installs authority, verifies
exact union/no overlap, finalizes authority, performs Viewer mutations, and waits for all terminal
receipts. No worker may silently expand scope, reopen raw history, repair another lane, or treat
another lane's failure as success.

Every `story`-lane subagent assignment must convey this ordered contract before dispatch:

1. Read `skills/oxygen-storytelling-review/references/narrative-writing-contract.md` completely.
2. Read `skills/oxygen-storytelling-review/references/story-data-contract.md` completely.
3. Then read exactly the assignment's one generated provider-bound `inputPath`.
4. Write only that assignment's proposal.

Do not dispatch a Story worker unless its assignment names both required contract paths, its one
actual generated `inputPath`, and its proposal-only write boundary. The worker must not read any
other data input or write a receipt, final artifact, or authority file.

Each Story input is self-contained for writing and contains complete owner bundles: all represented
semantic units owned by that exact Coverage owner, the corresponding exact bound raw reviewed
narrative, canonical semantic/Coverage references, and equality-only actor tokens. It contains no excluded
narrative, raw actor identity, Source Privacy rows, source outside the exact reviewed boundary, or
provider metadata. The narrative is the exact bound raw reviewed source and may be processed only
by the contributor-selected current provider. One owner never spans workers; a shard may carry multiple complete owners.

Story workers return phase-free Chapter proposals and do not author schema, Chapter keys, Phase,
Coverage, exclusions, receipts, or authority. On a subagent-capable host the parent does not
initially write Story prose, People, Evidence choices, titles, overviews, or blocks. The parent
reads every Chapter in full and binds its eight narrative decisions to that exact proposal digest.
A dry, fragmented, mechanical, incomplete, or record-by-record proposal is rejected before Phase
and receipt, receives a specific proposal-only correction against the byte-identical input, and is
then re-read in full. After all proposals pass, the parent orders complete Chapters with the
production comparator, assigns only the smallest coherent global Phase IDs and labels, injects
canonical Coverage and UTF-8-sorted exclusions, and invokes the complete Story batch recorder. All
Story outputs and exactly one receipt per shard install atomically only after the editorial gate and
unchanged shared validator accept the complete package. Insight remains a separate later pass.

Each Insight worker receives only assigned frozen Story candidates, their Story blocks and Evidence
references, the minimum exact bound reviewed narrative rows those blocks reference, and the existing
validation-authority reference. `anchorStoryBlockId` controls card placement only; `quote.text` must
be one exact current bound reviewed trajectory substring bound to one supporting `quote.evidence`
identity for that anchored passage. It is never reconstructed from Story prose. Invalid proposals
create no output or receipt; finalization and Viewer activation independently reopen current
authority and fail closed. Completed-zero is valid.

A shard assignment gets one initial proposal plus at most two parent-orchestrated proposal-only correction
attempts. `correctionAttemptCount` is assignment-local, counts corrections only, excludes the
initial proposal, and is always `0..2`; never sum it across a multi-shard lane. Every correction
uses the byte-identical immutable input, and every invalid initial or correction attempt leaves both
output and receipt absent. Only a fixed safe pre-receipt authoring-validation code is correctable.
If the second correction fails, stop the lane safely, report correction exhaustion and the last
safe validation code, and do not continue downstream, except that after two Story proposals are
rejected specifically for editorial quality, the Ultra parent may complete that same
still-unrecorded assignment from the byte-identical input using the same canonical phase-free
proposal shape, editorial gate, recorder, and validators. This narrow takeover is not a second
authority, fallback format, or repair of recorded output. Authority, immutability, containment,
path, I/O, infrastructure, and corrupt-state failures stop immediately and are never correctable. Only
the non-authoritative proposal may change; this is not a contributor pause and may never rewrite
durable output. If host subagents are genuinely unavailable, the parent runs the same assignments
serially, reports
`executionMode=serial_capability_limited`, and continues through the identical recorder/finalizer
authority without asking the contributor to create workers. Internal host subagents are not product
provider/API calls, require no separate API key, and receive no source beyond the exact bound
reviewed input. `PAUSE_FOR_BOUNDED_SEMANTIC_WORKERS` is an internal boundary only.

For Story, the initial complete proposal set is non-authoritative and the two allowed corrections
are lane-wide waves. Replacing a rejected proposal or replacing only the non-authoritative Phase
assignment consumes the same Story correction wave. Failed waves leave every Story output and
receipt absent; there is no separate Phase retry budget.

Later E2E evidence records `executionMode`, `lane`, `shardCount`, `spawnedSubagentCount`,
`maxConcurrentSubagents`, `correctionAttemptCount`, and `terminalReceiptCount` for every reached
lane. Contributor pauses remain only at explicit human review and decision boundaries.

Execute the exact public commands and proposal shapes in
[story-preparation-transport.md](references/story-preparation-transport.md). Preparation installs
immutable bounded input before proposals exist. Story recording validates every shard proposal,
the exact owner/unit union, one complete parent Phase assignment, canonical exclusions, and the
complete source package before atomically installing the full terminal records directory. Other
lanes keep their per-shard output/receipt boundary.
Composition reconstructs `story-candidates.json` from recorded Story and Insight results. The
finalizer reopens and validates every artifact before emitting activation authority.

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
python .\skills\oxygen-organize-review-export\scripts\run_local_review.py `
  --attach-url "$Viewer" --workflow-run-id "$WorkflowRun" `
  --source-privacy-export "$Review\current-public-source-privacy.json"

node .\skills\oxygen-storytelling-review\scripts\finalize_story_coverage.mjs `
  "$Review\project-map.json" `
  "$Review\story-coverage-draft.json" `
  "$Review\story-coverage-manifest.json" `
  --source-privacy "$Review\current-public-source-privacy.json"
```

`current-public-source-privacy.json` must be the unchanged, current JSON response/projection from
the same Viewer's public Source Privacy surface. The finalizer requires it even when the completed
Privacy pass contains zero rows. It accepts only a current complete job with `rejected=0` and
`completed=total`, exact canonical row order, and exact membership in the current semantic
manifest. Only active `deterministic` and `confirmed_redact` rows authorize a semantic unit for
`privacy_withheld`; `needs_confirmation` and `confirmed_keep` do not. A unit is authorized only
when it owns at least one such current final-redacted member.

The source Privacy file is validation input only. The coverage output remains exactly the
unversioned coverage manifest and contains no Source Privacy rows, authority list, offsets,
categories, reasons, source text, or other private metadata. Missing, stale, foreign, reordered,
duplicated, or tampered Privacy/membership input fails closed. Completed-zero authorizes an empty
set: coverage without `privacy_withheld` may finalize, while any `privacy_withheld` row fails.

For regeneration, pass `--previous` only with the exact coverage manifest that was submitted in the last successful activation. Copy or rename the submitted file as accepted only after `--story-event ready` succeeds. A rejected activation output never becomes prior authority.

```powershell
$AcceptedCoverage = "$Review\story-coverage-manifest.accepted.json"
node .\skills\oxygen-storytelling-review\scripts\finalize_story_coverage.mjs `
  "$Review\project-map.json" `
  "$Review\story-coverage-draft.json" `
  "$Review\story-coverage-manifest.json" `
  --source-privacy "$Review\current-public-source-privacy.json" `
  --previous "$AcceptedCoverage"
```

Never invent coverage revisions or digests in model output.

## Composed Activation Transport

The exact executable sequence is: finalize current Coverage -> prepare/record Story -> compose base Story -> prepare/record
Insight -> compose final Story -> prepare/record Story Privacy and Preference -> preparation
finalizer -> launcher ready with four files. The recorder, not the finalizer or caller, creates each
terminal worker receipt. The existing Preference producer remains the sole nine-field bundle
authority, and the Preference recorder binds that exact bundle unchanged.

Story preparation takes the exact canonical reviewed run, current public Source Privacy projection,
current semantic authority, and finalized current Coverage authority together. Its immutable input
binds one minimal validation-authority bundle and the exact bound raw reviewed narrative; it excludes
raw actor identity, Source Privacy rows, redaction details, and provider metadata. Only that explicitly
provider-bound input carries source narrative; validation authority does not. Story
workers do not need to open the parent-only validation authority or any other generated file. Both the
Story recorder and preparation finalizer directly reuse the unchanged Viewer
`validateStorySourcePackage`, so complete People, Evidence, Phase, Coverage, and Insight-grounding
validation occurs before any Story worker receipt or terminal preparation authority can exist.

Later E2E evidence, not static tests, proves actual host-subagent spawning.

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

Chapter Privacy/Release Preview is implemented in the canonical Viewer as one choice authority per target. It shows the local original beside the Agent-authored meaning-preserving proposal. The contributor accepts that proposal, edits anonymized text, or explicitly makes an exact noncredential occurrence public for the current target digest. A missing, stale, invalid, or incomplete target choice blocks the whole release. Originals, review metadata, evidence IDs, anchors, and Story review ledgers never enter `oxygen.reviewed-story`, `oxygen-reviewed-story.html`, or `oxygen-contribution.zip`.

### Refresh reviewed Story Privacy

After any reviewed Story edit, treat `preparation_required` as a resumable authority refresh and
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
