# Product contract

## Product outcome

Storytelling Review turns a reviewed project history into a narrative table of contents and document-style Chapter editor:

```text
reviewed project history
→ Project Story
→ evidence-linked Chapters
→ iterative human-AI review
→ human-confirmed Final Release Memory
```

It must serve both a human who wants an understandable account and a future agent that needs evidence-grounded lessons. It is not an event browser with new styling, and Final Release Memory is not publication approval.

## Productization boundary

The repository Skill and Viewer are one reusable capability, not a template for a new standalone
application. In this Toolkit, reuse `InlineWorkspace` in `viewer/app/workspace.tsx`,
`StoryChapterEditor` in `viewer/app/story-chapter-editor.tsx`, and the shared Timeline/review/
evidence/navigation/release primitives under `viewer/lib`. Generate validated Story data and bind
it to that runtime. Change the renderer only to close a proven generalized capability gap.

Keep these product constraints stable across projects: application shell, editorial hierarchy,
phase-grouped Timeline, Chapter review interactions, privacy/evidence boundaries, bilingual shared
state, and publication separation. Keep these values dynamic: project name/overview, Chapters,
Phases, dates, People, prose, insights, Privacy candidates, metrics/chips, evidence IDs, and review
progress. Golden examples and their counts are never reusable constants.

## Safe workflow progress

The existing Viewer loading treatment is also the contributor's workflow-progress surface. Derive
its stages from the actual prepare → organize → privacy → Story → human review → release-handoff
workflow. Show only sanitized operational facts: stable stage/status codes, completed/current/next
state, justified counts, timestamps, blocker codes, and whether human action is required. Persist
those facts in existing workflow/runtime state so refresh can hydrate them and provide a quiet shell
action to reopen the surface.

Never expose chain-of-thought, hidden reasoning, prompts, scratchpad, raw model output, raw tool
arguments, private agent messages, Story/Evidence content, removed values, or other private workflow
material. Do not invent a percentage when no real denominator exists.

The server's initial render and the mounted client's polling use that same persisted projection.
Before readiness, refresh remains on Build Progress. When atomic activation reaches Review Story,
the already-open tab loads the activated Story snapshot and reveals it within the normal polling
interval; manual refresh, tab reopening, or evaluator intervention is never part of the product
boundary.

## Story selection

Select Chapters by meaningful project development. A milestone may record a consequential change,
durable progress, a substantive iteration, or a failure that established a useful project state.
Judgment moments are important causal units inside many Chapters. Other eligible milestones include
durable progress, substantive iteration, and consequential failure. Suitable signals include:

- supported project foundation or first usable capability;
- problem discovery or clarified goal;
- baseline or measurement contract;
- verifiable progress that created a durable capability, artifact, or coverage boundary;
- a substantive iteration that changed quality, coverage, implementation, or understanding;
- surprising result;
- failure or blocked attempt that changed the diagnosis, next action, or retained constraints;
- root cause;
- major decision or changed direction;
- architecture or execution-envelope change;
- quantitative change that altered interpretation;
- validation, recovery, freeze, handoff, or current-state conclusion.

Do not select by equal time, equal event count, equal message volume, one per conversation, one per
trajectory, or a target Chapter count. Several Chapters may occur in a short period; quiet periods
may have none. Keep separate milestones when each establishes a distinct durable state needed to
understand the project's progress. Combine them only when they belong to one connected causal arc.
Deduplicate repeated discussion of the same state or result.

Explicit reviewed Story annotations, when present and valid, outrank heuristic selection. A
heuristic fallback should rank candidates globally for development value, penalize routine
status/procedure, deduplicate normalized meaning, then restore chronology. A message that merely
says work is continuing is routine status. A completed capability, evidence-backed improvement,
substantive iteration, diagnostic failure, or recovery is meaningful progress.

Do not invent low-value Chapters to reach a count or discard supported milestones to stay below one.
Use the number required by the reviewed history and reviewability. The last Chapter must honestly
describe the latest supported current state; if the evidence ends mid-investigation, say so.

Audit the full milestone set before accepting the selection. When reviewed evidence supports the
initiating problem, goal, or baseline assumptions, the opening Chapter and Project Story overview
must establish that beginning. Do not start a mature project Story at a midstream command failure,
import-path fix, test-collection issue, or other routine setup incident merely because it is easy
to summarize. Retain an operational failure when it produced a durable diagnostic result, recovery
rule, policy, measurement contract, capability, architecture, execution envelope, or direction
change. Confirm that meaningful progress and substantive iterations have not been removed merely
because they contain no disagreement or pivot.

## Narrative construction

The Story should let a reader understand:

- why the project began;
- what people were trying to accomplish;
- which assumptions existed;
- what surprised them;
- where work failed or disagreement mattered;
- what caused a change in direction;
- what was decided and what followed;
- what was learned;
- how the project arrived at its current state.

Prioritize causal transitions and consequential moments. Compress routine commands, repeated implementation narration, ordinary test execution, and minor details that did not affect direction. Preserve technical terms, meaningful metrics, failures, uncertainty, disagreement, and evidence semantics.

Never turn a small remark into a turning point without evidence. Never rewrite uncertainty or a blocked round into a successful conclusion.

### Context retention and voice

Use this product hierarchy:

```text
Project Story = scan-first navigation
Chapter Story = context-complete durable project memory
Exact Evidence = verification
AI Insight = learning and bounded reusable rules
```

For Chapter Story, apply these requirements:

1. decision-relevant context coverage;
2. factual and Evidence fidelity;
3. readability;

Brevity is not a Chapter objective. Retain every reviewed-Evidence-supported unit that materially
explains the current milestone's background, causal or temporal relationships, participant
interaction, judgment, failed attempt, progress or iteration, or result.

Every reviewed historical record available at the approved input boundary must be considered
during Story derivation, but not every record belongs in visible copy. Do not claim full-history
coverage unless that derivation actually considered the complete reviewed input. Omit a reviewed
unit from Chapter copy only when it duplicates retained meaning, lies outside the current milestone
boundary, is withheld by Privacy, or contributes no explanation of background, relationship,
interaction, judgment, failure, progress, or result. Routine commands, repeated validation, status
chatter, and implementation detail must remain when they explain one of those dimensions.

Prove this classification at source-unit granularity. Extract reviewed conversational turns and
independently meaningful nested reviewed turns from every Evidence event in the milestone boundary.
Give each unit a stable digest identity without retaining its text in validation metadata. Map each
represented unit to the factual claim and Story block that carries it; otherwise record exactly one
fixed exclusion reason: duplicate meaning, routine status with no explanatory contribution, outside
the milestone, or Privacy withheld. One Evidence event can contain several distinct units, so a
large claim-trace count that repeatedly cites the same event is not context coverage.

The Project Story summary normally uses 2–3 concise sentences. It should establish where the
project began, name the major transformation or turn, and explain where the reviewed history ends.
It should represent the major trajectory without mechanically listing every Phase, repeating the
metrics shown below, or sounding like an implementation log. Optimize for project understanding
per sentence, not brevity that erases meaning.

Phase names behave like book-part names. Strongly prefer one or two scannable English words and an
equivalently compact natural Chinese label. Derive names from evidence; do not change supported
Phase selection merely to obtain prettier labels and do not treat example names as a taxonomy.
Each Phase must represent one coherent problem/transition class with a concise evidence-derived
rationale. Review neighboring boundaries before activation. One Phase is legitimate when all
selected Chapters share that class; a generic fallback such as `Project evolution` is not evidence
of coherence and fails activation.

A Chapter is durable project memory for humans and future Agents. Without reopening Evidence merely
to recover the basic Story, it should provide enough supported context to understand the problem,
why it mattered, constraints, prior attempts, failures or rejected approaches, evidence that changed
the direction, the decision and its supported rationale, the action that followed, the result,
remaining uncertainty, and what should be remembered. Not every Chapter needs a separate heading for
every element, but material elements present in the evidence must not disappear merely to minimize
word count.

Chapter length is determined by the Evidence required to reconstruct the meaningful project
change. Do not impose a global word, character, paragraph, or sentence maximum. A Chapter is shorter
only when the reviewed Evidence genuinely contains fewer explanatory relationships. A connected arc containing alternatives, disagreement,
failure, diagnosis, correction, implementation, validation, and uncertainty may require several
substantial paragraphs. Keep connected judgment moments together when they address the same
problem and causal sequence. Keep unrelated decisions in separate Chapters.

Preserve all supported participants, starting positions, alternatives, objections, corrections, failed
attempts, decision-changing Evidence, owner or reviewer interventions, constraints, numerical
results, architecture and scope decisions, approvals or rejections, implementation consequences,
later results, and unresolved questions. Repeated commands, routine tool activity, status chatter,
duplicate confirmations, and reruns may be omitted only when they add no explanatory background,
relationship, interaction, judgment, failure, progress, or result. The governing distinction is the
unit's explanatory contribution to the current milestone.

Decision process must connect supported People to the causal sequence. Use functional roles to show
who raised or framed the issue, who performed the action, who questioned or corrected it when
supported, who approved or accepted a result when supported, and what changed afterward. A useful
interaction may be an owner instruction followed by an implementation report; it need not contain
disagreement. When Evidence contains proposal → objection → revision → agreement, preserve that
sequence. When it does not, omit the missing turn. Never invent a reply or consensus to make the
Chapter feel interactive, and do not substitute generic `the team` for a supported role.

Determine the actual semantic relationship first, then express it with the most natural sentence
construction. A connective adverb is optional. Do not require a transition word in each sentence
or paragraph, and do not validate the prose against a canonical connector list. Sequence, cause,
response, contrast, correction, evidence, limitation, and continuation wording must not claim a
stronger relationship than the reviewed Evidence supports. Prefer syntactic clarity over mechanical
thesaurus substitution. Repeated sentence-opening connectives are an editorial concern, not a
brittle readiness rule. This does not relax the separate prohibition on `X, not Y` and equivalent
contrast formulas or the requirement that every Chapter overview be distinct.

Use setup, attempt, problem, turn, consequence, and significance only as internal coverage cues.
The visible schema headings remain Background, Decision process, Result, and Open questions. Use coherent paragraphs, concrete nouns, active voice, important
technical facts, and material numbers. A Chapter may contain several substantial paragraphs when
the evidence requires them. Remove audit-report voice, command-by-command narration, mechanical
field enumeration, generic summary filler, and repeated test/status noise that adds no learning.

The canonical AI Insight is explicitly labeled interpretation. Historical facts remain in Story and
Exact Evidence. Its Direct learning and Reusable rule
may be fuller when needed to preserve a grounded pattern, but must stay project-specific and avoid
formulaic openings or abstract advice that could describe any project. Final reviewed Chapters may
carry evidence-backed visible rationale, mistakes, corrections, human overrides, rejected
approaches, successful patterns, and outcomes forward to future Agents. Never preserve private
latent model reasoning as Story.

The governing standard is:

> Context-complete project memory without fictionalization.

Never invent dialogue, emotion, motivation, certainty, causality, or retrospective outcomes that
the reviewed evidence does not support.

## Project Story page

Retain the existing application shell and its project/source rail. Use a centered responsive Timeline column in the remaining canvas. Do not fill that canvas with one giant project card or leave the Timeline visibly pinned to one edge.

The top of the Project Story must retain a concise orientation area containing, when available:

- canonical project name;
- short project-story overview;
- number of meaningful milestones / Chapters;
- number of narrative phases;
- reviewed-Highlight progress;
- source-record / evidence context when useful.

These are mandatory information categories, not optional visual decoration. Derive values from the current project Story; never hardcode example counts. Keep the treatment typographic and compact rather than repeating the same identity in a second dominant full-width project card.

The homepage is a table of contents, not a compressed Chapter. Preserve this reading hierarchy:

```text
Project identity / overview
→ milestones · phases · reviewed-Highlight progress
→ Phase
→ Milestone: date · type · AI Highlight · title · Before → After · chips
→ evidence metadata / Read Chapter
```

When reviewed evidence supports meaningful narrative phases, every milestone belongs visibly to one phase. Phase headings/boundaries must be stronger than ordinary card metadata. Do not force a fixed phase count or invent phases. On desktop, add a lightweight sticky right-side Phase directory that lists the generated phases in order, scrolls directly to them, and indicates the active/visible phase where practical. It remains secondary to the Timeline and collapses rather than creating three cramped columns on narrow screens.

Every selected milestone card must show:

- date (mandatory; time is optional);
- milestone/change type;
- an unmistakable visible AI-selected Highlight label/marker;
- short Chapter title;
- concise Before → After state transition;
- high-signal keyword/metric/version/status chips when supported;
- evidence count and Read Chapter as secondary metadata/actions.

Before and After are short state descriptions, not paragraph summaries. The reader must see old state/problem → new state/decision/capability within seconds. Move long summary, lesson, reasoning, and narrative prose into the Chapter. A Timeline card should usually not need a separate explanatory paragraph once title, transition, and chips are strong.

Use small accent chips as intentional information-compression anchors for evidence-backed benchmark counts, metrics, versions, named concepts, or important status changes. Split compound metrics into individually scannable chips where useful. Do not create chips for generic low-value words, repeat the title in chips, or add chips on top of unchanged prose.

Do not expose raw Story schema, make the Timeline feel like an event database, or substitute a long article-style Project Story homepage for this hierarchy.

## Chapter page

Keep the left rail and readable article together. The Chapter has:

```text
People

Story

Privacy

Review status / completion
```

These are natural document sections, not sequential steps. Use headings, whitespace, and restrained dividers. Do not show numeric section markers, tabs, a wizard, or a stepper.

The Chapter header includes conventional Project Story Back, Chapter position, previous/next,
review stage, phase, time/range, reading time, title, and a short Chapter-specific summary. The
summary previews the supported background, consequential participant turn or judgment, and result
or open boundary. It must differ across Chapters, avoid generic navigation instructions, and remain
Evidence-traced. Concrete nouns, active verbs, specific constraints, and varied sentence rhythm make
it engaging without invented wit, dialogue, emotion, motive, metaphor, or causal certainty.

The default is a clean reading view of the AI-prepared release draft. Original/local evidence is a
secondary disclosure, not an equal reading mode. Do not render large Release/Original comparison
cards. Give the reader restrained guidance for Read → optional Story Edit → Insight → Privacy →
Apply review → All set without turning the Chapter into a stepper.

## Visual language

Apply this rule:

> Typography for reading. Boxes for interaction.

Use typography and whitespace for People, Story, headings, metadata, and explanatory copy. Use bounded surfaces only when interaction benefits from containment: contextual editors, active Privacy decision, and focused completion feedback.

Avoid nested boxes, card-per-field layouts, dashboard density, permanent text-review toolbars, and giant uninterrupted prose. The Chapter should read like a well-edited document or strong structured answer.

Golden Design Reference v1 establishes bounded composition and behavior, not private fixture copy
or pixel constants. Retain the left navigation rail, centered editorial content, secondary sticky
Phase directory on wide layouts, warm off-white surface, serif reading hierarchy, sans-serif
controls, restrained Oxygen green/blue-violet accents, and boxes-only-for-interaction rule. Natural
wrapping, project-driven height/counts, font fallback, and small spacing differences may vary.

Use a centered responsive Chapter composition with a dominant readable document, a small annotation
margin, and a secondary contextual panel where space permits. Keep prose comfortable, do not stretch
it across the workspace, and scope the width so the main Timeline remains unchanged. On narrower
screens, fold annotation notes and contextual assistance inline without horizontal overflow.

## People

People appears first and stays compact:

```text
marker → role/name → one short description
```

Participant records use stable IDs, safe release labels (`A`, `B`, `C`, `AI`, or a safe role), localized role/description, and a local identity state. Markers use one consistent size, center their label, never wrap, and align AI with human participants.

Real/local identity may be used only when supported and permitted for local review. It never automatically becomes release identity. If identity is uncertain, keep it generic. Never fabricate a person or name.

## Story, inline AI insight, and canonical AI insight

Render Story as one coherent article with readable paragraphs, meaningful subheadings, bullets where
scanning improves, and explicit uncertainty where supported. Internal fields such as scene,
reconstruction, retained details, outcome, and significance help generate the article but must not
appear as a dashboard of schema labels.

Read mode is the default. A compact accessible pencil/Edit control enters a contained Story Edit
Mode. It may look like an editable document, but stable semantic blocks, exact ranges, annotations,
and revision provenance remain authoritative; do not use uncontrolled `contenteditable` mutation.
Show annotation notes in the left margin beside their block on wide screens and in a compact
block-associated inline treatment on narrow screens. Notes are local review metadata and never
enter release output.

Mandatory precomputed evidence-grounded `passageContext`, keyed by every stable rendered Story
block, drives a small sticky right-side reading companion labeled `AI insight` / `AI 洞察`. The
canonical English Chapter requires the exact complete key set. When Chinese exists, its safe
rendered blocks require their matching context or the sidecar is omitted; Chinese absence never
blocks English readiness. A canonical Chapter with unsupported or missing English passage context
is incomplete; never render it through a silent empty or generic fallback. Clicking or selecting a
passage changes that local panel. It may
explain what was happening through supported participant interaction, why the moment mattered,
what became clearer, and a reusable rule. It never begins with a passage ordinal, `semantic passage`,
block ID, schema name, or other implementation metadata,
conservatively omitting claims the reviewed context cannot support. It is not another reviewable or
release Insight and is excluded from export by default.

Exactly one structured, reviewable AI Highlight remains in each Chapter's data. Present its full
content in a disclosure at the end of Story, collapsed by default. Reject a Chapter with zero or
multiple reviewable insights rather than silently rendering only the first. The canonical insight
includes:

- a label such as AI insight or Turning point;
- explicit `AI interpretation · not historical fact` status;
- observation;
- reusable rule;
- lightweight accept/remove/direct-edit/human-directed revision affordances.

There is no standalone top-level Highlights section.

## Unaffected Viewer behavior

Storytelling must preserve:

- local-only Viewer boundary;
- project/source records;
- Release preview and exact-source focus;
- Preferences and their stored answers;
- package/export contract;
- organization state;
- publication separation.

Do not require backend rewrites merely to render Storytelling Review.
