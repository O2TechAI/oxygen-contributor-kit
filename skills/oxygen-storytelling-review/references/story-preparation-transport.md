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

Each lane is prepared once under one transport root. Preparation installs deterministic
byte/content-balanced bounded immutable worker inputs plus `shards.json` before a proposal exists.
Every shard binds the lane, deterministic shard ID, upstream input digest, exact assigned
identities, per-input digest, and lane payload. Full reviewed narrative and the central validation
authority are not copied into every shard. A worker reads exactly one Privacy-safe `inputPath` and
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

When host subagents are available, the parent dispatches every nonempty shard automatically in
waves of at most three live subagents. Silently doing all semantic reasoning in the parent is
invalid. Internal host subagents are not product provider/API calls, require no separate API key,
and receive no raw/private source beyond their prepared input. If the host genuinely lacks that
capability, the parent processes the identical inputs serially, reports
`executionMode=serial_capability_limited`, and continues through the same recorder/finalizer
authority without asking the contributor to create workers.

The recorder accepts only the generated shard ID and a lane-shaped proposal. Before a Story pair
can exist, it calls the unchanged exported `validateStorySourcePackage` with the exact bound
validation authority. Complete People, Evidence, Phase, Coverage, and Insight-grounding failures
therefore remain pre-receipt authoring failures. On success it writes
`output.json` and `receipt.json` into a temporary authority directory, syncs both files, and installs
the directory with one rename. Therefore neither file is authoritative alone. Invalid proposals
leave both absent. The parent returns only the fixed safe code through a bounded automatic
proposal-only correction loop against the byte-identical input; this is not a contributor pause.
Once the authority directory exists, a differing proposal is rejected; an incomplete or tampered
pair is rejected and never repaired.

Errors are fixed codes only. They do not include Story text, reviewed content, URLs, local paths,
tracebacks, provider metadata, or arbitrary rejected input.

## Proposal shapes

Each Story worker reads its manifest `inputPath` and writes a JSON array of base Story rows for
exactly that shard's assigned semantic scope:

```json
[{"id":"existing-reviewed-item-id","story":{"schema":"oxygen.story","insights":[]}}]
```

Each row has exactly `id` and `story`. `id` must be an assigned semantic member. `story` must satisfy
the Story data contract and have an empty `insights` array. The recorder sorts rows by UTF-8 `id`,
rejects foreign or duplicate row IDs and Story keys, and installs the normalized output.

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

The Preference worker reads its manifest `inputPath` and writes only the candidate
shape owned by the Preference Skill. The existing `prepare_preference_context.py` and
`validate_probes.py` commands remain the sole context and nine-field bundle authority. The recorder
accepts that exact final bundle as its proposal and binds it unchanged. An empty generated question
batch is an explicit completed-zero result.

All arrays are canonicalized with stable UTF-8 identity ordering. The finalizer independently
reopens the frozen inputs, receipts, and outputs through physical containment, checks every content
digest and exact identity union, reconstructs the final Story/Insight result, calls the same
`validateStorySourcePackage` again on the composed package, binds the unchanged
Preference bundle, and emits the existing `oxygen.story-preparation` manifest.

## Public PowerShell sequence

Set paths once:

```powershell
$Transport = "$Review\story-preparation"
```

After every `prepare` command, the parent reads that lane's `shards.json`, dispatches all shards in
waves of at most three, waits, and runs the shown recorder once per shard using the actual
`<manifest-shard-id>` and `<proposal-path>`. A fixed safe pre-receipt failure is automatically
returned to the same assignment for bounded proposal-only correction against the unchanged input.
The parent requires one terminal receipt per shard before compose/finalize and continues without a
contributor pause.

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
# Parent records every completed Story shard proposal.
node .\skills\oxygen-storytelling-review\scripts\record_story_preparation.mjs `
  "$Transport" story "<manifest-shard-id>" "<proposal-path>"
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
# Parent assigns the prepared Preference input and validates its proposal.
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
parent lifecycle.
