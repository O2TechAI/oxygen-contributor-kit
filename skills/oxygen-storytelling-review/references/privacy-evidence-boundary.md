# Privacy And Evidence Boundary

## Two Privacy Boundaries

Do not collapse these steps into one ambiguous Privacy phase.

Upstream source Privacy runs before Story generation. It prepares the reviewed input boundary by replacing non-conversational payloads with fixed labels, applying validated redaction spans, and blocking release while source-level review states remain unresolved.

Story/Release Privacy runs after the Story candidate exists. The Agent authors one meaning-preserving proposal for every release target, while candidates remain explanatory metadata outside `oxygen.story`. The contributor then chooses the exact release bytes through the server-owned target authority; the hydrated Story session does not own those choices.

## Provider Processing And Final Export Boundary

During Organization and Story authoring, the contributor-selected current coding Agent/model
provider may process raw or private project material so semantic meaning and narrative quality
survive. Provider processing is distinct from automatic upload, publication, and final package
export. Oxygen must not silently switch providers or send Privacy-derived data to a second endpoint.
Final package reconstruction is provider-free, but the whole workflow is not necessarily
provider-free or entirely on-machine.

The hard Privacy boundary applies to the exact contributor-reviewed final export bytes. Detection
and anonymization are best effort, and final human review is mandatory. Final release uses
meaning-preserving anonymization rather than blank deletion; making an exact noncredential public
occurrence public remains an explicit reviewed contributor choice. The localhost Viewer, working
artifacts, and final package flow do not automatically upload or publish data, and
`publication_approved=false` remains unchanged.

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

Chapter Privacy/Release Preview is implemented in the canonical Viewer. It shows what would be
released, not a raw-source browser:

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

Raw Evidence and suppressed content are not exposed through Insight review.

## Story/Release Target Authority

Candidate rows have stable IDs and safe explanatory metadata only. Every current release target has exactly one Agent-authored meaning-preserving proposal bound to its target-content digest. A missing, stale, invalid, or incomplete target choice blocks the whole Story/package release.

For each target, the visible choice is:

```text
Local original
Agent-proposed anonymized text
Use Agent proposal | Edit anonymized text | Make an exact noncredential occurrence public
```

Credentials are always removed. HTML and ZIP consume the exact same contributor-selected bytes.

## AI And Human Revision Safety

Apply review respects the current server-owned Story target authority. It must not regenerate unavailable values, search disallowed sources, turn a Privacy explanation into a Story claim, or return underlying reviewed content merely to certify a user edit.

Unsupported factual additions remain `needs_evidence` until exact permitted evidence supports them. A checkbox or plausible ID alone is not proof.

## Validation

Verify:

- selected-provider processing is distinguished from automatic upload, publication, and final
  package export;
- final export reconstruction does not call a provider or silently switch to a second endpoint;
- the hard Privacy boundary is limited to exact contributor-reviewed final export bytes, with
  best-effort detection/anonymization and mandatory final human review;
- source Privacy preparation ran on the reviewed input boundary, not raw package output;
- unresolved source `needs_confirmation` items block release;
- Story/Release candidate metadata and target proposals do not exist inside `oxygen.story`;
- every Evidence reference resolves exactly once;
- excluded semantic units cannot support Story copy;
- Evidence stays original-language;
- available originals are minimal and local-only;
- unavailable originals carry no excerpt, source language, removed value, or raw payload;
- source Keep/Redact decisions and Story target choices are explicit human actions;
- release projection strips originals and review metadata;
- `publication_approved=false` remains false.
