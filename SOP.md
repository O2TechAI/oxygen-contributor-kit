# Oxygen local contribution SOP

## Goal

Collect only the contributor's in-scope project history, separate mixed-project content, build a
concise chronological account of the primary project, prepare a best-effort privacy-reviewed
candidate, recover confirmed working preferences, show the local review surface, and finish with
one downloadable ZIP. Nothing is uploaded automatically.

## Completion criteria

The workflow is complete only when all of the following are true:

1. The contributor has been shown the local Viewer whenever a browser-visible frontend is
   available. The exact localhost URL is also provided, and no password is required.
2. The contributor has seen the collection counts, project classification, redaction summary,
   preference questions, exclusions, and unresolved warnings.
3. The contributor can download one verified `oxygen-contribution.zip`.
4. `publication_approved` remains `false` unless the contributor separately and explicitly
   approves publication.

## 1. Establish the local boundary

- Resolve the repository or input path and confirm it belongs to the contributor.
- Inspect only accounts and paths in the contributor-approved scope.
- Never read or package credential files, private keys, tokens, cookies, browser profiles,
  system/developer prompts, or hidden model reasoning.
- Use only the contributor's configured model/API access. Do not require a bundled Oxygen key.
- Keep raw inputs, working files, redaction cases, and review metadata local.
- Download, ZIP creation, review, and publication are separate actions. None implies another.

## 2. Collect

Read and follow `skills/oxygen-ingest-project-history/SKILL.md`. Choose the applicable input:

```bash
# Repository-related Codex and Claude Code history, including allowed memory.
python3 tools/ingest/collect_repo_trajectories.py /path/to/repo \
  --out work/repo-run

# claude.ai export ZIP, JSON, file, or directory.
python3 tools/ingest/import_anthropic_export.py export.zip \
  --out work/claude-run

# Meeting notes/transcript or local audio. Audio remains local.
python3 tools/ingest/import_meeting.py meeting.m4a \
  --out work/meeting-run --language en --no-publish
```

Do not pass `--publish` and do not stage, upload, or submit the result.

Check `work/<run>/index.json` and, when present, `work/<run>/meeting.json`. Report exact source,
trajectory, meeting-record, warning, and failure counts. A newly cloned repository may correctly
have zero matching historical sessions. Confirm that credentials, caches, databases, unrelated
users, and unrelated repositories were excluded.

## 3. Organize by project

Read and follow `skills/oxygen-organize-review-export/SKILL.md`.

- Classify events by the project being discussed, not by event type or tool name.
- A conversation may contain several projects; split and label its events accordingly.
- Reconcile aliases for the same project across trajectories and meetings.
- Select the primary project from sustained contributor intent and substantive work.
- Create `work/<run>/project-map.json` while preserving source event IDs and timestamps.
- Build one combined chronological timeline per project across all matching trajectories. Never
  create one timeline per trajectory.
- Distill the primary-project timeline to 10-40 meaningful milestones. Use the agent to rewrite
  each milestone as a short, one-idea description while retaining the original timestamp and
  evidence IDs.

Report how many source records and events were assigned to each project, what was excluded, and
which classification decisions remain uncertain.

## 4. Prepare privacy review

Read `skills/oxygen-history-redaction/SKILL.md`, including its policy and format references,
before judging content. Its mandatory notice is:

> Best-effort redaction v0.1; no formal anonymity guarantee. Original-contributor final review is
> required before release.

Use the local CPU-only redaction workflow to prepare a private case. Do not send source text to a
remote redaction service. Non-conversational agent actions, tool calls, shell commands, outputs,
artifacts, and source metadata become safe action labels in the release candidate.

Important boundaries:

- Keep the raw organized run unchanged and local. Redaction acts on a normalized candidate; an
  undo means rebuilding from the retained local source, not publishing raw content.
- Report exact automatic-redaction totals and per-category counts, including an explicit zero.
- Do not expose removed text in summaries, logs, or `preference-probes.json`.
- Semantic findings require review; never silently bulk-waive them.
- The redaction skill's `finalize` command creates a local release archive only. It is not the
  final Oxygen contribution ZIP and must not be treated as publication.
- If dependencies are unavailable or a fail-closed check fails, report the blocker and do not
  claim the release candidate is safe.

## 5. Elicit confirmed preferences

Read and follow
`skills/oxygen-elicit-contributor-preferences/SKILL.md` after project organization and after unsafe
content has been excluded from the review copy.

1. Work on the primary-project events unless the contributor asks to include other projects.
2. Report the exact automatic-removal counts from the privacy pass.
3. For judgement-call content such as named-person criticism, ask one bulk question per category:
   remove, keep, or inspect. Default to keep when unanswered.
4. Find friction signals such as repeated corrections, long exchanges, late rejection, decision
   reversal, explicit rules, or sustained meeting disagreement.
5. Merge duplicate signals and produce at most 12 probes by default, with a hard limit of 20.
   Report how many qualifying moments were set aside.
6. For each probe, provide a self-contained recap of at most three sentences and two or three
   mutually exclusive, evidence-grounded choices, plus “Something else” and “Nothing worth
   recording here.”
7. Present all probes as one batch. Do not interrupt the contributor once per event.
8. Write `work/<run>/preference-probes.json` and validate it:

```bash
python3 skills/oxygen-elicit-contributor-preferences/scripts/validate_probes.py \
  work/<run>
```

Only explicit answers become checklist preferences. Unanswered and skipped probes produce no
preference. Every confirmed preference retains its source evidence IDs. A preference answer is
not publication approval.

The current Viewer does not implement probe-answer controls. Present the batch through the coding
agent and write answers to `preference-probes.json`. If a compatible frontend is added later, it
must show the recorded answer, target document, and an undo immediately.

## 6. Launch and show the Viewer

Start the local review server:

```bash
python3 skills/oxygen-organize-review-export/scripts/run_local_review.py \
  work/<run>
```

As soon as it is healthy:

1. Proactively open it in the contributor's visible browser when supported.
2. Always print and send the exact localhost URL, even when automatic opening succeeds.
3. Reuse an available in-app browser or visible frontend surface.
4. If opening is unavailable, provide a clickable URL and state that no password is required.
5. Keep the process alive until review/download finishes or the contributor asks to stop.

The Viewer must show organization progress, project groups, the primary project, one combined
timeline per project, 10-40 concise primary-project milestones, source-event evidence, and visible
HTML/ZIP download actions. Do not describe unsupported annotation controls as available.

## 7. Review and build the ZIP

Ask the contributor to inspect:

- included sources and project assignments;
- primary-project milestones against source evidence;
- automatic-redaction counts and semantic review decisions;
- bulk judgement-call decisions;
- confirmed preference answers and skipped/unanswered probes;
- exclusions and unresolved warnings.

Create `work/<run>/oxygen-contribution.zip`. The reviewed package should contain:

```text
oxygen-contribution/
├── manifest.json
├── data/                         # reviewed trajectories, memory, and meetings
├── project-map.json              # project labels and project timelines
├── preference-probes.json        # questions and explicit answers, when generated
├── privacy/                      # safe aggregate notice/summary, no private review ledger
└── review/
    └── oxygen-local-viewer.html
```

Requirements:

- The manifest records exact counts, warnings, source types, creation time, exclusions, and
  `publication_approved`.
- Package only reviewed release data. Never package raw inputs, `automatic/`, private redaction
  indexes/findings/masks/waivers, reviewer identities, local runtime state, or original secrets.
- Exclude `.env*`, auth files, tokens, cookies, private keys, browser profiles, `node_modules`,
  caches, `.wrangler`, databases, logs, model scratch output, and local virtual environments.
- Inspect the ZIP member list after creation and reject unexpected absolute paths, `..` entries,
  symlinks, or excluded files.
- Open the packaged HTML locally and verify that it states nothing was uploaded.
- Make the ZIP directly downloadable through the Viewer's visible action. If that action is not
  available, provide an immediately usable clickable local file/download link.
- Do not finish with only a filesystem path the contributor cannot access.

## 8. Handoff and stop

Tell the contributor:

- the exact Viewer URL and that it has no password;
- included inputs, project groups, primary project, and milestone count;
- exact privacy-removal counts and any unresolved privacy review;
- probe count, confirmed preference count, and set-aside count;
- exclusions and uncertainties;
- the exact ZIP filename and clickable download action/link;
- the value of `publication_approved`.

Stop after local handoff. Never upload, stage, publish, submit, commit, or push unless the
contributor separately asks for that action.
