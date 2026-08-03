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

Non-conversational agent actions, tool calls, shell commands, outputs, artifacts, and source
metadata become safe action labels in the release candidate. Two backends can produce the case:

Do not send source text to a third-party redaction or PII-scrubbing service. The contributor's own
configured model access is not a third-party service in this sense and is permitted under §1.

**Local CPU backend.** `skills/oxygen-history-redaction` with Presidio and spaCy. Nothing leaves
the machine. Its recall on non-English entities is weak — the bundled model is English-only, so
Chinese personal and place names are largely missed. Prefer it when no model access is configured,
or when the material is not the contributor's to disclose.

**Model backend.** `tools/llm_redact` sends the conversational turns to the contributor's own
configured model. Code, tool calls, tool output, and artifacts are stripped first and never sent.
It substantially outperforms the local backend on mixed-language material.

Use a mid-tier model or better. The smallest tier of a model family is a false economy here: in
comparison runs it returned a materially higher rate of offsets that did not exist, reported
coverage counts it had not actually reviewed, and missed findings in the highest-severity
categories that a larger model caught. Validate whichever you choose — the checks below exist
because a redaction pass that fails quietly looks exactly like one that succeeded.

Whichever backend runs, validate its output before applying it. A model can return an offset that
does not exist, a category outside the allowlist, or a coverage count it did not actually review;
`tools/llm_redact/merge_and_apply.py` and `verify_coverage.py` reject each of those rather than
letting them reach the release candidate. Report the rejection count alongside the hit count — a
pass with zero rejections and a pass whose failures were dropped silently look identical otherwise.
`verify_coverage.py` exits non-zero on a mismatch and is meant to gate the pipeline, not to be read
by eye; run it against the probe pass too.

Two failures found the hard way, both of which look like success:

- **Run the model pass on the prepared case, never on the raw run.** Conversational turns can be a
  low single-digit percentage of the bytes a run would ship — the rest is artifact content the
  viewer's importer inlines from disk. A pass over the raw run reports a healthy hit count while
  never looking at almost anything that ships. Run `tools/llm_redact/audit_coverage.py` against
  your own run and read the reviewed/never-reviewed split before trusting a result.
- **A filter that matches nothing must fail, not pass.** These tools once globbed `traj-*.json`
  while the prepared case names files `trajectory-000001.json`; the coverage gate matched zero
  files and printed `0 trajectories checked, 0 mismatched`, exit 0. Every helper here now exits
  non-zero on an empty input set.

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

The Viewer implements probe-answer controls in its `Preferences` tab. Generate the batch, push it
with `tools/llm_redact/push_probes.py`, and let the contributor answer in the browser:

```bash
python3 tools/llm_redact/push_probes.py \
  --probes work/<run>-probes --dialogue work/<run>-dialogue --limit 12
```

Each probe shows its recap, its offered options, `Nothing worth recording here`, a free-text
`Something else`, and its source evidence IDs. Every recorded answer displays what was stored and
offers `clear`, which returns the probe to unanswered rather than recording a refusal. A probe with
no answer produces no preference. Answers live in the `probes` table and are exported with the run;
`preference-probes.json` remains the interchange format for anything outside the Viewer.

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

Two further tabs are available once their passes have run:

- `Redaction review` lists **every** event that would ship, not only the changed ones, so the tab
  is a release preview rather than a diff. Events with a hit show the original beside the release
  version; the rest show the single text that would be published. Each span carries its category,
  the reason it was marked, and controls to change the category or delete the decision. Deleting is
  a soft delete: the span stops applying but the record stays auditable.
- `Preferences` presents the probe batch and records answers (§5).

Both tabs report `running` with live progress while their pass is in flight, so an empty result is
never mistaken for a finished one. Redactions are stored as offsets and applied at render time —
`items.content` holds the untouched original, which is what makes a decision reversible. Because of
that, a Viewer serving a run is serving unredacted text over its API; never expose it beyond
localhost without an authenticating proxy in front.

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
