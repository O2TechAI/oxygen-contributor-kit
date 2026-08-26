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
- a short Chapter-specific summary that previews supported background, participant turn or judgment,
  and result/open boundary; repeated navigation boilerplate is invalid.

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
- one or more reviewed Evidence references in local review data;
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

Treat `beforeinput` as an optimization. Type-check every native event field before using it. When
`inputType`, `data`, or selection metadata is missing, derive one minimal mutation from the
controlled previous/next text and selection state. Commit composition/IME input once after the
composition result is stable, and never duplicate a transaction across `beforeinput` and `change`.

A useful editorial progression is:

```text
Background
→ Decision process
→ Result
→ Open questions
→ collapsed canonical AI insight
```

Use these standard localized terms. Keep supporting evidence/factors inside Decision process. Do
not render an empty heading or a heading whose only content is generic filler. Preserve enough causal and technical context for the Chapter to work as durable human
and future-Agent project memory; determine length from decision-relevant Evidence and do not impose
a global minimum or maximum. Keep long connected decision arcs in the same readable Story flow and
do not expand into raw logs. Prefer
coherent paragraphs and selective bullets over card-per-paragraph layouts.

## Inline AI Insight

On wide Chapter layouts, use a small restrained sticky panel to the right of the Story document.
Label it `AI insight` / `AI 洞察`; `Passage insight` and `段落洞察` are not reader-facing names.
Every complete canonical English Chapter supplies one valid `passageContext` for every rendered
English Story block. When Chinese exists, it supplies safe matching context for its rendered blocks
or the sidecar is omitted; missing Chinese never makes the English Chapter incomplete.
Order the exact complete key set by rendered Story-block order. Show current/total position plus
accessible Previous/Next controls; disable the unavailable boundary direction and do not wrap by
default. Arrow navigation updates the context, scrolls the stable owning block to a useful position,
highlights it, and clears the former highlight. Respect reduced-motion preference.
The explanation connects supported participant actions, responses, judgments, and consequences.
It never opens with a semantic-passage number or exposes block/schema metadata. End with the bounded
Reusable rule when supported.

Long Chapters must keep the Story column readable, the passage panel useful during scrolling, the
canonical Insight reachable, margin notes aligned to their owning blocks, the left Chapter
navigation independently scrollable, and the layout free of horizontal overflow. Preserve the same
access on narrow screens through the existing inline/collapsible treatment.

Clicking or focusing a reviewable block updates the same sequence position. It may
naturally present what was happening, the consequential tension/constraint, why a supported role acted,
what changed, and a grounded reusable principle as a coherent evidence-grounded explanation. Do not
truncate supported explanatory context to make this assistance concise, and do not generate a new
Insight from arbitrary selected text.

This panel is local reading assistance, never a second canonical Insight or runtime model call. It
must not create review state or enter release/export. On narrow screens, fold it into a compact
inline/collapsible surface without horizontal overflow or loss of access.

## Legacy canonical AI insight

For `oxygen.story-highlight/2`, place the Chapter's single reviewable insight in a disclosure at the end of Story, collapsed by
default. Import validation must fail closed on zero or multiple insights; do not build a
multi-insight fallback UI. Use a restrained disclosure, not a large nested card.

Show:

- AI insight label;
- an explicit AI-interpretation label separated from historical fact;
- title;
- Direct learning;
- Reusable rule;
- Edit and Revise controls;
- quiet Accept and Do not preserve actions.

Direct edit may expose title/observation/lesson. Human-directed revise asks how it should change and updates the local representation. Do not build a full chat app.

After Accept, immediately replace or visibly change the selected action to `Accepted — pending Apply review` and announce the status accessibly. Give Do not preserve an equivalent pending state. Keep the alternate decision available until Apply. After Apply, state that the decision was applied in the current revision. Never imply Saved, Final, or Published before those states exist. Feedback and pending counts must hydrate from the shared persisted review state in both languages.

## Successor sparse Insights

For `oxygen.story/3`, render Story independently of Insight cardinality and render every source AI
Insight as a stable-ID-owned card. Each card exposes `✓ Accept`, `Edit`, and `× Do not preserve` for
that exact current version. Editing exposes optional Title plus Background, safe Story-grounded
Quote, Directly Acquired Experience, and Principle. Saving an AI edit leaves the new version pending
until a later explicit Accept and Apply review. One unresolved source AI Insight keeps completion
blocked; zero source Insights create no empty card, placeholder, or approval obligation.

A human may select safe reviewed Story text within exactly one current Story block and invoke a
contextual Add Insight action. Cross-block or foreign selection is rejected without creating state.
The selection seeds the Quote grounding; the author supplies optional Title, Background, Directly
Acquired Experience, and Principle without a provider call. Human Save creates a stable `human:`
Insight and approves that saved version without a redundant Accept. AI and human provenance remain
visually distinct. All completion reasons come from the central successor evaluator and expose no
Insight or Evidence copy.

## Text selection behavior

For the legacy direct Story editor, selecting text in Story Edit Mode is a native editor operation. Typing replaces the selection and
Backspace/Delete removes it; both routes create the same controlled block-local transaction and note
as other direct edits. Focusing the owning block may synchronize passage assistance, but selection
itself must not trigger a re-render or open a floating Delete/Revise/Add action window. Default read
mode remains non-mutating.

The successor Add Insight action above is the only `/3` exception. It is not a generic selection
toolbar: native Selection remains transient, must resolve to one current Story block, and never
becomes durable review authority by itself.

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
- secondary sticky ordered inline-AI-Insight sequence on wide layouts and inline/collapsible fallback;
- one collapsed canonical AI Insight at the end of legacy Story, or stable sparse AI/human Insight cards for `/3`;
- native legacy selection replacement/deletion without a redundant action popover, plus only the bounded `/3` Add Insight exception;
- one active Privacy interaction;
- one focused completion area;
- no numbered Chapter sections, separate Highlights, Release/Original cards, fake steppers, or nested dashboard cards.

This is bounded visual fidelity rather than pixel equality. A future project may change content,
counts, wrapping, and content-driven height, but it must not substitute a dashboard, new visual
system, disconnected article, or summary-only flow for the canonical composition and interactions.
