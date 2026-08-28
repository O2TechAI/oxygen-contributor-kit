# Story preparation transport

This is the sole unversioned public transport from the current Privacy-reviewed Organization
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
normalizes Coverage with the existing Coverage validator, applies only current final active
redactions, and writes `story/validation-authority.json` once. That minimal bundle contains the
semantic and Coverage authorities plus evidence identity, event/actor type, and opaque
actor-equivalence tokens. It contains no source text, raw actor ID, redaction row, provider
metadata, or private value. The worker input binds its digest and carries the corresponding
Privacy-reviewed narrative once; it never carries pre-redaction text.

Each lane is prepared once under one transport root. Finalized Coverage `ownerId` is the sole Story
Chapter-ownership source. Preparation groups every represented unit for one owner into one
indivisible bundle, byte-balances whole bundles, and installs deterministic bounded immutable
worker inputs plus `shards.json` before a proposal exists. One owner never spans Story shards; a
Story shard may contain multiple complete owners. No fixed Chapter, Phase, owner, unit, or shard
count controls this partitioning.
Every shard binds the lane, deterministic shard ID, upstream input digest, exact assigned
identities, per-input digest, and lane payload. Full reviewed narrative and the central validation
authority are not copied into every non-Story shard. Each Story input is self-contained: it carries
complete represented semantic units, their Privacy-reviewed narrative, canonical semantic/Coverage
references, and equality-only actor tokens for its owners. It carries no excluded narrative, raw
actor identity, Source Privacy row, pre-redaction content, private sentinel, or provider metadata.
A worker reads exactly one Privacy-safe `inputPath` and
writes only its proposal; it never writes a digest, receipt, final manifest, SQLite, Viewer API,
revision, activation state, release state, or publication state.

Every `story`-lane subagent assignment must convey this ordered contract before dispatch:

1. Read `skills/oxygen-storytelling-review/references/narrative-writing-contract.md` completely.
2. Read `skills/oxygen-storytelling-review/references/story-data-contract.md` completely.
3. Then read exactly the assignment's one generated Privacy-safe `inputPath`.
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
Internal host subagents are not product provider/API calls, require no separate API key, and
receive no raw/private source beyond their prepared input. If the host genuinely lacks that
capability, the parent processes the identical assignments serially, reports
`executionMode=serial_capability_limited`, and continues through the same recorder/finalizer
authority without asking the contributor to create workers.

On a subagent-capable host the parent does not author Story prose, People, primary or supporting
Evidence choices, titles, overviews, or blocks. It assigns only Phase IDs and labels after every
complete Chapter proposal exists. Static tests validate this contract and the batch authority;
later E2E evidence is required to prove actual host-subagent spawning.

Story workers return phase-free, non-authoritative Chapter proposals. The parent collects one
proposal file for every current Story shard, orders complete Chapters with the production
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
and the last safe validation code, and do not continue downstream. Authority, immutability,
containment, path, I/O, infrastructure, and corrupt-state failures stop immediately and are never
correctable. For Story these corrections are at most two lane-wide waves: replacing a rejected
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

Each Insight worker reads its manifest `inputPath` and returns exactly one record for every
assigned Story key, including an empty array when no Insight is warranted:

```json
[{"storyKey":"story-key","insights":[]}]
```

Each nonempty `insights` array must make the frozen base Story satisfy the Story data contract.
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
`validateStorySourcePackage` again on the composed package, binds the unchanged
Preference bundle, and emits the existing `oxygen.story-preparation` manifest.

## Public PowerShell sequence

Set paths once:

```powershell
$Transport = "$Review\story-preparation"
$StoryProposals = "$Review\story-proposals"
$StoryPhases = "$Review\story-phases.json"
```

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
# Parent collects one phase-free <shard-id>.json proposal per manifest shard, orders the complete
# Chapter set with the production comparator, and writes one transient Phase assignment.
node .\skills\oxygen-storytelling-review\scripts\record_story_preparation.mjs `
  "$Transport" story "$StoryProposals" "$StoryPhases" `
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
  --source-revision 0 `
  --output "$Review\preference-bundle.json"
node .\skills\oxygen-storytelling-review\scripts\record_story_preparation.mjs `
  "$Transport" preference "<manifest-shard-id>" "$Review\preference-bundle.json"
```

Use the actual current Viewer source revision in place of `0`, then finalize:

```powershell
node .\skills\oxygen-storytelling-review\scripts\finalize_story_preparation.mjs `
  "$Review\project-map.json" `
  "$Review\story-candidates.json" `
  "$Transport" `
  "$Review\preference-bundle.json" `
  "$Review\story-preparation-manifest.json" `
  --workflow-run-id "$WorkflowRun" `
  --source-revision 0
```

Only after this succeeds may the existing launcher receive coverage, Story candidates, the exact
Preference bundle, and the preparation manifest at `--story-event ready`.

Later E2E evidence reports `executionMode`, `lane`, `shardCount`, `spawnedSubagentCount`,
`maxConcurrentSubagents`, `correctionAttemptCount`, and `terminalReceiptCount` from the observed
parent lifecycle. `correctionAttemptCount` is evaluated per assignment, is always `0..2`, and is
never a lane-wide sum.
