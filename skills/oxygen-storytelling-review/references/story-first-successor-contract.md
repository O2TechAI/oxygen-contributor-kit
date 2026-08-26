# Story-First Successor Target Contract

> **FROZEN MIGRATION PROVENANCE — NOT THE ROUTED ACTIVE GENERATION OR RUNTIME CONTRACT.**
>
> The routed active contracts now own these Story-First semantics. The canonical live path is
> `oxygen.story/3` → `oxygen.story-review-session/2` → `oxygen.reviewed-story/2` after deterministic
> source readiness, atomic activation, and explicit human review. Compatibility
> `oxygen.story-highlight/2` remains session `/1` → reviewed-story `/1`; historical
> `oxygen.story-milestone/1` remains non-reviewable compatibility only. Legacy artifacts retain their
> original semantics and must not be reinterpreted as successor approval or readiness.
>
> Migration status: `MERGE_INTO_CANONICAL_LATER` -> `DELETE_AFTER_CANONICALIZATION`.

## Scope

This reference freezes the semantic target for the Story-First / Sparse Insights successor. It does not select production version strings, change runtime parsing or readiness, define cross-revision text-range identity, alter Review Session or release behavior, or authorize publication.

Privacy, Evidence traceability, attribution, causal restraint, uncertainty, non-fabrication, source revision, CAS, digest protection, server-owned release reconstruction, release allowlisting, and publication separation remain unchanged.

## Generation order

The semantic order is:

1. understand the complete reviewed history;
2. determine coherent Chapter boundaries;
3. obtain the ordered Chapter sequence;
4. group adjacent Chapters into Phases;
5. write and verify the complete Story for chronology, causality, continuity, attribution, uncertainty, and Evidence support;
6. read the resulting Story and identify zero or more genuinely reusable moments;
7. create and ground any warranted Insights.

Phase must not determine Chapter boundaries. Story must not be organized around preselected Insights.

## Chapter

A Chapter boundary is owned by a complete, coherent narrative arc. A transcript, meeting, file, source document, event count, fixed time slice, Insight count, importance score, highlight worthiness, or reusable lesson does not define the boundary.

A supported Chapter may retain background, ordinary setup or progress, transitions, relationships and handoffs, attempts, failures, disagreements, corrections, decisions, validation, consequences, and unresolved or current state.

A Chapter does not universally require drama, tension, a breakthrough, a decisive turn, a problem-action-result template, a reusable lesson, or a separately typed final `current_state` Chapter. Current state must remain honest: it may be its own Chapter when it forms a coherent arc, or the supported ending of the final Chapter otherwise.

Chronology, context, failures, uncertainty, causal restraint, non-fabrication, Evidence traceability, and Privacy boundaries remain mandatory.

## People

People is required. Every successor Chapter must contain at least one supported Person or actor entry.

Do not invent people, responses, consensus, identity merges, or attribution. Humans, Agents, reviewers, and operators may be actors when supported. Every action, review, and decision must remain attributed to the actor supported by the reviewed history.

## Phase

Every Chapter belongs to a Phase grouping. A Phase groups adjacent Chapters on the Timeline and summarizes a coherent project period or state. It is presentation and navigation, not the review unit.

Phase labels are precise one- or two-word labels such as `Foundation`, `Validation`, `Integration`, `Recovery`, or `Release`. Generic labels such as `Project Evolution`, `General Work`, `Other`, and `Later Stage` are invalid.

The existing homepage and Timeline Phase presentation is preserved. No redesign follows from this contract.

## Story

Story is the complete historical narrative within the reviewed boundary. Story relevance is independent of Insight worthiness. Narratively necessary passages remain valid even when they contain no reusable lesson or separate assistance.

## Insight cardinality and identity

A successor Chapter contains zero or more Insights (`0..n`). There is no semantic minimum, maximum of one, per-block quota, density target, or one-per-Chapter rule. Multiple Insights are valid only when each is an independently useful learning or judgment moment.

Zero source Insights is a first-class state. It is not equivalent to generating an Insight and later rejecting it.

A stable Insight ID owns identity. Array position does not.

## The four Insight meanings

The four semantic meanings are exactly:

1. **Background** — the minimum context needed to understand the judgment moment, without rewriting the Chapter or adding general model knowledge.
2. **Quote** — a safe, review-visible trace to the exact reviewed Story moment. The visible Quote comes from safe reviewed Story content or another post-policy-safe representation, never by re-exposing raw private Evidence.
3. **Directly Acquired Experience** — what was directly learned from the event or judgment, given what was actually known then. It remains grounded in the Story and Evidence and does not silently introduce general industry advice.
4. **Principle** — a reusable rule, question, or guardrail for a genuinely similar future condition. It retains its trigger and bounded reason; generic slogans are invalid.

The superseded proposed reconstruction—Context, Critical Moment, Consequence, Reusable Principle—is not this contract.

An Insight title is editable presentation metadata for navigation, scanability, localization, or editing. It is not a fifth semantic meaning, and weak or missing title text alone does not determine semantic validity.

## Insight grounding

Every Insight traces through one or more stable Story-block or safe text anchors to one or more internal Evidence inputs:

```text
Insight -> reviewed Story anchor(s) -> internal Evidence support
```

Anchors support grounding, review navigation, and traceability. They are not importance labels. Internal Evidence, CAS, review, and source identifiers do not become public merely because anchors exist. Cross-revision durable range identity is deferred to engineering work outside this semantic freeze.

## AI-generated Insight review

Every AI-generated successor Insight requires explicit human review of the currently presented version:

| Action/state | Meaning |
|---|---|
| Pending or untouched | Incomplete; silence is not approval |
| `Accept` | Explicit approval of the currently presented version |
| `Edit` | Creates a changed version that remains pending |
| `Do not preserve` | Explicit terminal decision to exclude the Insight from later release |
| Edit followed by `Accept` | Explicit approval of the edited version |

Editing invalidates any approval of an older version. With zero Insights, there are zero Insight-review obligations. With multiple Insights, every existing Insight resolves independently; one pending Insight keeps the Chapter incomplete.

## Human-created Insight

The successor Viewer will later support:

```text
select safe reviewed Story text -> Add Insight -> edit four meanings -> Save
```

The selected safe Story text is the initial Story anchor and Quote source. A successfully saved human-created Insight is explicitly human-authored and human-approved for that saved version; it does not require an immediate redundant `Accept`. Later edits still require normal provenance and state handling.

A human-created Insight is invalid if its anchor names another Chapter, a nonexistent Story block or range, or raw/private data outside the safe target domain.

## Passage assistance

No Story block is required to contain why-it-matters, what-was-learned, or reusable-lesson assistance. Passage assistance, if retained later, is optional, human-facing, non-authoritative, does not determine readiness, does not create a canonical Insight, does not require a lesson, and remains excluded from release unless a later explicit decision changes that.

## Legacy compatibility

Current Story, Review Session, and reviewed release artifacts remain legacy artifacts with their original meanings. Existing version labels must not be widened or reinterpreted in place. Successor implementation requires explicit dispatch.

Legacy behavior must never fabricate successor semantics. In particular, a legacy empty Insight ledger is not successor explicit acceptance. Any conversion must preserve uncertainty and unresolved state and require appropriate re-review.

## Frozen truth table

| Case | Target result |
|---|---|
| Coherent Chapter with People, Phase, zero Insights | Valid |
| Coherent Chapter with one warranted Insight | Valid |
| Coherent Chapter with multiple warranted Insights | Valid |
| Chapter with zero People | Invalid |
| Chapter missing Phase grouping | Invalid |
| Phase used to force a Chapter boundary | Invalid design |
| Story passage with no lesson | Valid |
| Insight missing Background | Invalid |
| Insight missing Quote or Story grounding | Invalid |
| Insight missing Directly Acquired Experience | Invalid |
| Insight missing Principle | Invalid |
| Generic unsupported Principle | Invalid semantic case |
| AI Insight with no explicit review | Incomplete |
| AI Insight accepted | Resolved |
| AI Insight rejected | Resolved and excluded from later release |
| Edited AI Insight without a new `Accept` | Incomplete |
| Zero Insights | Zero Insight-review obligations |
| Multiple Insights with one pending | Incomplete |
| Human-created Insight from a valid selected Story range | Valid |
| Human-created Insight Save | Human-approved |
| Human Insight with foreign, missing, or unsafe anchor | Invalid |

## Implementation boundary

The active generation contracts are the canonical instructions for new Story candidates. This file
remains only as migration provenance until equivalent semantic regression coverage is fully
canonicalized, after which it should be deleted. Its preserved migration history does not override
the live `/3` → session `/2` → reviewed-story `/2` contract.
