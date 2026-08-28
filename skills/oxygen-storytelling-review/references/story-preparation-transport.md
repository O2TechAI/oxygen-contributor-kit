# Story preparation transport

This is the sole unversioned public transport from the current Privacy-reviewed Organization
semantic authority to `story-candidates.json` and `oxygen.story-preparation`. It is deterministic
and provider-free. External bounded workers read generated inputs and write lane proposals; the
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

Each lane is prepared once under one transport root. Preparation installs one bounded immutable
worker input plus `shards.json` before a proposal exists. Its generated input binds the lane,
shard, upstream input digest, exact assigned identities, and lane payload. A worker never writes a
digest or receipt.

The recorder accepts only the generated shard ID and a lane-shaped proposal. Before a Story pair
can exist, it calls the unchanged exported `validateStorySourcePackage` with the exact bound
validation authority. Complete People, Evidence, Phase, Coverage, and Insight-grounding failures
therefore remain pre-receipt authoring failures. On success it writes
`output.json` and `receipt.json` into a temporary authority directory, syncs both files, and installs
the directory with one rename. Therefore neither file is authoritative alone. Invalid proposals
leave both absent and may be corrected. Once the authority directory exists, a differing proposal
is rejected; an incomplete or tampered pair is rejected and never repaired.

Errors are fixed codes only. They do not include Story text, reviewed content, URLs, local paths,
tracebacks, provider metadata, or arbitrary rejected input.

## Proposal shapes

The Story worker reads `story/inputs/story-0001.json` and writes a JSON array of base Story rows:

```json
[{"id":"existing-reviewed-item-id","story":{"schema":"oxygen.story","insights":[]}}]
```

Each row has exactly `id` and `story`. `id` must be an assigned semantic member. `story` must satisfy
the Story data contract and have an empty `insights` array. The recorder sorts rows by UTF-8 `id`,
rejects foreign or duplicate row IDs and Story keys, and installs the normalized output.

The Insight worker reads `insight/inputs/insight-0001.json` and returns exactly one record for every
assigned Story key, including an empty array when no Insight is warranted:

```json
[{"storyKey":"story-key","insights":[]}]
```

Each nonempty `insights` array must make the frozen base Story satisfy the Story data contract.
Final composition injects those arrays into the recorded base Stories and writes the canonical
two-field `story-candidates.json`; the caller never duplicates full Story JSON to add Insights.

The Story Privacy worker reads `story-privacy/inputs/story-privacy-0001.json` and returns an array
of candidates with exactly `id`, `reviewState`, `title`, `whyFlagged`, `uncertaintyReason`, and
`releaseTargets`. Targets must belong to the generated release-target catalog. An empty array is an
explicit completed-zero result.

The Preference worker reads `preference/inputs/preference-0001.json` and writes only the candidate
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
$StoryProposal = "$Review\story-proposal.json"
$InsightProposal = "$Review\insight-proposal.json"
$PrivacyProposal = "$Review\story-privacy-proposal.json"
$PreferenceCandidates = "$Review\preference-candidates.json"
```

Prepare, record, and compose the base Story:

```powershell
node .\skills\oxygen-storytelling-review\scripts\prepare_story_preparation.mjs `
  prepare story "$Review\project-map.json" `
  "$Review\story-coverage-manifest.json" `
  "$Review\current-public-source-privacy.json" `
  "$Review" "$Transport"
# The bounded Story worker reads story/inputs/story-0001.json and writes $StoryProposal.
node .\skills\oxygen-storytelling-review\scripts\record_story_preparation.mjs `
  "$Transport" story story-0001 "$StoryProposal"
node .\skills\oxygen-storytelling-review\scripts\prepare_story_preparation.mjs `
  compose story "$Transport" "$Review\story-base-candidates.json"
```

Prepare, record, and compose the dependent Insight pass:

```powershell
node .\skills\oxygen-storytelling-review\scripts\prepare_story_preparation.mjs `
  prepare insight "$Review\story-base-candidates.json" "$Transport"
# The bounded Insight worker reads insight/inputs/insight-0001.json and writes $InsightProposal.
node .\skills\oxygen-storytelling-review\scripts\record_story_preparation.mjs `
  "$Transport" insight insight-0001 "$InsightProposal"
node .\skills\oxygen-storytelling-review\scripts\prepare_story_preparation.mjs `
  compose final "$Transport" "$Review\story-candidates.json"
```

Prepare the two sibling passes from the composed final Story. They may run in either order, but
neither may run before final Story composition:

```powershell
node .\skills\oxygen-storytelling-review\scripts\prepare_story_preparation.mjs `
  prepare story_privacy "$Review\story-candidates.json" "$Transport"
# The bounded Privacy worker reads story-privacy/inputs/story-privacy-0001.json and writes $PrivacyProposal.
node .\skills\oxygen-storytelling-review\scripts\record_story_preparation.mjs `
  "$Transport" story_privacy story-privacy-0001 "$PrivacyProposal"

python .\skills\oxygen-elicit-contributor-preferences\scripts\prepare_preference_context.py `
  --story-candidates "$Review\story-candidates.json" `
  --redacted "$Redaction\redacted" `
  --privacy-report "$Redaction\report.json" `
  --output "$Review\preference-context.json"
node .\skills\oxygen-storytelling-review\scripts\prepare_story_preparation.mjs `
  prepare preference "$Review\story-candidates.json" `
  "$Review\preference-context.json" "$Transport"
# The bounded Preference worker reads preference/inputs/preference-0001.json and writes $PreferenceCandidates.
python .\skills\oxygen-elicit-contributor-preferences\scripts\validate_probes.py `
  --context "$Review\preference-context.json" `
  --candidates "$PreferenceCandidates" `
  --workflow-run-id "$WorkflowRun" `
  --source-revision 0 `
  --output "$Review\preference-bundle.json"
node .\skills\oxygen-storytelling-review\scripts\record_story_preparation.mjs `
  "$Transport" preference preference-0001 "$Review\preference-bundle.json"
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
