# Privacy And Evidence Boundary

## Two Privacy Boundaries

Do not collapse these steps into one ambiguous Privacy phase.

Upstream source Privacy runs before Story generation. It prepares the reviewed input boundary by replacing non-conversational payloads with fixed labels, applying validated redaction spans, and blocking release while source-level review states remain unresolved.

Story/Release Privacy runs after the Story candidate exists. It reviews release-safe Story targets and asks the contributor to Keep or Redact only when an implemented candidate authority supplies those candidates. `oxygen.story` does not contain those candidates. On this base, the Story review context is empty unless production code supplies candidates from another authority; if candidates are required but absent, stop at a readiness gate.

## Reviewed Boundary Is The Ceiling

Story work may use only the reviewed contribution artifact and explicitly permitted local Story data. Do not reopen or search:

- raw private histories;
- removed redaction values;
- private review ledgers;
- source envelopes or original event JSON;
- credentials, cookies, tokens, browser profiles, keys, or system prompts;
- sibling repositories or accounts outside the approved scope.

If the reviewed boundary no longer contains a fact or original value, Story and Privacy cannot recover it.

## Archive And Input Safety

Before import or reattach:

- validate archive integrity and member paths;
- reject absolute paths, parent traversal, drive-prefixed paths, unsafe symlinks, and unexpected members;
- require manifest counts to match reviewed data;
- require `publication_approved=false`;
- hash the reviewed artifact and bind generated Story data to the current source authority;
- avoid extracting disallowed members.

Fail closed on mismatch.

## Evidence Rules

Evidence remains authoritative local reviewed material. Story is a release-draft projection with exact support. Story review never mutates Evidence.

Every Chapter declares primary and supporting Evidence. Before activation, Apply review, All set, and release, every unique Chapter reference must resolve to exactly one permitted reviewed item with matching document ID. Missing, ambiguous, duplicated, foreign, or excluded references fail closed.

Evidence content stays in its original source language. Do not translate it and present the translation as original. Evidence UI chrome may localize, but IDs and source text remain unchanged.

## Release Preview Contract

Final decision-only Chapter Privacy/Release Preview is implemented in the canonical Viewer. It
shows what would be released, not a raw-source browser:

- Deterministic or contributor-confirmed safe content shows only the current release-safe projection.
- A `needs_confirmation` source Privacy item shows the minimum permitted local original beside the current safe projection, a safe uncertainty reason, and Keep/Redact.
- If the original is unavailable, state that it is unavailable and use only surviving safe metadata/context to explain the information class, uncertainty, and human decision needed.
- Unavailable originals are never inferred, approximated, reconstructed, searched for, or displayed.
- Review metadata, source originals, offsets, anchors, Evidence IDs, Story JSON, prompts, and private ledgers never enter `oxygen.reviewed-story`, `oxygen-reviewed-story.html`, or `oxygen-contribution.zip`.

Only `needs_confirmation` rows are decision-editable. The final contributor actions are exactly:

```text
Keep
Redact
```

Keep preserves existing safe release context. Redact suppresses the bound release targets. Neither decision deletes source evidence, changes category/status/reason metadata, soft-deletes a row, or authorizes publication. Pending confirmation blocks Story/package release.

Raw Evidence and suppressed content are not exposed through Insight review. Describe this section as
the required release contract and readiness gate, not as an already verified UI.

## Story/Release Candidate Shape

When current candidate authority exists, a candidate must have a stable ID, safe title/explanation, original availability, safe why-flagged reason, and explicit release targets. An empty target set means local-only or already absent from release copy and must be explicit.

The visible decision is:

```text
Local original or unavailable notice
Why AI flagged it
Keep | Redact
```

Do not display an AI-prescribed rewrite or treat model wording as the contributor decision.

## AI And Human Revision Safety

Apply review may use approved Privacy decisions to remove or suppress release content. It must not regenerate unavailable values, search disallowed sources, turn a Privacy explanation into a Story claim, or return underlying reviewed content merely to certify a user edit.

Unsupported factual additions remain `needs_evidence` until exact permitted evidence supports them. A checkbox or plausible ID alone is not proof.

## Validation

Verify:

- source Privacy preparation ran on the reviewed input boundary, not raw package output;
- unresolved source `needs_confirmation` items block release;
- Story/Release candidates are not assumed to exist inside `oxygen.story`;
- every Evidence reference resolves exactly once;
- excluded semantic units cannot support Story copy;
- Evidence stays original-language;
- available originals are minimal and local-only;
- unavailable originals carry no excerpt, source language, removed value, or raw payload;
- Keep/Redact decisions are explicit human actions;
- release projection strips originals and review metadata;
- `publication_approved=false` remains false.
