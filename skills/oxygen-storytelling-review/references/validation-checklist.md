# Validation Checklist

Use this checklist before final handoff. A green unit test is not enough when human review, release safety, or browser behavior changed.

## Data And Workflow

- [ ] Active Story candidates use `oxygen.story:` and `schema: "oxygen.story"`.
- [ ] Workflow progress reaches Review Story only through activation with `storySourceSchema: "oxygen.story"` and `storySessionSchema: "oxygen.story-review-session"`.
- [ ] Public workflow order is Collect -> Organize -> upstream source Privacy preparation -> build Project Story using bounded semantic workers -> independent global sparse Insight pass -> Story/Release Privacy candidate preparation -> Preference-question generation -> Project Story human review -> Privacy Keep/Redact decisions -> Preference answers -> All set -> local reviewed release.
- [ ] Review Story opens only after terminal results for Story generation, global Insight pass, Story/Release Privacy candidate preparation, and Preference-question generation; completed-zero is explicit where valid.
- [ ] Launcher ready requires coverage, Story candidates, deterministic Preference bundle, and `oxygen.story-preparation` manifest; missing or extra authority fails before HTTP.
- [ ] Preference bundle import to `/api/probes` precedes the exact `/api/workflow` Review Story activation; completed-zero is valid and failed import prevents activation.
- [ ] Story generation order inside the Story lane is complete reviewed history -> Chapter arcs -> complete Story -> validation -> adjacent Phase grouping -> independent Insight pass -> zero or more Insights.
- [ ] Every Chapter is one complete coherent arc with nonempty supported People and Story blocks.
- [ ] Phases group adjacent completed Chapters and use precise one- or two-word labels.
- [ ] Insights are `0..n`; every existing Insight has Background, Quote, Directly Acquired Experience, Principle, optional title, same-Chapter anchors, and Evidence support.
- [ ] Passage assistance, if any local UI later exposes it, is optional, human-facing, non-authoritative, non-readiness, and non-release.
- [ ] Reviewed archive/input integrity, member paths, manifest counts, source hash, and `publication_approved=false` are safe.
- [ ] Every primary/supporting/Person/Story-block/Insight Evidence reference is exact, fully qualified, same-document when required, and resolves once.
- [ ] Public Story preparation accepts canonical project-map and bare semantic-manifest authority through one parser and produces byte-identical worker authority.
- [ ] Finalized Coverage owner IDs produce complete owner-atomic Story bundles; no owner spans shards, and a shard may contain multiple owners.
- [ ] Every Story proposal and one complete parent Phase assignment validate before the atomic Story records directory and exactly one receipt per shard exist.
- [ ] Story worker inputs are self-contained and contain no excluded narrative, raw actor identity, Source Privacy rows, pre-redaction content, or provider metadata.
- [ ] Static tests do not claim actual host-subagent spawning; retain that proof for later E2E evidence.
- [ ] Every bounded lane starts from a generated immutable input, and only the recorder creates the atomic output/receipt pair.
- [ ] The recorder rejects invalid pre-receipt proposals without either authority file, permits correction only while both are absent, rejects differing post-receipt proposals, and never repairs a partial pair.
- [ ] Preparation/finalization proves exact identity union, no overlap, no foreign identity, no missing shard, current input digest, physical containment, deterministic order, and explicit completed-zero output.
- [ ] Final `story-candidates.json` is composed from recorded Story and Insight results; it is not duplicated manually by the caller.
- [ ] The Preference recorder binds the exact nine-field output from the existing Preference producer.
- [ ] Semantic coverage authority represents or explicitly excludes every unit exactly once.
- [ ] Coverage draft rows are exactly `{unitId, disposition, ownerId}` or `{unitId, disposition, exclusionReason}`.
- [ ] No Story JSON contains raw member lists, per-event negative ledgers, Privacy candidates, source originals, prompts, hidden reasoning, or Preference answers.
- [ ] Story/Release Privacy candidates are not claimed unless an implemented authority provides them outside `oxygen.story`.
- [ ] Preferences are generated from reusable lessons/Insights, may be prepared before human review opens, remain unanswered until explicit contributor action, and are not stored in the Story review session.

## Human Pauses

- [ ] Unresolved Privacy Keep/Redact decisions pause the Agent.
- [ ] Preference answers pause for contributor action.
- [ ] Story review pauses when Review Story opens.
- [ ] All set is an explicit contributor action.
- [ ] Release handoff is an explicit contributor action.
- [ ] No human decision is fabricated from silence, test output, screenshots, or model confidence.

## Release Preview And Package

- [ ] Final decision-only Chapter Privacy/Release Preview is marked NOT YET IMPLEMENTED on this base, and clean-room product completion is blocked until it exists.
- [ ] Required Release Preview shows only the release-safe projection for deterministic/confirmed safe content.
- [ ] `needs_confirmation` source Privacy items show only the minimum permitted local original, current safe projection, safe uncertainty reason, and Keep/Redact.
- [ ] Only `needs_confirmation` rows are decision-editable; category/status/reason mutation, deletion, and soft deletion are not final contributor actions.
- [ ] Unavailable originals are never reconstructed.
- [ ] Pending confirmation blocks Story/package release, and Raw Evidence or suppressed content is not exposed through Insight review.
- [ ] `oxygen.reviewed-story`, `oxygen-reviewed-story.html`, and `oxygen-contribution.zip` omit originals, Evidence IDs, anchors, coverage metadata, review ledgers, offsets, prompts, and private notes.
- [ ] HTML and ZIP contain materially equivalent safe Story content from the same server-owned serialized bytes.
- [ ] ZIP member scan rejects absolute paths, `..`, symlinks, credentials, local databases, logs, private review artifacts, caches, `node_modules`, and virtual environments.
- [ ] Package manifest keeps `publication_approved=false`.

## Clean-Room Gate

- [ ] Create a fresh clone or worktree from the exact candidate snapshot with no generated Story residue.
- [ ] Give a fresh contextless Agent only the normal public Oxygen workflow request.
- [ ] Do not name this Skill, provide hidden conversion steps, give expected UI counts, supply prior chat context, or copy generated project-local Story data.
- [ ] The fresh Agent reaches the same integrated Viewer capability through root routing.
- [ ] Record every intervention. Any Story-specific steering invalidates the run.
- [ ] After any material fix, repeat with a new exact snapshot and fresh Agent.

## Browser QA

- [ ] Desktop Project Story Timeline screenshot.
- [ ] Narrow Project Story Timeline screenshot.
- [ ] Desktop Chapter screenshot with rail, People, Story, and Review completion.
- [ ] Narrow Chapter screenshot with no horizontal overflow.
- [ ] Desktop Chapter screenshot showing right-side separate Insight companion cards aligned to Story paragraphs when Insights exist.
- [ ] Story Edit Mode screenshot with notes and Undo/Redo.
- [ ] Privacy screenshots only after candidate authority and the final surface exist.
- [ ] Preferences screenshot with unanswered and answered states.
- [ ] Final Release Preview screenshot after implementation.
- [ ] Reviewed HTML and ZIP safe-content equivalence evidence.
- [ ] Console errors checked.
- [ ] Keyboard focus and Back navigation checked.

## Commands

Run the focused launcher and document-contract tests:

```powershell
python .\skills\oxygen-organize-review-export\tests\test_run_local_review.py
Push-Location -LiteralPath ".\viewer"
node --test .\tests\workflow-contracts.test.mjs
Pop-Location
```

Run Python compilation for changed Python:

```powershell
python -m py_compile .\skills\oxygen-organize-review-export\tests\test_run_local_review.py
```

Run full deterministic gates for a release-ready documentation or Story behavior change:

```powershell
Push-Location -LiteralPath ".\viewer"
npm test
npm run lint
npx tsc --noEmit --strict
npm run build
Pop-Location
```

Run residual scans over public docs and tests for old Story product contracts, old Story identifiers, fake prior-coverage files, retired lane labels, placeholder scans, and hardcoded temporary diff bases:

```powershell
$Docs = @(
  "AGENTS.md",
  "SOP.md",
  "skills\oxygen-storytelling-review\SKILL.md",
  "skills\oxygen-storytelling-review\references",
  "skills\oxygen-elicit-contributor-preferences\SKILL.md",
  "skills\oxygen-elicit-contributor-preferences\references",
  "skills\oxygen-organize-review-export\tests\test_run_local_review.py",
  "viewer\tests\workflow-contracts.test.mjs"
)
$RetiredPatterns = @(
  "Stage 3: Check " + "privacy",
  "server-accepted-story-" + "coverage\.json",
  "oxygen\.story/(?:1|2|3)",
  "oxygen\.story-review-session/[0-9]",
  "oxygen\.reviewed-story/[0-9]",
  "git diff --check [0-9a-f]{40}\.\.HEAD"
)
$Pattern = $RetiredPatterns -join "|"
rg -n $Pattern @Docs
if ($LASTEXITCODE -eq 0) { throw "Residual retired Story contract text remains" }
if ($LASTEXITCODE -gt 1) { exit $LASTEXITCODE }
```

Validate Story Skill reference links:

```powershell
$StoryDocs = @("skills\oxygen-storytelling-review\SKILL.md") +
  (Get-ChildItem -LiteralPath "skills\oxygen-storytelling-review\references" -Filter "*.md").FullName
$Missing = foreach ($File in $StoryDocs) {
  $Base = Split-Path -LiteralPath $File
  Select-String -LiteralPath $File -Pattern "\[[^\]]+\]\((references/[^)#]+|[^/)#]+\.md)\)" -AllMatches |
    ForEach-Object {
      foreach ($Match in $_.Matches) {
        $Target = $Match.Groups[1].Value -replace "/", "\"
        if ($Target.StartsWith("references\")) {
          $Resolved = Join-Path -Path (Split-Path -LiteralPath "skills\oxygen-storytelling-review\SKILL.md") -ChildPath $Target
        } else {
          $Resolved = Join-Path -Path $Base -ChildPath $Target
        }
        if (-not (Test-Path -LiteralPath $Resolved)) { "$File -> $Target" }
      }
    }
}
if ($Missing) { $Missing; exit 1 }
```

Run revision-independent diff and whitespace checks:

```powershell
git diff --check
git diff --check --cached
git diff --name-only --diff-filter=ACMRTUXB
git status --short
```

## Forbidden Completion Shortcuts

- [ ] No code edits during clean-room execution.
- [ ] No production edits.
- [ ] No production Viewer edits.
- [ ] No JSON surgery.
- [ ] No database repair.
- [ ] No hidden prompts.
- [ ] No Master rescue or maintainer rescue path.
- [ ] No provider calls during deterministic validation.
- [ ] No push, merge, PR, publication, or canonical checkout edit.
