---
name: release-redactor
description: Prepare best-effort, human-reviewed local release candidates from Oxygen trajectories, trajectory collections, meeting-transcripts.json, meeting notes, and dialogue. Use when Codex must reduce non-conversational events to action labels, run mandatory local Presidio/spaCy PII and bundled filesystem-path recognizers, retain safe open-source project and method design, consolidate semantic findings, batch-tag sensitive spans, run fail-closed checks, or finalize a deterministic local archive.
---

# Release Redactor

Create a normalized, reviewable release candidate. Keep raw material local, review only indexed text, and require human approval before finalization.

## Non-negotiable boundary

Use this exact posture:

> Best-effort redaction v0.1; no formal anonymity guarantee. Original-contributor final review is required before release.

Never claim guaranteed anonymity. Never upload, message, commit, or publish raw inputs, mask plans, `automatic/`, `private/`, or `approval.json`. `finalize` only creates a local archive.

Read [references/policy.md](references/policy.md) before judging content. Read [references/formats.md](references/formats.md) for exact schemas, mask offsets, and case files.

## Install the local CPU dependencies

Use the bundled installer. It creates a private virtual environment and invokes pip directly; do not use Docker or a Presidio service:

```bash
python3 scripts/install_cpu_dependencies.py --venv .venv
source .venv/bin/activate
```

Do not install spaCy CUDA extras, CuPy, transformer extras, or GPU models. The CLI calls `spacy.require_cpu()` before loading the explicitly configured `en_core_web_lg` pipeline and fails closed if Presidio, spaCy, or the model is unavailable.

All operational code and configuration are bundled in this skill: `scripts/redact_release.py`, `scripts/install_cpu_dependencies.py`, `requirements.txt`, `assets/default-policy.json`, and `assets/presidio-filesystem-paths.json`. Do not depend on a repository-external helper script.

## Workflow

### 1. Establish the private boundary

Keep the input, case directory, automatic text, and mask plan in private local storage. Do not browse or call a remote model with source text. No private-terms TSV is used or required; private names, organizations, repositories, projects, customers, handles, variants, and codenames are handled by the automatic PII stage where applicable and by exhaustive semantic review.

### 2. Prepare the normalized baseline

Run:

```bash
python3 scripts/redact_release.py prepare INPUT \
  --case-dir CASE_DIR \
  --kind auto
```

Preparation performs the privacy boundary automatically:

- A user or assistant event with text becomes a normalized `message`.
- Every other trajectory event becomes `action_label` with only an allowlisted `action_type`.
- Source event IDs, timestamps, relations, actor IDs, paths, tools, calls, arguments, outputs, artifacts, results, notes, and intent are discarded.
- Trajectory IDs, event IDs, order, and turn IDs are regenerated canonically.
- Artifact files and source manifests are never copied.
- Meeting input becomes ordered records containing only canonical ID, sequence, generic speaker, and text.
- Every retained text passes through local Presidio Analyzer with the CPU-only spaCy backend.
- A bundled Presidio custom recognizer tags POSIX, Windows, UNC, explicit-relative, repository-relative, filename, and sensitive-dotfile paths.
- Presidio spans, deterministic rules, speaker prefixes, paths, and live secrets become irreversible `<redacted category="…"/>` tags.
- API-key values are filtered automatically across common assignments, quoted JSON/YAML, environment-variable, header, and query-string forms; labels remain when possible and unmistakable placeholders survive.
- Clearly synthetic credential placeholders and safe open-source architecture, algorithms, method descriptions, code fences, and shell examples remain available after their paths/PII/secrets are filtered.
- Only the already-filtered text enters the semantic text index.

The command creates:

- `automatic/`: immutable normalized baseline;
- `reviewed/`: deterministic rendering of current masks;
- `private/text-index.json`: the complete set of reviewable text nodes;
- `private/pii-state.json`: content-free Presidio/spaCy execution evidence;
- `private/findings.json`: sentence-expanded, consolidated semantic signals;
- `private/suggested-mask-plan.json`: a content-free, ready-to-edit grouped plan;
- `private/masks.json`: grouped offsets and hashes, never selected text;
- `approval.json`: fail-closed approval gates.

Do not preserve source schema for publication. The normalized release schema is the safety mechanism.

### 3. Review text only

List every eligible text node:

```bash
python3 scripts/redact_release.py text-index CASE_DIR
python3 scripts/redact_release.py findings CASE_DIR
```

Read every indexed text node in `automatic/data/`, including nodes with no finding. Do not inspect action-label events semantically; they contain no source content.

Mask direct identifiers, live secrets, private life or health, identifiable third-party views, internal commercial strategy, sensitive intent, private timelines or metrics, and re-identifying combinations. Retain public open-source project architecture, algorithms, method rationale, non-sensitive code, public release dates, and obvious placeholders such as `${API_KEY}` or `<TOKEN>`. Because there is no private vocabulary file, explicitly review private organizations, repositories, projects, and codenames in context and mask them as semantic spans. Privacy has priority when provenance or placeholder status is uncertain.

Start from `private/suggested-mask-plan.json`. Preparation expands each regex signal to its sentence and merges nearby/overlapping signals, so one conservative span usually replaces several brittle fragments. Read the underlying text, enlarge or merge spans when needed, add unflagged semantic spans, and remove only suggestions that receive an individual waiver. Do not treat the suggested plan as completed review.

Use offsets against the immutable `automatic` text. Put all targets and spans for the review batch in one private plan:

```json
{
  "version": "1",
  "targets": [
    {
      "target_id": "text-00000001",
      "text_sha256": "64-lowercase-hex-characters-from-text-index",
      "spans": [
        {
          "start": 12,
          "end": 47,
          "category": "private-personal"
        },
        {
          "start": 80,
          "end": 123,
          "category": "commercial-strategy"
        }
      ]
    }
  ]
}
```

Do not put quotes, replacements, names, or reasons in the plan. Spans use Python string offsets `[start, end)`, may cover a whole turn, and must not overlap. A span may contain a complete automatic tag but must never cut through one.

Submit the entire plan once:

```bash
python3 scripts/redact_release.py mask-text CASE_DIR \
  --plan PRIVATE_MASK_PLAN.json
```

This validates all text hashes and spans, stores only offsets and hashes, inserts canonical tags, and rebuilds `reviewed/` in the same invocation. Re-submit a target to replace that target’s complete span set. Other targets remain unchanged.

If a semantic finding is genuinely safe, waive only that finding:

```bash
python3 scripts/redact_release.py waive CASE_DIR \
  --finding review-00000001 \
  --reviewer privacy-reviewer \
  --reason "Generic public method with no person or internal decision attached"
```

Never bulk-waive.

### 4. Inspect and check

Use the content-free mask summary:

```bash
python3 scripts/redact_release.py diff CASE_DIR
python3 scripts/redact_release.py check CASE_DIR
```

`diff` prints target IDs, masked character counts, span counts, and categories; it does not echo sensitive context.

`check` fails closed if:

- the mandatory Presidio/spaCy CPU state is missing or does not cover every text target;
- the automatic baseline, mask ledger, or reviewed candidate changed out of band;
- any file, non-text field, normalized event envelope, or normalized meeting record changed;
- an action event contains anything beyond its allowlisted action label;
- a deterministic sensitive pattern remains in indexed text;
- a tag is malformed;
- a semantic finding is not fully covered by one mask span or one narrow waiver.

### 5. Approve and finalize

Record actual decisions in `approval.json` and require:

- `semantic_review_complete`;
- `original_contributor_reviewed`;
- `privacy_reviewer_reviewed`;
- `publication_approved`;
- a nonempty identity for each review role.

Then run:

```bash
python3 scripts/redact_release.py finalize CASE_DIR \
  --output release-candidate.tar.gz
```

Report the archive path and SHA-256. The deterministic archive contains only `data/`, the notice, a safe aggregate redaction summary, and a release manifest.

## Stop conditions

Stop instead of finalizing if the local Presidio/spaCy CPU dependencies are unavailable, any indexed text was not read, a credential escaped the local boundary, a participant disputes a decision, any finding remains pending, a reviewer has not approved, or `check` fails.
