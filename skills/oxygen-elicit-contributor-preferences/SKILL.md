---
name: oxygen-elicit-contributor-preferences
description: Turn a privacy-prepared reviewed Oxygen run into a small set of answerable questions that recover the contributor's transferable preferences. Reuse validated privacy counts, reviewed exclusions, and reusable lessons represented by generated Insight candidates; find high-signal moments where preferences surfaced; reconstruct each situation; and offer evidence-grounded candidate answers plus an escape hatch. Generate questions after reusable lessons/Insight candidates exist and before Project Story human review opens. Answers remain explicit contributor actions during reviewed handoff.
---

# Elicit contributor preferences

The goal is a **cheap** annotation pass. A contributor will not read 400 events and write
freeform notes. They will answer roughly ten well-posed multiple-choice questions.

Everything here runs on the contributor's own machine. Internal host subagents are not product
provider/API calls and require no separate API key. Nothing is uploaded. `publication_approved`
stays `false`.

## Vocabulary warning

Two different things get called "sensitive" in this project. Keep them apart:

- **Unsafe content** — credentials, personal identifiers, third-party private data. Detection and
  removal belong to the earlier Privacy stage. This skill only reuses its validated aggregate.
- **High-signal moments** — turns where the contributor pushed back, corrected, argued, or
  reversed a decision. These are not risky; they are the **most valuable** turns, because that is
  where an unstated preference became visible. This skill hunts for these.

Never let one meaning leak into the other. Removing a high-signal moment because it "looked
sensitive" destroys the exact thing this workflow exists to capture.

## Input

Prepare a bounded privacy-prepared reviewed run context from the final ordered unversioned
`story-candidates.json`, the exact reviewed redaction bundles, and their completed merge report.
Do not reopen the raw organized run or independently apply or rerun redaction.
- do not independently apply or rerun redaction from any other source.

```powershell
python .\skills\oxygen-elicit-contributor-preferences\scripts\prepare_preference_context.py `
  --story-candidates "$Review\story-candidates.json" `
  --redacted "$Redaction\redacted" `
  --privacy-report "$Redaction\report.json" `
  --output "$Review\preference-context.json"
```

Preference intentionally uses exactly one global bounded worker because it produces one
deduplicated questionnaire authority. The workflow-owning parent assigns its one immutable
Preference `inputPath` to one bounded host subagent when that capability exists; Preference never
fans out across multiple shards or workers. The subagent reads only that one Privacy-safe context
and writes `preference-candidates.json` with exactly `probes`, `bulkDecisions`, and `setAside`,
capped at 12 probes by default and 20 maximum.
It never writes answers, receipts, final manifests, SQLite, Viewer APIs, Privacy aggregates,
digests, provider metadata, revisions, activation state, release state, or publication state. The
parent runs validation and recording, owns the immutable output/receipt pair, and continues without
asking the contributor to create a worker. If subagents are unavailable, the parent uses the same
input and authority serially with `executionMode=serial_capability_limited`.

The global Preference assignment gets one initial proposal plus at most two automatic
proposal-only correction attempts. `correctionAttemptCount` counts corrections only, excludes the
initial proposal, and is always `0..2`. Every correction uses the byte-identical immutable input,
and every invalid initial or correction attempt leaves both output and receipt absent. Only a fixed
safe pre-receipt authoring-validation code is correctable. If the second correction fails, stop the
Preference lane safely, report correction exhaustion and the last safe validation code, and do not
continue downstream. Authority, immutability, containment, path, I/O, infrastructure, and
corrupt-state failures stop immediately and are never correctable.

Work only on events whose project label is the primary project unless the contributor asks
otherwise. Off-project events are noise and spending the contributor's attention on them is the
main way this pass fails.

Generated probes are questions, not confirmed preferences. They must be prepared before Project
Story human review opens by using reusable lessons represented by generated Insight candidates, and
they remain unanswered until the contributor acts. If no valid question is warranted, write and
validate a completed-zero probe batch rather than inventing a preference.

## Stage 1 — Verify the reviewed boundary and report prior removals

Read the aggregate from the exact completed Privacy merge report bound to the reviewed redaction
bundles. Report that aggregate,
never removed content and never a new mutation:

```text
Removed 37 items before review:
  12  credentials and tokens
  19  file paths containing your username
   6  third-party contact details
These counts came from the completed Privacy preparation.
```

Rules:

- Report a total and a per-category breakdown. A bare "removed some sensitive content" is not
  acceptable — the contributor cannot audit a number they were never shown.
- If the count is zero, say so explicitly. Silence reads as "the tool did not run".
- Do not include the removed content itself in the summary.
- Do not create, change, inspect, or undo Privacy decisions in this skill.

## Stage 2 — Preserve reviewed judgement-call decisions

Honor the bulk judgement-call decisions already recorded by Privacy preparation. Excluded passages
do not become probe recaps or candidate preferences, and this skill does not ask the contributor to
repeat those Privacy decisions.

Rules:

- Use only the reviewed, permitted events that remain in the prepared input.
- Never reconstruct or summarize excluded content.
- Missing Privacy preparation is a blocker, not permission to fall back to raw history.

## Stage 3 — Find the high-signal moments

Score events for friction, not for topic. See
[references/signal-heuristics.md](references/signal-heuristics.md).

The strongest signals, roughly in order:

1. The contributor corrected or reverted the agent, and did it again on the same point.
2. A single question consumed many consecutive turns.
3. The contributor rejected a completed result rather than an unstarted plan.
4. An earlier decision was explicitly reversed.
5. The contributor stated a rule outright ("always ...", "never ...", "next time ...").
6. In meetings: sustained disagreement that resolved into a decision.

Cap the result at **12 probes by default**, hard-limit 20. Annotation quality collapses well
before a contributor has answered thirty questions, and a long queue gets abandoned entirely —
which yields zero preferences instead of ten. When more moments qualify than the cap allows, keep
the highest-scoring ones and tell the contributor how many were set aside.

Merge probes that would recover the same preference. Ten questions with three distinct answers
between them is worse than three questions.

## Stage 4 — Reconstruct the situation, then offer three options

For each probe, write a recap that stands on its own. The contributor must not have to reopen
the transcript to answer.

```text
While adding the login page, the agent edited the production config three times in a row.
You reverted it each time and eventually said "stop touching anything under deploy/".

Anything here you want the agent to remember?
  A. Ask me before changing anything under deploy/
  B. Propose a plan before editing files, don't edit first
  C. Keep infrastructure changes on a separate branch
  D. Something else (write it)
  E. Nothing worth recording here
```

Rules that decide whether this works:

- **The three options must come from this transcript.** Generic options ("be more careful",
  "communicate better") make every contributor pick "Something else", which costs them more than
  freeform annotation would have. If you cannot ground three distinct options in the evidence,
  offer two, or drop the probe.
- Options must be **mutually exclusive** and separately actionable. Three phrasings of one idea
  is a single option.
- Always include both escape hatches: "Something else" and "Nothing worth recording here". A
  probe with no exit forces a false positive into the dataset.
- Write the recap in the contributor's own language, matching the source.
- Recap ≤ 3 sentences. State what they were doing, what friction occurred, and how it ended.
- Never quote unsafe content that Stage 1 removed.
- Ask about the preference, not about the events. "Which of these should the agent remember?"
  not "Was this conversation important?"
- Present all probes as one reviewable batch. Do not interrupt the contributor once per probe.

## Stage 5 — Write the results

Write `preference-candidates.json` per
[references/preference-probe-contract.md](references/preference-probe-contract.md), then finalize
the only API-shaped output before handing off:

```powershell
python .\skills\oxygen-elicit-contributor-preferences\scripts\validate_probes.py `
  --context "$Review\preference-context.json" `
  --candidates "$Review\preference-candidates.json" `
  --workflow-run-id "$WorkflowRun" `
  --source-revision $SourceRevision `
  --output "$Review\preference-bundle.json"
```

The final bundle uses only the exact `/api/probes` camelCase contract. A failed preparation or
finalization preserves an existing output byte-for-byte.

Each confirmed preference becomes a checklist entry attached to its source document, carrying the
evidence event IDs so the contributor can always reopen the original moment.

## Viewer integration

Probes attach to **both** trajectory and meeting documents. A contributor's preferences surface
in their agent conversations at least as often as in meetings, so a checklist path that accepts
only meetings covers the smaller half of the problem.

Answering a probe must produce visible feedback immediately — the recorded preference, its
target document, and an undo. A probe that silently disappears on click reads as a lost answer.

## Boundaries

- Never fabricate a preference the contributor did not confirm. An unanswered probe is unanswered
  data, not a soft yes.
- Never reopen raw project history or independently run a redaction workflow.
- Never treat an answered probe as publication approval.
- Never read credential files, private keys, tokens, or cookies.
- Use the contributor's configured model and key. Do not require a bundled Oxygen key.
- Removal counts must be exact. An approximate count is worse than none, because it will be
  trusted.
