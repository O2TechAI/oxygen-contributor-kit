# Localization Contract

## Current Authority

The final `oxygen.story` source parser accepts the English Story fields documented in [story-data-contract.md](story-data-contract.md). It does not accept an alternate localized source schema and does not store a localized Story sidecar in the parsed `StorySource`.

English is therefore the canonical source-readiness and release surface on this base. Do not claim localization exists, blocks activation, or ships in `oxygen.reviewed-story` unless production code implements that authority.

## Optional Presentation

If a safe localized presentation exists outside `oxygen.story`, it is optional and must share the same Chapter keys, Phase IDs, Person IDs, Story-block IDs, Insight IDs, Privacy candidate IDs, Evidence references, revision history, and All set state.

Missing, incomplete, stale, or unsafe localization must not invalidate a valid English candidate. Omit unsafe localized presentation rather than weakening English, Privacy, Evidence, or release gates.

## What May Localize

Viewer chrome may localize labels such as navigation, status, buttons, blockers, Preferences, Evidence-view chrome, and review actions. Exact Evidence content and technical identifiers remain in the original source language.

If localized Story or Insight presentation is implemented later, it must preserve the same factual claims, causal relationships, failures, uncertainty, decisions, and Insight meanings:

```text
Background
Quote
Directly Acquired Experience
Principle
```

A local reviewed Quote may contain exact bound raw source text. Any localized final release uses the
same contributor-reviewed Story Privacy bytes as the canonical release and cannot bypass its target
choices or release gate.

## Shared Review State

Review state is keyed by Chapter and stable Story identities, not by language. Do not create separate All set histories or Preference answers per language.

Direct edits in one language may create informational paired-presentation debt when such a presentation exists. That debt is local review metadata, not a canonical English blocker unless production code explicitly makes it one.

## Evidence Language Rule

Story UI may switch language when safe presentation exists. Evidence stays source-language. Never translate Evidence and present it as original.

## Required Checks

Verify:

1. English-only Story can activate, complete review, and export.
2. Localization absence does not block English.
3. Any localized UI labels preserve the same review state.
4. Evidence IDs and technical anchors remain stable.
5. Evidence content remains source-language.
6. Localized presentation, if present, is omitted from release when stale or unsafe.
