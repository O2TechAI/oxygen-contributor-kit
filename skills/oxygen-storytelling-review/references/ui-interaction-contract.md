# UI and interaction contract

## Application shell

Reuse the existing Viewer shell. Keep its top navigation, one left project/source rail, main canvas, Timeline, Release preview, Preferences, and download actions.

The canonical repository entrypoints are `InlineWorkspace` in `viewer/app/workspace.tsx` and
`StoryChapterEditor` in `viewer/app/story-chapter-editor.tsx`. Their data/state dependencies are
the generalized modules in `viewer/lib/timeline.ts` and `viewer/lib/story-*`. Bind validated Story
metadata to those components. Do not create a parallel page, second shell, project-bound renderer,
or replacement privacy/release implementation merely because content differs.

When a Chapter opens, do not replace the shell with a disconnected full-width reading page. Keep the rail visible on desktop and usable in responsive stacked form on small screens.

## Project Story Timeline

Use the desktop workspace as three intentionally weighted regions:

```text
left: project/source navigation
center: centered Story Timeline
right: sticky Phase directory
```

The right directory exists only when meaningful phases exist and space permits. It lists short phase titles in order, scrolls the center Timeline to the selected phase, and marks the active/visible phase where practical. Hide or collapse it at narrower breakpoints instead of squeezing the Timeline or duplicating the left rail.

Keep project identity and orientation compact at the top of the center canvas. Preserve project name, overview, milestone count, phase count, reviewed-Highlight progress, and useful source/evidence context. Do not repeat that orientation inside a second giant project card.

Place the short localized “Read a Chapter…” direction inside the Story stream after orientation and
immediately before the first Phase. Give it a restrained accent/directional cue, not a card, banner,
Hero paragraph, or new section. The rest of the approved homepage composition remains unchanged.

Each phase heading is a clear narrative boundary. Each milestone card is a scan object with mandatory date, milestone type, visible AI-selected Highlight signal, concise title, unmistakable Before → After, intentional high-signal chips, then quiet evidence/read metadata. Do not render a paragraph-like Timeline summary when title + transition + chips already communicate the Chapter. Long explanation remains in the Chapter.

Before/After should read as two short states separated by a clear directional cue. Chips use the existing accent color and remain compact; they are not decorative tags or a substitute for unsupported facts.

## Chapter rail

Inside the existing rail, add one compact Chapter context block only while a Chapter is open:

- current Chapter / total;
- all ordered Chapter titles;
- active Chapter visibly highlighted and `aria-current="page"` where appropriate;
- Source records remain below.

The Chapter list itself is a bounded independent vertical scrolling region:

- `overflow-y: auto`;
- visible scrollbar on overflow;
- contained overscroll;
- viewport-responsive maximum height;
- mouse wheel and trackpad scroll the list, not the article;
- all Chapters are directly reachable;
- active item scrolls into view with nearest behavior after direct/programmatic navigation.

Do not create a second sidebar or make only the entire rail scroll.

## Chapter chrome

Show:

- conventional upper-left `← Project story`;
- Chapter n / total;
- previous and next controls with disabled endpoints;
- review stage/revision;
- phase;
- timestamp/range;
- approximate reading time;
- title;
- one-sentence overview.

Back restores stored Timeline scroll and focus to the originating Read chapter action.

Use one responsive Chapter outer-canvas token/class for chrome, Hero/title, People, Story grid,
Privacy, local Evidence, and completion. Those surfaces share visible left/right boundaries. Margin
notes + document + passage panel form an internal Story grid inside that canvas; prose keeps a
comfortable reading measure. Collapse consistently without horizontal overflow.

## Chapter sections

Render exactly three primary content sections:

```text
People
Story
Privacy
```

Then render secondary local Evidence disclosure and the Review completion area. Do not count those as numbered workflow steps.

Use semantic headings/regions. Hide/remove all numeric section markers. Do not add tabs, a stepper, or a standalone Highlights section.

## People layout

Use compact rows, not cards:

- fixed consistent marker, normally about 36px;
- centered non-wrapping release label;
- role/name on a clean scan line;
- one short description;
- quiet local-identity/export note.

Keep AI aligned with human rows. On narrow screens, preserve marker integrity before compressing text.

## Story layout

Use a readable article measure and stable semantic blocks. The default is a clean read mode. Add a
compact accessible pencil/Edit control in the Story heading; it enters a clearly contained review
surface while leaving the semantic block model and review ledger authoritative. The editing frame
must explicitly say that the user can click and type, select to replace/delete, and that each change
becomes a note. Show visible labeled Undo, Redo, and Finish editing controls with accessible disabled
reasons. Direct editing is the sole user-facing Story mutation path; do not open Delete/Revise/Add
windows from a text selection. Do not use an uncontrolled textarea or `contenteditable` mutation path.

Use a controlled plain-text editor per stable Story block or an equivalent controlled document
surface. Support caret insertion, selection replacement, Backspace/Delete, ordinary keyboard
navigation, and paste that strips markup/scripts/embeds while preserving safe text and paragraph
breaks. Synchronize every mutation and Ctrl/Cmd+Z, Ctrl/Cmd+Y, and Ctrl/Cmd+Shift+Z with the review
transaction ledger. Reject unsafe cross-block mutation visibly without partially applying it.

A useful editorial progression is:

```text
setup
→ turn
→ what mattered
→ what followed
→ uncertainty
→ collapsed canonical AI insight
```

This wording may localize or adapt, but the reader must always understand what is being read and
what follows. Preserve enough causal and technical context for the Chapter to work as durable human
and future-Agent project memory; do not force a minimum word count or expand into raw logs. Prefer
coherent paragraphs and selective bullets over card-per-paragraph layouts.

## Contextual passage assistance

On wide Chapter layouts, use a small restrained sticky panel to the right of the Story document.
Every complete Chapter supplies one valid `passageContext` for every rendered Story block in both
languages; missing support makes the Chapter incomplete rather than producing an empty panel.
Order the exact complete key set by rendered Story-block order. Show current/total position plus
accessible Previous/Next controls; disable the unavailable boundary direction and do not wrap by
default. Arrow navigation updates the context, scrolls the stable owning block to a useful position,
highlights it, and clears the former highlight. Respect reduced-motion preference.

Clicking or focusing a reviewable block updates the same sequence position. It may
naturally present what was happening, the consequential tension/constraint, why the team acted,
what changed, and a grounded reusable principle as a concise mini-story rather than a mechanical
field dump. Do not generate a new Insight from arbitrary selected text.

This panel is local reading assistance, never a second canonical Insight or runtime model call. It
must not create review state or enter release/export. On narrow screens, fold it into a compact
inline/collapsible surface without horizontal overflow or loss of access.

## Canonical AI insight

Place the Chapter's single reviewable insight in a disclosure at the end of Story, collapsed by
default. Import validation must fail closed on zero or multiple insights; do not build a
multi-insight fallback UI. Use a restrained disclosure, not a large nested card.

Show:

- AI insight label;
- `AI interpretation · not historical fact`;
- title;
- observation;
- reusable lesson;
- Edit and Revise controls;
- quiet Accept and Do not preserve actions.

Direct edit may expose title/observation/lesson. Human-directed revise asks how it should change and updates the local representation. Do not build a full chat app.

## Text selection behavior

Selecting text in Story Edit Mode is a native editor operation. Typing replaces the selection and
Backspace/Delete removes it; both routes create the same controlled block-local transaction and note
as other direct edits. Focusing the owning block may synchronize passage assistance, but selection
itself must not trigger a re-render or open a floating Delete/Revise/Add action window. Default read
mode remains non-mutating.

If a safe direct mutation would cross semantic Story blocks, reject it visibly and preserve every
block. Existing valid legacy annotation records may still render for compatibility, but the Chapter
does not expose a creation toolbar for them.

## Review-note presentation

Style only exact validated annotation/direct-edit ranges, for example a restrained wavy underline.
On desktop, place one restrained note per meaningful transaction in the Story's left margin beside
the owning stable block. It may show only operation/state/language, concise before→after or quote,
human instruction, and valid Discard/Revert/review action. Never show offsets, raw IDs/JSON, or
implementation metadata. Clicking the note scrolls/focuses its block and exact range without
changing release content. On narrow screens, render the same note as a compact block-associated
inline strip or drawer without narrowing the Story or causing horizontal overflow.

Language switching keeps notes from both locales inspectable and labels their source locale. Exact
range styling and editor selection remain active-locale only; an opposite-locale note may focus its
stable semantic block but must not select an unrelated translated range.

Do not underline the parent paragraph/list item. Do not fill the page with review cards. Keep multiple independent ranges independent.

Leaving Edit Mode clears only transient editor state. Pending, applied, needs-evidence,
reverted, and cancelled ledger entries remain intact. Pending direct work exposes Discard; applied
work exposes Revert in a new revision, never destructive cancellation.

Exact Evidence view must never expose Story mutation controls.

## Privacy decision surface

Render one active candidate at a time with:

- progress (`n / total`);
- title;
- Local original or explicit unavailable message;
- source-language label when an excerpt exists;
- Why AI flagged it;
- Keep;
- Redact.

Do not render Suggested Release, an AI rewrite field, or a recommendation sentence. Human owns the decision.

After Keep/Redact, advance to the next undecided candidate. Completion shows reviewed / total and an optional Review again action before human confirmation. Review again clears candidate decisions and returns the Chapter to reviewing.

## Evidence disclosure and return

Place a collapsed `View local evidence →` after primary Chapter content. When opened, show:

- local-only/original-language note;
- evidence count;
- primary anchor;
- supporting references;
- exact document/event IDs;
- Inspect exact evidence action.

Opening Evidence records Chapter key, language, Story scroll position, evidence origin, and project. Reuse the existing Release preview and focus the exact reviewed event.

Evidence view provides a prominent `← Back to chapter` that restores the originating Chapter, language, and useful Story context. Reopen the local-Evidence disclosure and return focus to the exact primary/supporting control that launched Evidence; use a safe fallback only when that control no longer exists. This is separate from Chapter → Project Story Back.

## Review completion

Use a lightweight area separated by a stronger divider. Show stage/revision, summary counts, Privacy completion, human-authority/safety note, blockers, and exactly one primary action appropriate to state:

- reviewing: Apply review;
- clean revision_ready: All set;
- human_confirmed: Reopen review.

Do not render multiple competing completion buttons.

## Responsive and accessibility contract

- Keep article within viewport with responsive gutters and no horizontal overflow.
- Stack rail above article on compact screens without hiding Chapter selector/Source records.
- Keep Chapter list independently scrollable with a smaller viewport-relative maximum.
- Use semantic dialog/regions/headings/nav/list structure.
- Preserve visible focus, disabled state, accessible names, and conventional Back labels.
- Restore focus after Chapter → Project Story Back.
- Do not claim full accessibility compliance from screenshots; exercise keyboard/focus behavior.

## Visual acceptance

Material equivalence requires:

- retained sidebar and project context;
- readable centered article, neither narrow strip nor full-width prose;
- clear typography/whitespace hierarchy;
- compact aligned People;
- default read mode plus a compact pencil/Edit control and zero-guesswork controlled editing surface;
- synchronized Undo/Redo and left-margin edit/annotation notes with a compact responsive fallback;
- secondary sticky ordered passage-context sequence on wide layouts and inline/collapsible fallback;
- one collapsed canonical AI Insight at the end of Story;
- native selection replacement/deletion without a redundant action popover;
- one active Privacy interaction;
- one focused completion area;
- no numbered Chapter sections, separate Highlights, Release/Original cards, fake steppers, or nested dashboard cards.

This is bounded visual fidelity rather than pixel equality. A future project may change content,
counts, wrapping, and content-driven height, but it must not substitute a dashboard, new visual
system, disconnected article, or summary-only flow for the canonical composition and interactions.
