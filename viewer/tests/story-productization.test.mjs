import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { syntheticStoryEvents, syntheticStoryProject } from "./fixtures/synthetic-story-project.mjs";
import { buildReviewedStoryRelease } from "../lib/story-release.ts";
import { applyChapterReview, emptyChapterReview, markChapterReady } from "../lib/story-review.ts";
import {
  STORY_PREFIX,
  parseStoryAnnotation,
  resolveEvidenceTarget,
  selectProjectTimeline,
  storyReleaseTargetCatalog,
} from "../lib/timeline.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("a non-Golden synthetic project exercises dynamic Story shapes", () => {
  const milestones = selectProjectTimeline(syntheticStoryEvents);
  assert.equal(syntheticStoryProject.name, "Harbor Sensor Calibration");
  assert.equal(milestones.length, 3);
  assert.equal(new Set(milestones.map((milestone) => milestone.story.phase)).size, 2);
  assert.ok(milestones.every((milestone) => milestone.story.reviewPresentation.en.phase.split(/\s+/).length <= 2));
  assert.ok(milestones.every((milestone) => milestone.story.reviewPresentation.en.story.importantDetails.length === 1));
  assert.deepEqual(milestones[0].story.reviewPresentation.projectSummary, syntheticStoryProject.overview);
  const malformedSummary = JSON.parse(syntheticStoryEvents[0].summary.slice(STORY_PREFIX.length));
  malformedSummary.reviewPresentation.projectSummary = null;
  assert.equal(parseStoryAnnotation(STORY_PREFIX + JSON.stringify(malformedSummary)), null);
  assert.deepEqual(milestones.map((milestone) => milestone.story.reviewPresentation.en.people.length), [1, 2, 1]);
  assert.deepEqual(milestones.map((milestone) => milestone.story.reviewPresentation.en.privacy.candidates.length), [0, 1, 1]);
  assert.ok(milestones.every((milestone) => milestone.story.reviewPresentation.en.highlights.length === 1));
  assert.ok(milestones.every((milestone) => milestone.story.reviewPresentation.zh.highlights.length === 1));
  assert.deepEqual(milestones.map((milestone) => milestone.story.evidence.primary.eventId), [
    "synthetic-reviewed-document:synthetic-evidence-alpha",
    "synthetic-reviewed-document:synthetic-evidence-beta",
    "synthetic-reviewed-document:synthetic-evidence-gamma",
  ]);

  const reviewedItems = syntheticStoryEvents.map((event) => ({ id: `${event.document_id}:${event.id}` }));
  for (const milestone of milestones) {
    assert.equal(resolveEvidenceTarget(reviewedItems, milestone.story.evidence.primary.eventId).status, "resolved");
  }
});

test("active contracts align Story-first semantics with the live versioned workflow", async () => {
  const [skill, product, data, bilingual, validation, narrative, ui, lifecycle, migration] = await Promise.all([
    read("../../skills/oxygen-storytelling-review/SKILL.md"),
    read("../../skills/oxygen-storytelling-review/references/product-contract.md"),
    read("../../skills/oxygen-storytelling-review/references/story-data-contract.md"),
    read("../../skills/oxygen-storytelling-review/references/bilingual-contract.md"),
    read("../../skills/oxygen-storytelling-review/references/validation-checklist.md"),
    read("../../skills/oxygen-storytelling-review/references/narrative-writing-contract.md"),
    read("../../skills/oxygen-storytelling-review/references/ui-interaction-contract.md"),
    read("../../skills/oxygen-storytelling-review/references/chapter-review-lifecycle.md"),
    read("../../skills/oxygen-storytelling-review/references/story-first-successor-contract.md"),
  ]);
  const activeContracts = [skill, product, data, bilingual, validation, narrative, ui, lifecycle].join("\n");

  assert.match(skill, /oxygen\.story\/3/);
  assert.match(data, /prefix: oxygen\.story\/3:[\s\S]*schema: oxygen\.story\/3/);
  assert.match(skill, /oxygen\.story\/3[\s\S]*deterministic source readiness[\s\S]*atomic workflow activation[\s\S]*oxygen\.story-review-session\/2[\s\S]*SuccessorStoryChapterEditor[\s\S]*oxygen\.reviewed-story\/2/i);
  assert.match(product, /oxygen\.story\/3[\s\S]*deterministic source readiness[\s\S]*atomic workflow activation[\s\S]*oxygen\.story-review-session\/2[\s\S]*successor Viewer review[\s\S]*oxygen\.reviewed-story\/2/i);
  assert.match(data, /oxygen\.story\/3[\s\S]*oxygen\.story-review-session\/2[\s\S]*oxygen\.reviewed-story\/2/i);
  assert.match(skill, /source readiness[\s\S]{0,180}(?:is not|not)[\s\S]{0,120}human review completion/i);
  assert.match(product, /oxygen\.story-highlight\/2[\s\S]*oxygen\.story-review-session\/1[\s\S]*oxygen\.reviewed-story\/1/i);
  assert.match(lifecycle, /canonical live contract is `oxygen\.story\/3`[\s\S]*`oxygen\.story-review-session\/2`[\s\S]*`oxygen\.reviewed-story\/2`/i);
  assert.match(activeContracts, /understand the complete approved project history[\s\S]*determine coherent Chapter narrative arcs[\s\S]*write the complete ordered Chapter and Project Story narrative[\s\S]*verify continuity, chronology, attribution, Evidence[\s\S]*group adjacent Chapters[\s\S]*only after the complete Story is understood[\s\S]*zero or more Insights/i);
  assert.match(activeContracts, /complete coherent narrative arc/);
  assert.match(activeContracts, /Every Chapter (?:requires|retains|has) at least one (?:supported|Evidence-supported|evidence-supported) Person or actor/i);
  assert.match(activeContracts, /Chapter boundaries[\s\S]*before[\s\S]*Phase|After[\s\S]*ordered Chapter sequence[\s\S]*group adjacent Chapters/i);
  assert.match(activeContracts, /0\.\.n/);
  assert.match(activeContracts, /no (?:minimum|semantic minimum)[\s\S]*(?:maximum|quota|density target)/i);
  assert.match(activeContracts, /exactly (?:these )?four semantic meanings[\s\S]*Background[\s\S]*Quote[\s\S]*Directly Acquired Experience[\s\S]*Principle/i);
  assert.match(activeContracts, /Insight title is optional presentation metadata/i);
  assert.match(activeContracts, /Passage assistance[\s\S]*optional[\s\S]*human-facing[\s\S]*non-authoritative/i);
  assert.match(activeContracts, /does not require a (?:per-block )?lesson|No Story block (?:is required to|must) contain/i);
  assert.match(activeContracts, /Quote[\s\S]*safe reviewed Story[\s\S]*(?:never|not) cop(?:y|ied) raw\/private Evidence/i);
  assert.match(activeContracts, /Directly Acquired Experience[\s\S]*actual project moment/i);
  assert.match(activeContracts, /Principle[\s\S]*unsupported industry prior/i);
  assert.match(activeContracts, /Privacy[\s\S]*Evidence[\s\S]*chronology[\s\S]*attribution[\s\S]*causal restraint[\s\S]*uncertainty[\s\S]*non-fabrication/i);
  const timelineContract = ui.match(/## Project Story Timeline([\s\S]*?)## Chapter rail/)?.[1] ?? "";
  assert.match(timelineContract, /canonical `\/3`[\s\S]*Story Chapter card[\s\S]*No AI-selected Highlight signal[\s\S]*required/i);
  assert.match(timelineContract, /Compatibility[\s\S]*oxygen\.story-highlight\/2[\s\S]*AI-selected Highlight signal[\s\S]*only inside that\s+versioned path/i);
  const passageContract = ui.match(/## Optional passage assistance([\s\S]*?)## Compatibility `\/2` canonical Highlight/)?.[1] ?? "";
  assert.match(passageContract, /canonical `oxygen\.story\/3`[\s\S]*optional[\s\S]*non-authoritative/i);
  assert.match(passageContract, /No Story block must supply `passageContext`[\s\S]*why-it-mattered[\s\S]*what-was-learned[\s\S]*reusable lesson/i);
  assert.match(passageContract, /Compatibility `\/2` passage context[\s\S]*Only `oxygen\.story-highlight\/2` retains/i);
  assert.match(migration, /MERGE_INTO_CANONICAL_LATER[\s\S]*DELETE_AFTER_CANONICALIZATION/);

  for (const obsolete of [
    /every Chapter has exactly one canonical Insight/i,
    /generate exactly one reviewable canonical Insight/i,
    /dated AI-selected Highlight/i,
    /visible AI-selected Highlight/i,
    /title names tension plus change/i,
    /main problem, participants, final action, and result must be represented/i,
    /last Chapter must be current state/i,
    /Generate local AI assistance for every rendered Story block/i,
    /Do not bind `\/3`[\s\S]*Viewer/i,
    /stop before live Timeline \/ Viewer activation/i,
    /future successor activation/i,
    /current Viewer, Review Session, and release behavior remains unchanged/i,
    /Every complete canonical English Chapter supplies one valid `passageContext`/i,
  ]) assert.doesNotMatch(activeContracts, obsolete);
  assert.doesNotMatch(activeContracts, /typically 1[–-]3|at least one Insight|maximum three/i);
  assert.doesNotMatch(activeContracts, /BOM Sourcing Benchmark|127\.0\.0\.1:326[14]/);

  const sentences = syntheticStoryProject.overview.en.match(/[^.!?]+[.!?]+/g) || [];
  assert.ok(sentences.length >= 2 && sentences.length <= 3);
});

test("the synthetic project completes through the shared review and release runtime", () => {
  const milestones = selectProjectTimeline(syntheticStoryEvents);
  const reviews = {};
  for (const milestone of milestones) {
    const presentation = milestone.story.reviewPresentation.en;
    const privacyDecisions = Object.fromEntries(presentation.privacy.candidates.map((candidate) => [
      candidate.id,
      candidate.id === "removed-demo-metric" ? "redact" : "keep",
    ]));
    const context = {
      storyKey: milestone.story.key,
      privacyCandidates: presentation.privacy.candidates,
      privacyDecisions,
      targetCatalog: storyReleaseTargetCatalog(presentation),
      reviewableInsightIds: presentation.highlights.map((highlight) => highlight.id),
      chapterEvidence: [milestone.story.evidence.primary],
      evidenceResolved: true,
      supportedAddIds: [],
      sourceBlocks: { en: {}, zh: {} },
      reviewedBlocks: { en: {}, zh: {} },
    };
    let review = applyChapterReview(emptyChapterReview(), context).state;
    review = markChapterReady(review, context);
    assert.equal(review.stage, "human_confirmed");
    assert.equal(review.publicationApproved, false);
    reviews[milestone.story.key] = review;
  }

  const release = buildReviewedStoryRelease(milestones, reviews);
  assert.equal(release.publication_approved, false);
  assert.equal(release.chapters.length, 3);
  assert.equal(release.chapters[1].en.people.length, 2);
  assert.deepEqual(release.chapters[2].en.story.importantDetails, []);
  assert.doesNotMatch(JSON.stringify(release), /Synthetic dock code|synthetic-reviewed-document|synthetic-evidence-/);
});

test("the Story Skill progressively loads stage-local references", async () => {
  const skill = await read("../../skills/oxygen-storytelling-review/SKILL.md");
  const routing = skill.match(/## Progressive reference loading([\s\S]*?)## Non-negotiable boundaries/)?.[1];
  assert.ok(routing);
  assert.doesNotMatch(routing, /read all eight|all eight completely/i);

  const rows = new Map(
    routing
      .split("\n")
      .filter((line) => /^\| \*\*/.test(line))
      .map((line) => {
        const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
        return [cells[0], cells.slice(1)];
      }),
  );
  const build = rows.get("**Build Project Story — always**")?.join(" ") ?? "";
  for (const reference of [
    "product-contract.md",
    "story-data-contract.md",
    "privacy-evidence-boundary.md",
    "narrative-writing-contract.md",
  ]) assert.match(build, new RegExp(reference.replace(".", "\\.")));
  for (const deferred of [
    "validation-checklist.md",
    "ui-interaction-contract.md",
    "chapter-review-lifecycle.md",
    "bilingual-contract.md",
  ]) assert.doesNotMatch(build, new RegExp(deferred.replace(".", "\\.")));
  assert.match(build, /context-complete writing support keeps Build active/);

  const lifecycle = rows.get("**Human Review begins**")?.join(" ") ?? "";
  assert.match(lifecycle, /chapter-review-lifecycle\.md/);
  assert.match(lifecycle, /ready_for_human_review/);
  assert.doesNotMatch(lifecycle, /diagnosing, auditing, or implementing review UI/);

  const reviewUi = rows.get("**Human Review or review-UI work**")?.join(" ") ?? "";
  assert.match(reviewUi, /ui-interaction-contract\.md/);
  assert.doesNotMatch(reviewUi, /chapter-review-lifecycle\.md/);

  const localization = rows.get("**Localization requested or present**")?.join(" ") ?? "";
  assert.match(localization, /bilingual-contract\.md/);
  assert.match(localization, /user requests localization or a sidecar exists/);
  assert.match(localization, /English remains canonical; missing Chinese is nonblocking/);

  const qa = rows.get("**QA, clean-room, or submission\/release gate**")?.join(" ") ?? "";
  assert.match(qa, /validation-checklist\.md/);
  assert.match(qa, /clean-room completion requirement remains mandatory/);
});

test("the normal workflow delegates to the canonical repository Story runtime", async () => {
  const [agents, sop, organizer, skill, workspace, editor] = await Promise.all([
    read("../../AGENTS.md"),
    read("../../SOP.md"),
    read("../../skills/oxygen-organize-review-export/SKILL.md"),
    read("../../skills/oxygen-storytelling-review/SKILL.md"),
    read("../app/workspace.tsx"),
    read("../app/story-chapter-editor.tsx"),
  ]);
  assert.match(agents, /delegate[\s\S]*skills\/oxygen-storytelling-review\/SKILL\.md/);
  assert.match(sop, /Build Project Story and Review Story[\s\S]*skills\/oxygen-storytelling-review\/SKILL\.md/);
  assert.match(organizer, /Delegate Storytelling after the reviewed boundary/);
  assert.match(organizer, /does not need to know or manually name the delegated Skill/);
  assert.match(agents, /Before collection[\s\S]{0,120}sanitized Workflow Progress/i);
  assert.match(sop, /workflow-progress surface/);
  assert.match(organizer, /Never expose chain-of-thought/);
  assert.match(skill, /Canonical Toolkit boundary/);
  assert.match(skill, /viewer\/lib\/timeline\.ts[\s\S]*viewer\/lib\/story-readiness\.ts[\s\S]*atomic workflow activation/);
  assert.match(skill, /oxygen\.story\/3[\s\S]*oxygen\.story-review-session\/2[\s\S]*SuccessorStoryChapterEditor[\s\S]*oxygen\.reviewed-story\/2/);
  assert.match(skill, /For `\/3`, passage assistance[\s\S]*optional[\s\S]*never Story readiness or Review Session completion/);
  assert.match(skill, /narrative-writing-contract\.md/);
  assert.match(skill, /Direct typing, caret insertion, selection replacement\/deletion/);
  assert.match(skill, /human direct edits and\/or compatible legacy review records/);
  assert.match(skill, /completely fresh, contextless Agent[\s\S]*normal public Oxygen workflow request/);
  assert.match(skill, /Missing, incomplete, or stale Chinese never blocks[\s\S]*English candidate/);
  assert.match(skill, /private latent reasoning/);
  assert.match(skill, /Every\s+Chapter requires at least one supported Person or actor/);
  assert.match(skill, /machine-only events[\s\S]*cannot stand alone/);
  assert.match(skill, /Background, Quote, Directly Acquired Experience,[\s\S]*Principle/);
  assert.match(skill, /beforeinput` as optional metadata/);
  assert.match(workspace, /export function InlineWorkspace/);
  assert.match(editor, /export function StoryChapterEditor/);
  assert.match(editor, /background: "Background"[\s\S]*decisionProcess: "Decision process"[\s\S]*openQuestions: "Open questions"/);
  assert.match(editor, /contextualInsight: "AI insight"[\s\S]*contextualInsight: "AI 洞察"/);
  assert.doesNotMatch(editor, /contextualInsight: "(?:Passage insight|段落洞察)"/);
  assert.match(editor, /Accepted — pending Apply review/);
  assert.match(editor, /summary\.pendingInsights[\s\S]*labels\.insightDecisions/);
  assert.match(editor, /aria-live="polite"/);
  assert.match(editor, /Participant evidence is required before this Chapter can be reviewed/);
  assert.doesNotMatch(editor, /No supported participant was identified for this chapter/);
  assert.match(editor, /normalizeDirectBeforeInput[\s\S]*deriveDirectStoryMutation/);
  assert.match(editor, /onCompositionStart[\s\S]*onCompositionEnd/);
  assert.match(editor, /completedCompositionRef[\s\S]*completedComposition\.nextText === nextText/);
  assert.match(editor, /handleDirectPaste[\s\S]*activeCompositionRef\.current\) return/);
  assert.match(editor, /handleDirectKeyDown[\s\S]*nativeEvent\.isComposing[\s\S]*activeCompositionRef\.current/);
  assert.doesNotMatch(editor, /inputType\.startsWith/);
  assert.match(editor, /const nextText = editor\.value;[\s\S]*setCompositionDrafts\(\(drafts\) => \(\{ \.\.\.drafts, \[blockId\]: nextText \}\)\)/);
  assert.doesNotMatch(editor, /setCompositionDrafts\(\(drafts\) => \(\{ \.\.\.drafts, \[blockId\]: (?:editor|event\.currentTarget)\.value \}\)\)/);
  for (const contract of ["storyOrientation", "storyCanvasGrid", "phaseHeading", "milestoneList", "transition", "phaseDirectory"]) {
    assert.match(workspace, new RegExp(contract));
  }
  assert.doesNotMatch(workspace, /storyTimelineLayout|timelineEvent|timelineBody/);
  await access(new URL("../../skills/oxygen-storytelling-review/SKILL.md", import.meta.url));

  const reusableSource = [skill, workspace, editor].join("\n");
  assert.doesNotMatch(reusableSource, /BOM Sourcing Benchmark|127\.0\.0\.1:3264|13 meaningful milestones|14 meaningful milestones|34 source records/);
});
