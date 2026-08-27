# Validation Checklist

Use this checklist before final handoff. A green unit test is not enough when human review, release safety, or browser behavior changed.

## Data And Workflow

- [ ] Active Story candidates use `oxygen.story:` and `schema: "oxygen.story"`.
- [ ] Workflow progress reaches Review Story only through activation with `storySourceSchema: "oxygen.story"` and `storySessionSchema: "oxygen.story-review-session"`.
- [ ] Story generation order is complete reviewed history -> Chapter arcs -> complete Story -> validation -> adjacent Phase grouping -> independent Insight pass -> zero or more Insights.
- [ ] Every Chapter is one complete coherent arc with nonempty supported People and Story blocks.
- [ ] Phases group adjacent completed Chapters and use precise one- or two-word labels.
- [ ] Insights are `0..n`; every existing Insight has Background, Quote, Directly Acquired Experience, Principle, optional title, same-Chapter anchors, and Evidence support.
- [ ] Passage assistance, if any local UI later exposes it, is optional, human-facing, non-authoritative, non-readiness, and non-release.
- [ ] Reviewed archive/input integrity, member paths, manifest counts, source hash, and `publication_approved=false` are safe.
- [ ] Every primary/supporting/Person/Story-block/Insight Evidence reference is exact, fully qualified, same-document when required, and resolves once.
- [ ] Semantic coverage authority represents or explicitly excludes every unit exactly once.
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

- [ ] Release Preview shows only the release-safe projection for deterministic/confirmed safe content.
- [ ] `needs_confirmation` source Privacy items show only the minimum permitted local original, current safe projection, safe uncertainty reason, and Keep/Redact.
- [ ] Unavailable originals are never reconstructed.
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
- [ ] Story Edit Mode screenshot with notes and Undo/Redo.
- [ ] Privacy available and unavailable screenshots when candidate authority exists.
- [ ] Preferences screenshot with unanswered and answered states.
- [ ] Release Preview screenshot.
- [ ] Reviewed HTML and ZIP safe-content equivalence evidence.
- [ ] Console errors checked.
- [ ] Keyboard focus and Back navigation checked.

## Commands

Run the focused Story launcher test after fixture changes:

```bash
python skills/oxygen-organize-review-export/tests/test_run_local_review.py
```

Run Python compilation for changed Python:

```bash
python -m py_compile skills/oxygen-organize-review-export/tests/test_run_local_review.py
```

Run full deterministic gates for a release-ready documentation or Story behavior change:

```bash
cd viewer
npm test
npm run lint
npx tsc --noEmit --strict
npm run build
```

Run residual scans over changed docs and tests for old Story product contracts, old Story identifiers, and retired lane labels supplied by the task:

```bash
rg -n "<retired-story-pattern>" skills/oxygen-storytelling-review SOP.md \
  skills/oxygen-organize-review-export/tests/test_run_local_review.py
```

Run diff and whitespace checks:

```bash
git diff --check 356b6760ab45cd9fcbc011c1d92e646b82011015..HEAD
git diff --name-only 356b6760ab45cd9fcbc011c1d92e646b82011015..HEAD
```

## Forbidden Completion Shortcuts

- [ ] No code edits during clean-room execution.
- [ ] No production edits.
- [ ] No Viewer test edits.
- [ ] No JSON surgery.
- [ ] No database repair.
- [ ] No hidden prompts.
- [ ] No Master rescue or maintainer rescue path.
- [ ] No provider calls during deterministic validation.
- [ ] No push, merge, PR, publication, or canonical checkout edit.
