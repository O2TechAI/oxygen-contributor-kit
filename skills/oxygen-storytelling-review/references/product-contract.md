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

## Story selection

Select Chapters by consequential state transition. Suitable signals include:

- problem discovery or clarified goal;
- baseline or measurement contract;
- surprising result;
- failure or blocked attempt;
- root cause;
- major decision or changed direction;
- architecture or execution-envelope change;
- quantitative change that altered interpretation;
- validation, freeze, handoff, or current-state conclusion.

Do not select by equal time, equal event count, equal message volume, one per conversation, or one per trajectory. Several Chapters may occur in a short period; quiet periods may have none. Deduplicate repeated discussion of the same durable transition.

Explicit reviewed Story annotations, when present and valid, outrank heuristic selection. A heuristic fallback should rank candidates globally for transition value, penalize routine status/procedure, deduplicate normalized meaning, then restore chronology.

Use 10–40 primary-project Chapters as the repository's normal envelope when enough reviewed history exists. Do not invent low-value Chapters merely to reach a count. The last Chapter must honestly describe the latest supported current state; if the evidence ends mid-investigation, say so.

Audit both ends of the narrative before accepting the selection. When reviewed evidence supports the initiating problem, goal, or baseline assumptions, the opening Chapter and Project Story overview must establish that beginning. Do not start a mature project Story at a midstream command failure, import-path fix, test-collection issue, or other routine setup incident merely because it is easy to summarize. Retain an operational failure only when the evidence shows that it changed a durable policy, measurement contract, architecture, execution envelope, or project direction.

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

### Narrative compression and voice

Every reviewed historical record available at the approved input boundary must be considered
during Story derivation, but not every record belongs in visible copy. Do not claim full-history
coverage unless that derivation actually considered the complete reviewed input. Keep routine
commands, repeated validation, status chatter, and low-impact implementation detail available
through Evidence while compressing the presentation around meaningful phases, causal turns,
failures, decisions, outcomes, and the current state.

The Project Story summary normally uses 2–3 concise sentences. It should establish where the
project began, name the major transformation or turn, and explain where the reviewed history ends.
It should represent the major trajectory without mechanically listing every Phase, repeating the
metrics shown below, or sounding like an implementation log. Optimize for project understanding
per sentence, not brevity that erases meaning.

Phase names behave like book-part names. Strongly prefer one or two scannable English words and an
equivalently compact natural Chinese label. Derive names from evidence; do not change supported
Phase selection merely to obtain prettier labels and do not treat example names as a taxonomy.

A Chapter should answer, in causal order: what was happening, what changed, why direction changed,
what followed, and why the Chapter matters. Setup / turn / what followed / what mattered are useful
editorial cues, not mandatory schema headings. Use short paragraphs, concrete nouns, active voice,
important technical facts, and material numbers. Preserve supported failure, disagreement, and
uncertainty. Remove audit-report voice, command-by-command narration, mechanical field enumeration,
and generic summary filler.

What mattered is normally one concise sentence derived from the Chapter's two to four strongest
supported facts or chips. It connects those facts to the larger trajectory rather than repeating
the article.

The inline AI insight remains interpretation, not history. Write its observation and reusable
lesson in one or two short, project-specific sentences that are concrete and memorable. Avoid
formulaic openings such as “This chapter demonstrates,” “The key takeaway is,” and “This highlights
the importance of,” plus abstract advice that could describe any project.

The governing standard is:

> Narrative coherence without fictionalization.

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

The Chapter header includes conventional Project Story Back, Chapter position, previous/next, review stage, phase, time/range, reading time, title, and a short why-read overview.

The default is the AI-compressed release draft. Original/local evidence is a secondary disclosure, not an equal reading mode. Do not render large Release/Original comparison cards.

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

Use a centered responsive article measure roughly comparable to `min(900px, 100%)`. Keep prose comfortable, do not stretch it across the workspace, and scope the width so the main Timeline remains unchanged.

## People

People appears first and stays compact:

```text
marker → role/name → one short description
```

Participant records use stable IDs, safe release labels (`A`, `B`, `C`, `AI`, or a safe role), localized role/description, and a local identity state. Markers use one consistent size, center their label, never wrap, and align AI with human participants.

Real/local identity may be used only when supported and permitted for local review. It never automatically becomes release identity. If identity is uncertain, keep it generic. Never fabricate a person or name.

## Story and inline AI insight

Render Story as one coherent article with short paragraphs, meaningful subheadings, bullets where scanning improves, and explicit uncertainty where supported. Internal fields such as scene, reconstruction, retained details, outcome, and significance help generate the article but must not appear as a dashboard of schema labels.

Exactly one structured, reviewable AI Highlight remains in each Chapter's data and lives inside Story at the relevant narrative point. Reject a Chapter with zero or multiple reviewable insights rather than silently rendering only the first. A restrained inline insight includes:

- a label such as AI insight or Turning point;
- explicit `AI interpretation · not historical fact` status;
- observation;
- reusable lesson;
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
