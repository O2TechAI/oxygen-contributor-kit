# Canonical Story Language Contract

This file is the sole owner of Story language selection and propagation. Language changes
authorable text, not Story, Insight, Preference-answer, Privacy, review, or release identity. A run
has one canonical `oxygen.story` source per Chapter and one shared review/release authority; do not
create per-language Story schemas, sidecars, histories, Privacy decisions, answers, or releases.

## Bound language policy

Before any Story worker assignment, output, or receipt, preparation derives and persists this exact
policy in the existing `story/validation-authority.json` and carries it unchanged in the final
`oxygen.story-preparation` manifest:

```ts
type StoryLanguagePolicy = {
  schema: "oxygen.story-language-policy";
  workflowRunId: string;
  sourceRevision: number; // positive JavaScript-safe integer
  sourceDigest: string; // exact current semantic source authority
  sourcePrivacyDigest: string; // exact current public Source Privacy projection
  sourceInputDigest: string; // exact represented Privacy-reviewed Story input
  detectedLanguage: "en" | "zh" | "mixed";
  selection: "all-english" | "all-chinese" | "preserve-per-story";
  stories: Array<{ storyKey: string; language: "en" | "zh" }>;
};
```

Rows are unique and sorted by UTF-8 `storyKey`. The policy digest is SHA-256 of canonical JSON.
Every bounded lane input carries the exact relevant `stories` projection plus the whole-policy
digest, workflow run, and source revision. A stale, foreign, malformed, or tampered policy fails
before output or receipt. Existing receipt fields keep their established meanings; policy binding
is through the immutable lane input, validation authority, output metadata, and final manifest.

Every final `StorySource` carries exactly one `language` and the whole `languagePolicyDigest`.
Missing or invalid metadata is rejected and regenerated; there is no old-payload fallback. A Story
worker authors only its assigned language. Phase labels and Timeline navigation labels remain
English at the data boundary regardless of Story language.

## Deterministic classification and mixed continuation

The sole classifier counts Unicode Han and Latin letters in the exact represented
Privacy-reviewed Story input. Han at or above 80 percent of those letters is `zh`; Latin at or
above 80 percent is `en`; every other ratio, including no language evidence, is `mixed`. This
tolerates a bounded minority of technical terms without maintaining a second classifier.

Strong `en` selects `all-english`; strong `zh` selects `all-chinese`. Mixed input stops before any
worker assignment, output, or receipt with the fixed code `STORY_LANGUAGE_CHOICE_REQUIRED` until
the parent supplies exactly one of:

- `all-english`
- `all-chinese`
- `preserve-per-story`

`preserve-per-story` classifies each exact Coverage owner/Chapter with the same rule. Clear owners
are deterministic. Every mixed or no-language owner must appear exactly once in the explicit map
as `en` or `zh`; the parent may not guess, default, translate, or silently fall back.

## Review, Preference, and release reuse

Review block projection and review/release edit application use `StorySource.language`; the same
Chapter keys, block IDs, Insight IDs, Privacy targets, review decisions, and release gate survive
either language. Evidence remains exact source-language evidence and is never presented as a
translation.

Preference `insightScope` remains exactly
`{storyKey, insightId, insightAuthorityDigest}`. Language is display metadata carried by the
linked reusable lesson and bounded assignment, never part of Insight binding, option IDs, question
IDs, or answer identity. A probe may contain reviewed `en` and `zh` presentations, but the exact
linked Story language presentation must exist and validate before activation. Missing copy fails
preparation/activation; there is no fallback, automatic synthesis, or translation.

## Required behavior

Behavior tests cover strong English and Chinese input, every mixed continuation, ambiguous-owner
mapping failure, policy tamper/stale/foreign rejection before receipt, worker language mismatch,
English Phase labels, required Preference presentation, stable identities and authorities, and
current-shape fixture migration without compatibility parsing.
