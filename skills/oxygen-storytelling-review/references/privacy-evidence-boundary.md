# Privacy and evidence boundary

## Reviewed artifact is the ceiling

Storytelling Review works from an already-reviewed project representation. It must not silently reopen or search for:

- raw agent histories;
- removed redaction findings or values;
- private review ledgers;
- source envelopes or `original_json`-style payloads;
- secrets, credentials, cookies, private keys, tokens, or browser profiles;
- unrelated local repositories or accounts.

If the reviewed artifact no longer contains a fact or original value, the system cannot recover it for Story or Privacy. A richer UI never justifies crossing this boundary.

## Archive safety checks

Before importing a reviewed archive:

- validate CRC/integrity;
- reject absolute, parent-traversal, drive-prefixed, or unsafe member paths;
- read manifest and required reviewed data only;
- require `publication_approved=false`;
- verify manifest document/event counts;
- hash the artifact and bind local Story data to that hash;
- avoid extracting disallowed/unneeded members.

Stop with a clear blocker when these checks fail.

## Story vs evidence

Keep these concepts visibly and structurally separate:

```text
Story / release draft
Local evidence / exact source
```

Story is AI-compressed and human-reviewable. Evidence is authoritative local reviewed material. Story annotations never mutate Evidence.

Every Chapter links stable primary/supporting evidence IDs. Evidence remains secondary in the Chapter UI but must be exactly traceable. Opening it reuses the existing release/evidence review surface and focuses the real event.

## Evidence language

Exact evidence remains in its original source language. Do not silently translate evidence and present the translation as original.

Allowed:

```text
Chinese Story → original English evidence
English Story → original Chinese evidence
```

Localize the Evidence-view chrome if supported, while keeping exact source content and IDs unchanged. A translated-evidence view is a separate optional feature and is not required.

## Evidence navigation state

Chapter → Evidence must record:

- originating Chapter key;
- Chapter Story scroll position;
- selected evidence reference/anchor;
- project;
- current presentation language.

Evidence → Chapter Back restores that context. Do not make the reviewer rediscover the Chapter through the rail.

## Privacy candidate model

Privacy asks one human decision at a time. Each candidate has a stable ID, localized title/explanation, required flag, original availability, safe why-flagged copy, and an explicit set of stable semantic release targets. An empty target set means the reviewed concern is local-only/already absent from release copy; it must be explicit rather than inferred.

The visible decision model is only:

```text
Local original
Why AI flagged it
Keep | Redact
```

There is no Suggested Release field, recommendation sentence, AI rewrite, or automatic choice. Internal compatibility metadata must not prescribe the UI decision.

## Available original context

Mark `available` only when the relevant excerpt exists in permitted reviewed local evidence.

Show:

- the minimum excerpt needed to understand the decision;
- its source language;
- a specific why-flagged explanation identifying the concerning element, information class, and unchanged-release risk.

Possible risks include real identity, internal metrics, local paths, private project/customer names, or combinations that create re-identification risk. These are categories, not permission to invent candidate facts.

Do not expose more context than needed. Keep the excerpt local-only and out of generic tracked fixtures/exports.

## Unavailable original context

When the reviewed artifact no longer contains the original, state clearly:

```text
Original content unavailable in the reviewed artifact.
```

The safe why-flagged explanation must use only surviving metadata/context and cover:

- the identified information class;
- why that class can be difficult or unsafe to release;
- uncertainty caused by the missing original;
- why human confirmation is still requested;
- what Keep actually preserves (existing safe placeholder/context, never the removed value).

Do not infer, approximate, hallucinate, reconstruct, recover, or display the removed text/value. Import validation must reject an unavailable candidate that carries an excerpt.

## Keep and Redact semantics

- **Keep:** preserve the currently available safe release context; never restore unavailable content.
- **Redact:** suppress every bound semantic release target in both languages and ensure the candidate does not appear in the reviewed release projection.

Neither decision deletes source evidence. Decisions remain local Chapter review state and feed Apply/All set gating.

## Identity boundary

Local review may know a real identity only when explicitly supported and permitted. Release identity remains anonymized/generic unless reviewed release policy says otherwise.

Never infer a name from role, path, writing style, or incomplete evidence. Identified local-only information does not automatically ship.

## AI revision safety

Apply review may use Privacy decisions to remove/suppress release content. It must not:

- regenerate an unavailable value;
- search sibling worktrees or raw sources for it;
- turn a Privacy explanation into a factual Story claim;
- publish local excerpts;
- treat Keep as permission to recover missing material.

Unsupported Add instructions are blocked/flagged rather than satisfied from disallowed sources.

## Validation

Verify:

- every evidence reference resolves;
- exact source content remains original-language;
- no Story action mutates Evidence;
- available excerpts are present in permitted reviewed data;
- unavailable candidates contain no excerpt/value;
- why-flagged copy is specific but safe;
- Suggested Release is absent in both languages;
- Keep/Redact progression works;
- Redact changes the allowlisted reviewed release projection for every bound target;
- unresolved required decisions block Apply/All set as specified;
- exported/generic source contains no local excerpt or removed content;
- Final Release Memory keeps publication false.
