# Story preparation transport

This is the sole unversioned public transport from the current Source-Privacy-bound Organization
semantic authority to `story-candidates.json` and `oxygen.story-preparation`. It is deterministic
and provider-free. The workflow-owning parent automatically assigns generated inputs to bounded
host subagents and records their proposals; the
transport never calls a provider, network service, Viewer API, SQLite database, or release path.

## Authority and storage

`prepare_story_preparation.mjs` accepts either the canonical Organization `project-map.json` or
its bare `semantic_manifest` for the Story lane. Both inputs use the same parser. Story preparation
also requires the finalized current Coverage manifest, the current public Source Privacy projection,
and the exact canonical reviewed run directory whose `project-map.json` carries the same semantic
authority. The outer project
map has the finite Coverage transport envelope, while the extracted semantic manifest retains its
unchanged byte limit, canonical digest, and exact unit membership.

The preparer verifies the Source Privacy digest against the exact current reviewed source rows,
normalizes Coverage with the existing Coverage validator, preserves the exact bound raw reviewed
narrative for the selected-provider Story input, and writes `story/validation-authority.json` once.
That minimal bundle contains the
semantic and Coverage authorities plus evidence identity, event/actor type, and opaque
actor-equivalence tokens. It contains no source text, raw actor ID, redaction row, provider
metadata, private value, or source narrative. The worker input binds its digest and is the only
artifact here that carries the corresponding exact bound raw reviewed narrative.

Each lane is prepared once under one transport root. Before Coverage finalization, the parent
establishes the global Chapter-owner skeleton by coherent narrative arc across the complete
bound reviewed semantic projection. It does not default or mechanically copy `ownerId` from `unitId`,
derive Chapter count from semantic-unit/source/meeting/prior-run count, or derive Phase count from
Chapter count or semantic kind. Related units may share one owner, one Chapter may represent
multiple units, and multiple Chapters may share one Phase. Finalized Coverage `ownerId` is then the
sole Story Chapter-ownership source. Preparation groups every represented unit for one owner into one
indivisible bundle, byte-balances whole bundles, and installs deterministic bounded immutable
worker inputs plus `shards.json` before a proposal exists. One owner never spans Story shards; a
Story shard may contain multiple complete owners. No fixed Chapter, Phase, owner, unit, or shard
count controls this partitioning.
Every shard binds the lane, deterministic shard ID, upstream input digest, exact assigned
identities, per-input digest, and lane payload. Full reviewed narrative and the central validation
authority are not copied into every non-Story shard. Each Story input is self-contained: it carries
complete represented semantic units, their exact bound raw reviewed narrative, canonical semantic/Coverage
references, and equality-only actor tokens for its owners. It carries no excluded narrative, raw
actor identity, Source Privacy row, source outside the exact reviewed boundary, or provider metadata.
A worker uses the contributor-selected current provider to read exactly one provider-bound `inputPath` and
writes only its proposal; it never writes a digest, receipt, final manifest, SQLite, Viewer API,
revision, activation state, release state, or publication state.

Every `story`-lane subagent assignment must convey this ordered contract before dispatch:

1. Read `skills/oxygen-storytelling-review/references/narrative-writing-contract.md` completely.
2. Read `skills/oxygen-storytelling-review/references/story-data-contract.md` completely.
3. Then read exactly the assignment's one generated provider-bound `inputPath`.
4. Write only that assignment's proposal.

The parent must not dispatch a Story worker unless the assignment names both required contract
paths, the one actual generated `inputPath` copied from the Story shard manifest, and the
proposal-only write boundary. The Story worker reads no other data input and never writes a
receipt, final artifact, or authority file.

Story, Insight, and Story Privacy remain multi-shard lanes: the parent dispatches every nonempty
shard automatically. Preference intentionally uses exactly one global bounded worker because it
produces one deduplicated questionnaire authority, capped at 12 probes by default and 20 maximum;
the parent must not fan Preference out. When host subagents are available, dispatches run in waves
of at most three live subagents. Silently doing all semantic reasoning in the parent is invalid.
Processing remains with the contributor-selected current provider, does not call a second endpoint,
requires no separate API key, and receives no source beyond the exact bound reviewed input. If the host genuinely lacks that
capability, the parent processes the identical assignments serially, reports
`executionMode=serial_capability_limited`, and continues through the same recorder/finalizer
authority without asking the contributor to create workers.

On a subagent-capable host the parent does not initially author Story prose, People, primary or
supporting Evidence choices, titles, overviews, or blocks. It reads each complete Chapter proposal
in full and writes only the transient digest-bound editorial acceptance described below. After the
initial proposal and two subagent corrections remain editorially unacceptable, the Ultra parent may
complete that same still-unrecorded assignment from the byte-identical input through the same
phase-free proposal shape, editorial gate, recorder, and validators. It assigns the smallest
coherent global Phase sequence only after every complete Chapter proposal passes. Static tests
validate this contract and the batch authority; later E2E evidence is required to prove actual
host-subagent spawning.

Story workers return phase-free, non-authoritative Chapter proposals. The parent collects one
proposal file for every current Story shard, reads every Chapter in full, and writes one transient
unversioned editorial review bound to each exact current proposal digest. The recorder rejects a
missing, stale, foreign, incomplete, or negative review before it reads Phase and before any output
or receipt exists. The parent then orders complete accepted Chapters with the production
timestamp -> documentId -> sequence -> row-id comparator, supplies one transient unversioned Phase
assignment for that exact ordered owner set, and invokes the Story recorder once. The recorder
injects schema, Chapter keys equal to Coverage owner IDs, Phase, semantic/Coverage references,
represented units, canonical exclusions, final row identity, and empty base-Story Insights. It then
calls the unchanged exported `validateStorySourcePackage` on the complete candidate package. Only
after complete validation succeeds does it stage every per-shard output and receipt and rename one
complete terminal `story/records` directory. Before success there are zero Story outputs and zero
Story receipts; after success there is exactly one receipt per expected Story shard. Other lanes
retain their per-shard atomic output/receipt recorder.

Each shard assignment gets one initial proposal plus at most two automatic proposal-only correction
attempts. `correctionAttemptCount` is assignment-local, counts corrections only, excludes the
initial proposal, and is always `0..2`; never sum it across a multi-shard lane. Every correction
uses the byte-identical immutable input. Every invalid initial or correction attempt leaves both
Story outputs and receipts absent. Only a fixed safe pre-receipt authoring-validation code is
correctable. If the second correction fails, stop the lane safely, report correction exhaustion
and the last safe validation code, and do not continue downstream, except for the narrow
Story-editorial parent takeover above. Authority, immutability, containment, path, I/O,
infrastructure, and corrupt-state failures stop immediately and are never correctable. For Story
these corrections are at most two lane-wide waves: replacing a rejected
proposal or replacing only the transient Phase assignment consumes the same wave, and failed waves
leave the complete Story records directory absent. This is not a contributor pause. Once the Story
records directory or another lane's authority directory exists, a differing
proposal is rejected; an incomplete or tampered pair is rejected and never repaired.

Errors are fixed codes only. They do not include Story text, reviewed content, URLs, local paths,
tracebacks, provider metadata, or arbitrary rejected input.

## Proposal shapes

Each Story worker reads its manifest `inputPath` and writes a JSON array with exactly one
phase-free proposal per assigned owner:

```json
[{"ownerId":"coverage-owner-id","chapter":{"title":"...","overview":"...","people":[],"story":{"blocks":[]},"insights":[],"evidence":{"primary":{"documentId":"...","eventId":"..."},"supporting":[]}}}]
```

Each row has exactly `ownerId` and `chapter`. `ownerId` is only the assigned selector. `chapter`
contains existing authorable Story content and empty `insights`; it must not contain schema, key,
Phase, Coverage, exclusions, receipt, or authority. Primary and supporting Evidence must belong to
the complete assigned owner bundle. The parent does not rewrite prose, People, Evidence, titles,
overviews, or blocks while assigning Phase.

After reading all complete proposals, the parent writes one transient editorial-review row per
owner. This is pre-receipt validation input and is never copied into Story output, receipts,
authority, Viewer state, release HTML, or ZIP:

```json
[{"ownerId":"coverage-owner-id","inputDigest":"current-story-lane-input-digest","proposalDigest":"sha256-of-canonical-proposal","criteria":{"beginningIsUnderstandable":true,"participantsAreIdentifiable":true,"chronologyIsTraceable":true,"responsesAndChangesAreExplained":true,"arcIsCoherent":true,"endingIsClear":true,"interactionsAreEvidenceSupported":true,"proseIsReadable":true}}]
```

`inputDigest` is the current immutable Story lane input digest from `story/shards.json`; it prevents
a review from being replayed across a fresh source or Story input boundary. `proposalDigest` is the
recorder's canonical SHA-256 digest of the exact `{ "ownerId", "chapter" }` proposal row. All eight
fields are required booleans and must be `true`. The parent reaches those
decisions by reading the prose and Evidence, not through a word/paragraph count, prose score,
keyword detector, domain enum, or mandatory template. A negative decision triggers a specific
proposal-only correction naming the missing narrative relationship; the corrected proposal is
re-read and receives a new digest-bound review against the byte-identical worker input.

Each Insight worker reads its manifest `inputPath` and returns exactly one record for every
assigned Story key, including an empty array when no Insight is warranted:

```json
[{"storyKey":"story-key","insights":[]}]
```

Each nonempty `insights` array must make the frozen base Story satisfy the Story data contract.
The immutable input contains only assigned Story candidates, their Story blocks and Evidence
references, the minimum exact bound `reviewedNarrative` rows referenced by those blocks, and the existing
validation-authority reference. It contains no source outside the reviewed boundary, Source Privacy rows,
unrelated Chapters or trajectory narrative, private actor identity, or provider metadata. Every
nonempty proposal uses `anchorStoryBlockId` only for placement and `quote: { text, evidence }` for
one exact current bound reviewed trajectory substring. Quote Evidence must support the anchored
block. Top-level `evidence` may be empty and is retained only for broader same-Chapter grounding.
Replacing a rejected proposal against byte-identical immutable input is allowed before receipt;
invalid proposals create neither output nor receipt.
Final composition injects those arrays into the recorded base Stories and writes the canonical
two-field `story-candidates.json`; the caller never duplicates full Story JSON to add Insights.

Each Story Privacy worker reads its manifest `inputPath` and returns an array
of candidates with exactly `id`, `reviewState`, `title`, `whyFlagged`, `uncertaintyReason`, and
`releaseTargets`. Targets must belong to the generated release-target catalog. An empty array is an
explicit completed-zero result.

The one global Preference worker reads its one manifest `inputPath` and writes only the candidate
shape owned by the Preference Skill. It produces one deduplicated questionnaire authority and is
capped at 12 probes by default and 20 maximum; Preference never fans out. The existing
`prepare_preference_context.py` and
`validate_probes.py` commands remain the sole context and nine-field bundle authority. The recorder
accepts that exact final bundle as its proposal and binds it unchanged. An empty generated question
batch is an explicit completed-zero result.

Identity sets, exclusions, and non-Story lane arrays use stable UTF-8 identity ordering; Story
Chapters use the production comparator. The finalizer independently
reopens the frozen inputs, receipts, and outputs through physical containment, checks every content
digest and exact identity union, reconstructs the final Story/Insight result, calls the same
`validateStorySourcePackage` again on the composed package using the reopened immutable minimum
exact bound reviewed narrative rows, binds the unchanged
Preference bundle, and emits the existing `oxygen.story-preparation` manifest.

## Public PowerShell sequence

Set paths once:

```powershell
$Organization = $null
try {
  $Organization = Invoke-RestMethod -Method Get -Uri "$Viewer/api/organization"
  if ($Organization.status -cne "complete" -or $null -eq $Organization.semanticManifest) {
    throw "current Organization authority is unavailable"
  }
  $SourceRevision = $Organization.semanticManifest.sourceRevision
  if ($SourceRevision -isnot [ValueType] -or $SourceRevision -is [bool]) {
    throw "current Organization source revision is invalid"
  }
  $SourceRevisionDecimal = [decimal]$SourceRevision
  if ($SourceRevisionDecimal -ne [decimal]::Truncate($SourceRevisionDecimal) -or
      $SourceRevisionDecimal -lt 1 -or
      $SourceRevisionDecimal -gt 9007199254740991) {
    throw "current Organization source revision is invalid"
  }
}
catch {
  [Console]::Error.WriteLine("CURRENT_SOURCE_REVISION_UNAVAILABLE")
  return
}

$Transport = "$Review\story-preparation"
$StoryProposals = "$Review\story-proposals"
$StoryEditorialReview = "$Review\story-editorial-review.json"
$StoryPhases = "$Review\story-phases.json"
```

This is the only source-revision lookup. The current Organization projection exposes the field only
while semantic, source, finalized-corpus, and current document/item authority remain consistent.
Do not read source revision from `/api/workflow`, semantic manifest `revision`, project-map
revision, an old run, saved state, SQLite, a default, a sentinel, literal zero, or inferred counts.
The bound `$SourceRevision` is reused unchanged for Preference validation and final preparation.
If the projection or positive JavaScript-safe revision is unavailable, the fixed category above
stops the parent before any worker output or receipt exists.

After each Story, Insight, or Story Privacy `prepare` command, the parent reads that lane's
`shards.json`, dispatches all nonempty shards in waves of at most three, and waits. For Story it
collects every `<shard-id>.json` proposal in `$StoryProposals`, creates one transient unversioned
parent Phase assignment, and invokes the shown batch recorder once. For Insight and Story Privacy
it runs the shown recorder once per shard using the actual `<manifest-shard-id>` and
`<proposal-path>`. After the
Preference `prepare` command, the parent requires exactly one global shard and dispatches exactly
one bounded worker. For any assignment, only a fixed safe pre-receipt authoring-validation code may
trigger at most two automatic proposal-only corrections against the byte-identical input. The
parent requires one terminal receipt per assignment before compose/finalize and continues without
a contributor pause only when the lane has no exhaustion or immediate-stop failure.

For each Story shard, the dispatch message itself must include the four ordered assignment steps
above with the generated shard's literal `inputPath` and assigned proposal destination. A reference
to this document alone does not convey the writing contracts to the Story worker.

Prepare, record, and compose the base Story:

```powershell
node .\skills\oxygen-storytelling-review\scripts\prepare_story_preparation.mjs `
  prepare story "$Review\project-map.json" `
  "$Review\story-coverage-manifest.json" `
  "$Review\current-public-source-privacy.json" `
  "$Review" "$Transport"
# Parent collects one phase-free <shard-id>.json proposal per manifest shard, reads every Chapter,
# writes the digest-bound editorial review, then orders the accepted Chapter set with the production
# comparator and writes one transient smallest coherent global Phase assignment.
node .\skills\oxygen-storytelling-review\scripts\record_story_preparation.mjs `
  "$Transport" story "$StoryProposals" "$StoryEditorialReview" "$StoryPhases" `
  --correction-attempt-count 0
node .\skills\oxygen-storytelling-review\scripts\prepare_story_preparation.mjs `
  compose story "$Transport" "$Review\story-base-candidates.json"
```

Prepare, record, and compose the dependent Insight pass:

```powershell
node .\skills\oxygen-storytelling-review\scripts\prepare_story_preparation.mjs `
  prepare insight "$Review\story-base-candidates.json" "$Transport"
# Parent records every completed Insight shard proposal.
node .\skills\oxygen-storytelling-review\scripts\record_story_preparation.mjs `
  "$Transport" insight "<manifest-shard-id>" "<proposal-path>"
node .\skills\oxygen-storytelling-review\scripts\prepare_story_preparation.mjs `
  compose final "$Transport" "$Review\story-candidates.json"
```

Prepare the two sibling passes from the composed final Story. They may run in either order, but
neither may run before final Story composition:

```powershell
node .\skills\oxygen-storytelling-review\scripts\prepare_story_preparation.mjs `
  prepare story_privacy "$Review\story-candidates.json" "$Transport"
# Parent records every completed Story Privacy shard proposal.
node .\skills\oxygen-storytelling-review\scripts\record_story_preparation.mjs `
  "$Transport" story_privacy "<manifest-shard-id>" "<proposal-path>"

python .\skills\oxygen-elicit-contributor-preferences\scripts\prepare_preference_context.py `
  --story-candidates "$Review\story-candidates.json" `
  --redacted "$Redaction\redacted" `
  --privacy-report "$Redaction\report.json" `
  --output "$Review\preference-context.json"
node .\skills\oxygen-storytelling-review\scripts\prepare_story_preparation.mjs `
  prepare preference "$Review\story-candidates.json" `
  "$Review\preference-context.json" "$Transport"
# Parent assigns the one global Preference input to one worker and validates its proposal.
python .\skills\oxygen-elicit-contributor-preferences\scripts\validate_probes.py `
  --context "$Review\preference-context.json" `
  --candidates "<proposal-path>" `
  --workflow-run-id "$WorkflowRun" `
  --source-revision $SourceRevision `
  --output "$Review\preference-bundle.json"
node .\skills\oxygen-storytelling-review\scripts\record_story_preparation.mjs `
  "$Transport" preference "<manifest-shard-id>" "$Review\preference-bundle.json"
```

Finalize with that same bound current Viewer source revision:

```powershell
node .\skills\oxygen-storytelling-review\scripts\finalize_story_preparation.mjs `
  "$Review\project-map.json" `
  "$Review\story-candidates.json" `
  "$Transport" `
  "$Review\preference-bundle.json" `
  "$Review\story-preparation-manifest.json" `
  --workflow-run-id "$WorkflowRun" `
  --source-revision $SourceRevision
```

Only after this succeeds may the existing launcher receive coverage, Story candidates, the exact
Preference bundle, and the preparation manifest at `--story-event ready`.

Later E2E evidence reports `executionMode`, `lane`, `shardCount`, `spawnedSubagentCount`,
`maxConcurrentSubagents`, `correctionAttemptCount`, and `terminalReceiptCount` from the observed
parent lifecycle. `correctionAttemptCount` is evaluated per assignment, is always `0..2`, and is
never a lane-wide sum.
