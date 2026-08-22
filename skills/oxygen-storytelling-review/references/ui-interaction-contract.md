# UI and interaction contract

## Application shell

Reuse the existing Viewer shell. Keep its top navigation, one left project/source rail, main canvas, Timeline, Release preview, Preferences, and download actions.

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

Use a readable article measure and stable semantic blocks. A useful editorial progression is:

```text
setup
→ turn
→ inline AI insight
→ what mattered
→ what followed
→ uncertainty
```

This wording may localize or adapt, but the reader must always understand what is being read and what follows. Prefer short paragraphs and bullets over card-per-paragraph layouts.

## Inline AI insight

Place the insight within Story near the relevant passage. Use a restrained margin/left-border annotation, not a large nested card.

Show:

- AI insight label;
- `AI interpretation · not historical fact`;
- title;
- observation;
- reusable lesson;
- Edit and Revise controls;
- quiet Accept and Do not preserve actions.

Direct edit may expose title/observation/lesson. Human-directed revise asks how it should change and updates the local representation. Do not build a full chat app.

## Text selection toolbar

The toolbar is temporary and anchored near the selected generated Story range. It contains accessible Delete, Revise, Add actions.

Selection requirements:

- exactly one noncollapsed selection;
- meaningful length;
- inside the Story article;
- both endpoints inside the same reviewable copy element;
- Chapter not human-confirmed.

Reject the selection otherwise. Keep toolbar controls from clearing the native range before the action is recorded. Revise/Add open a small contextual textarea with Save/Cancel; empty instructions cannot save.

Provide accessible names/tooltips. A focusable Story-block keyboard fallback may select the whole block when precise keyboard selection is not available; label it clearly and preserve exact whole-block offsets.

## Annotation presentation

Style only exact validated inline ranges, for example a restrained wavy underline. A small adjacent annotation note may show type/state, exact quote, instruction, and Cancel.

Do not underline the parent paragraph/list item. Do not fill the page with review cards. Keep multiple independent ranges independent.

Exact Evidence view must never expose the Story toolbar or mutation controls.

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
- inline AI annotation;
- temporary selection toolbar;
- one active Privacy interaction;
- one focused completion area;
- no numbered Chapter sections, separate Highlights, Release/Original cards, fake steppers, or nested dashboard cards.
