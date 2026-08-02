# Redaction policy

This process makes a best-effort release candidate, not an anonymity guarantee. The original contributor and a privacy reviewer must approve the exact candidate.

## Release boundary

Raw data, source locators, automatic text, findings, hashes, mask plans, masks, waivers, and reviewer identities stay local. Only the finalized archive is eligible to leave the boundary.

Never include raw selected text in a mask plan or ledger. Never expose it in command output. A SHA-256 fingerprint is private review metadata, not public release data.

## Trajectory policy

Classify an event as conversational only when:

1. its event type is `message`, `user`, `assistant`, or `agent`;
2. its role resolves to user or assistant; and
3. it contains a text value.

Normalize those events to `message`. All other events—including system, developer, tool calls, tool results, artifacts, git, orchestration, non-text user/agent events, malformed records, and unknown event types—become `action_label`.

An action label preserves only one of:

- `system`
- `tool_call`
- `tool_result`
- `artifact`
- `version_control`
- `agent_event`
- `user_event`
- `other`

Never retain action intent. Never retain source IDs, timestamps, relations, executor data, tool or function names, calls, commands, arguments, paths, working directories, outputs, errors, effects, return values, artifact metadata/content, diffs, notes, status explanations, or nested source fields. Unknown action types map to `other`; never copy an arbitrary source label.

All release identifiers are canonical and derived from output order. No artifact or manifest file is copied.

## Meeting and dialogue policy

Retain only ordered text records. Generate canonical record IDs and sequence. Use the generic speaker value `participant`. Discard meeting IDs, dates, timestamps, source filenames, speakers, participants, counts, titles, metadata, and extra record fields.

Conservatively mask a line-leading speaker prefix in the text itself. The full text remains subject to deterministic and semantic review.

## Text policy

Only nodes in `private/text-index.json` are eligible for semantic review or manual mutation. Review all of them, not only regex findings.

Before creating the text index, run these local filters in order:

1. normalize source-like tags and meeting speaker prefixes;
2. run Presidio Analyzer with an explicitly configured spaCy `en_core_web_lg` engine after calling `spacy.require_cpu()`;
3. load the bundled `FileSystemPathRecognizer` and detect POSIX/Windows absolute paths, UNC paths, explicit and repository-relative paths, filenames, and sensitive dotfiles;
4. coalesce overlapping/adjacent Presidio results and replace them with canonical tags;
5. tag deterministic live credentials, direct identifiers, infrastructure, links, and opaque IDs.

The Presidio stage is mandatory and fail-closed. Do not use Docker, a remote Presidio service, CUDA/CuPy packages, or transformer/GPU extras. Initialize the analyzer once per process, load and hash every bundled custom recognizer, split exceptionally long text into overlapping chunks, validate returned offsets, and merge duplicate/overlapping detections. Presidio is a high-recall aid and does not replace semantic review.

Ignore generic Presidio `ORGANIZATION`, `NRP`, and `DATE_TIME` results by default so public open-source names, technical communities, and release dates survive. There is no private-terms file: private organizations, projects, repositories, codenames, and dates must be judged in context and masked during semantic review.

Always redact private keys, format-valid vendor tokens, JWTs, credential-bearing URIs, and API-key contents. Detect API keys in common snake_case, camelCase, prefixed environment-variable, quoted JSON/YAML, header, and query-style assignments. Preserve the surrounding key label where possible. Retain only unmistakably synthetic assignment/header/URI placeholders such as `${API_KEY}`, `<TOKEN>`, `your-password`, or `not-a-real-secret`. A longer value is not exempt merely because it contains words such as `test` or `example`; when uncertain, treat it as live.

Retain safe open-source architecture, algorithms, method design, public interfaces, code fences, and shell examples after filtering their paths, PII, and live credentials. Non-conversation tool calls and results remain label-only.

Semantic review must mask:

- private names, handles, organizations, repositories, projects, customers, codenames, and identifying variants;
- credentials and authentication material;
- health, relationships, home, salary, or other private life details;
- self-denigration or statements likely to harm a contributor;
- identifiable third-party opinions or allegations;
- internal commercial strategy, financing, positioning, launch timing, customer metrics, and sensitive exact figures;
- attention tactics, concealed motives, or other intent that should not be attributed publicly;
- exact dates or combinations of role, employer, customer, location, and timeline that enable re-identification;
- unpublished/private implementation details or repository context identified during semantic review.

Privacy is the dominant objective. If context may preserve the sensitive inference, mask the complete clause, paragraph, or turn.

## Tag policy

The only replacement form is:

```text
<redacted category="allowlisted-category"/>
```

Tags never contain original text, summaries, pseudonyms, replacement prose, exact values, or intent. Manual spans may not overlap one another. A manual span may contain an automatic tag completely, allowing one conservative sentence/turn mask to replace several smaller tags, but may not cut through a tag.

Offsets are evaluated against the immutable `automatic` text. One mask record groups every span for a text target. Rebuilding always starts from `automatic`, preventing cumulative offset drift.

## Findings and waivers

Findings are high-recall signals and are not complete. Expand each signal to its containing sentence, then merge overlapping or nearby suggestions for the same text target. This reduces action count and makes masks less sensitive to narrowly chosen phrase boundaries. Each consolidated finding must be fully contained by one manual span or have an individual waiver. A waiver must explain why the passage is safe in context without quoting it. Never waive by category or in bulk.

## Release gates

Finalization requires:

1. deterministic checks pass;
2. every indexed text node received semantic review;
3. the original contributor reviewed the exact candidate;
4. a privacy reviewer reviewed the exact candidate;
5. publication is explicitly approved.

Any uncertainty resolves toward masking or blocking release.
