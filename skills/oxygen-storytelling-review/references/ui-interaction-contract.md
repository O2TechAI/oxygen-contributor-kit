# UI And Interaction Contract

## Application Shell

Reuse the existing local Viewer shell. The required final shell keeps top navigation, one left project/source rail, main canvas, Project Story Timeline, read-only Release Preview, Preferences, Evidence review, and download actions.

Privacy controls belong to each Chapter in the canonical Viewer; Release Preview is read-only. Candidate rows explain why
targets were flagged; only the contributor chooses the exact release bytes for each target.

Do not create a parallel page, second shell, project-bound renderer, replacement Privacy implementation, or standalone release tool.

## Project Story Timeline

The Project Story remains a table of contents:

```text
Project identity and overview
Chapters, Phases, and source orientation
Phase
Chapter date/type/title
Reserved Before -> After location: true values when supported, otherwise the English empty state
`No evidence-supported transition`
chips when supported
Evidence metadata and Read chapter
```

Keep the Timeline centered in the available canvas. On wide screens, a secondary Phase directory may help navigation; on narrow screens it collapses rather than squeezing the Story.

Values are derived from the current Story. Do not hardcode example counts, ports, paths, evidence IDs, project names, or screenshots.
The transition empty state is Timeline-only presentation. It never enters Story authority, Privacy
targets, reviewed release, HTML, or ZIP.

## Chapter Layout

When a Chapter opens, keep the application rail. Add only one compact Chapter selector in that rail:

- current Chapter / total;
- all ordered Chapter titles;
- active Chapter highlighted with useful focus state;
- Source records below;
- independent vertical scrolling when the list overflows.

The Chapter keeps compact People context, then this review order without numbered steps:

```text
Story and its separate AI Insight companion cards
Privacy drafts
Review summary
Apply review
```

Local Evidence remains a supporting disclosure. Review each Insight before staging Privacy choices. Do not add numbered section markers, tabs, steppers, standalone Insights dashboards, or Release/Original comparison cards.

## People

People appears first and stays compact:

```text
marker -> release-safe label/role -> short supported description
```

Markers are fixed-size and non-wrapping. Roles/descriptions are supported by Chapter Evidence. Local identity and release identity stay distinct. Do not fabricate names or relationships.

## Story Editing

Default to clean read mode. A compact accessible Edit control enters a contained Story Edit Mode.

The editor must support:

- caret insertion;
- selection replacement;
- Backspace/Delete;
- plain-text paste with markup/scripts stripped;
- synchronized Undo/Redo;
- Finish editing;
- notes tied to the exact affected Story block.

Every mutation must become a controlled direct edit transaction. Browser-native history, uncontrolled `contenteditable`, hidden textareas that bypass review state, or raw DOM mutation cannot be release authority.

Text selection in Story Edit Mode is a native editing operation. Do not open a floating Delete/Revise/Add action window. If a safe direct mutation crosses Story blocks, reject it visibly and preserve all text.

Imported exact-range review records may render as restrained notes only after validation. Notes are local review metadata and never enter release output.

## Insights

Insight is not Story prose. The Story paragraph remains in the left narrative column. Each Insight renders as a separate small card in the right-side companion column aligned with the exact paragraph or Story block it references. Multiple Insights for one paragraph stack in that paragraph's companion area. Responsive narrow layout may stack below the paragraph, but ownership and separate-card identity remain.

Do not insert Insights inline, append them into a generic Chapter-end list, or merge them into Story paragraphs.

Render Story independently of Insight count. If source AI Insights exist, render each one by stable ID with explicit Accept, Edit, and Do-not-preserve actions for the current version. Editing exposes optional Title plus Background, Quote, Directly Acquired Experience, and Principle.

A human may add an Insight only from safe reviewed Story text within one current Story block. Cross-block or foreign selection is rejected. Human Save records a `human:` Insight and approves that saved version without a redundant Accept.

Zero source Insights create no placeholder, empty approval card, or hidden obligation.

## Privacy Surface

The Privacy heading uses the same section heading as People and Story, followed by a brief natural introduction.
Show one compact card at a time for required human confirmation or a custom/stale edit, with 1/N progress
and previous/next navigation. Within the card, show Original, AI recommendation and reason, suggested
wording, then visually distinct Accept, Reject, and Edit buttons. Excerpts contain all changed sentences;
a native disclosure can reveal the full passage. Avoid repeated selected/proposed text and automatic-coverage lists.

Accept and Reject immediately stage choices through existing session persistence. Reject retains all
selectable original spans, with a nearby reminder that credentials stay hidden. Credential-only human
confirmation retains a safe Accept entry point. Saving an edit stages the full text for parent-owned
semantic recheck; the checked suggestion returns for acceptance. Choices advance to the next card and
remain available through previous/next navigation. Apply review commits Story, Insight and Privacy
together; no per-target PATCH writes. While Apply is pending, disable all current-Chapter review controls.

Release Preview is read-only, grouped by Chapter, with Local original and expected release wording.
Show initial suggestions before Apply and clearly distinguish staged choices, edits awaiting recheck,
and applied choices. Label the right-hand text by its actual source, highlight changes in the actual
expected text, and identify missing/stale passages instead of implying complete coverage. It contains
no editing or decision controls. HTML and ZIP still require all Chapters applied and human-confirmed.

## Evidence Navigation

The Evidence disclosure is local-only and secondary. It shows counts, primary/supporting references, exact document/event IDs, and an Inspect exact evidence action. Evidence content remains original-language.

Chapter -> Evidence records originating Chapter key, language, scroll position, evidence origin, and project. Back to chapter restores useful context and focus.

## Review Completion

Use one completion area with exactly one primary action for the current state:

- `reviewing`: Apply review;
- clean `revision_ready`: All set;
- `human_confirmed`: Reopen review.

Show stage, revision, summary counts, Privacy completion, blockers, and a local/not-publication note. Do not render competing completion buttons.

## Browser QA Expectations

Verify desktop and narrow layouts with the actual local Viewer. Capture final product screenshots for:

- Project Story Timeline;
- Chapter with rail, People, and Story read mode;
- Story Edit Mode with notes and Undo/Redo;
- Privacy states from the current target-choice authority;
- final Release Preview;
- Preferences;
- reviewed release HTML/ZIP output.

Inspect console errors, keyboard/focus behavior, horizontal overflow, active Chapter reachability, and final safe-content equivalence. Screenshots do not prove accessibility by themselves.

## Material Equivalence

An implementation is materially equivalent only when it preserves:

- local Viewer context;
- Story table-of-contents hierarchy;
- readable centered Chapter article;
- controlled direct editing and provenance;
- Chapter-local Privacy choices staged with the current review session;
- evidence navigation and original-language Evidence;
- Preferences as their own authority;
- Release Preview safe projection;
- HTML/ZIP release projection from the same serialized Story;
- `publication_approved=false`.

Content counts, wrapping, and spacing may vary. A dashboard, disconnected article, hidden review path, or summary-only flow is not equivalent.
