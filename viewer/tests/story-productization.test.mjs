import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { syntheticStoryEvents, syntheticStoryProject } from "./fixtures/synthetic-story-project.mjs";
import { buildReviewedStoryRelease } from "../lib/story-release.ts";
import { applyChapterReview, emptyChapterReview, markChapterReady } from "../lib/story-review.ts";
import { STORY_PREFIX, parseStoryAnnotation, resolveEvidenceTarget, selectProjectTimeline } from "../lib/timeline.ts";

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

test("the reusable narrative contract separates a scan-first homepage from evidence-driven Chapter memory", async () => {
  const [product, data, bilingual, validation, narrative, lifecycle, interaction] = await Promise.all([
    read("../../skills/oxygen-storytelling-review/references/product-contract.md"),
    read("../../skills/oxygen-storytelling-review/references/story-data-contract.md"),
    read("../../skills/oxygen-storytelling-review/references/bilingual-contract.md"),
    read("../../skills/oxygen-storytelling-review/references/validation-checklist.md"),
    read("../../skills/oxygen-storytelling-review/references/narrative-writing-contract.md"),
    read("../../skills/oxygen-storytelling-review/references/chapter-review-lifecycle.md"),
    read("../../skills/oxygen-storytelling-review/references/ui-interaction-contract.md"),
  ]);
  for (const contract of [
    "Every reviewed historical record", "2–3 concise sentences", "one or two scannable English words",
    "Context-complete project memory without fictionalization", "durable project memory for humans and future Agents",
    "problem,", "constraints", "rejected approaches", "private[\\s\\n]+latent model reasoning",
  ]) assert.match(product, new RegExp(contract));
  assert.match(product, /Project Story = scan-first navigation[\s\S]*Chapter Story = context-complete durable project memory[\s\S]*Exact Evidence = verification[\s\S]*AI Insight = learning/);
  assert.match(product, /decision-relevant context coverage[\s\S]*factual and Evidence fidelity[\s\S]*readability/);
  assert.match(product, /Brevity is not a Chapter objective/);
  assert.match(product, /background, causal or temporal relationships, participant[\s\S]*interaction, judgment, failed attempt, progress or iteration, or result/);
  assert.match(product, /Chapter length is determined by the Evidence/);
  assert.match(product, /meaningful project development/);
  assert.match(product, /durable progress/);
  assert.match(product, /substantive iteration/);
  assert.match(product, /Judgment moments[\s\S]*Other eligible milestones/);
  assert.match(product, /Do not invent low-value Chapters[\s\S]*discard supported milestones/);
  assert.match(product, /Decision process must connect supported People/);
  assert.match(product, /short Chapter-specific summary[\s\S]*differ across Chapters[\s\S]*Evidence-traced/);
  assert.match(product, /Never invent a reply or consensus/);
  assert.match(product, /connective adverb is optional/);
  assert.match(data, /canonical context-retention and voice rules/);
  assert.match(data, /context-complete coherent article/);
  assert.match(data, /coverageLedger: Record<StoryCoverageKey, StoryCoverageItem>/);
  assert.match(data, /claimTraceability: StoryClaimTrace\[\]/);
  assert.match(data, /contextRetention: StoryContextRetention/);
  assert.match(data, /Several units may share an Evidence reference/);
  assert.match(data, /distinct localized Chapter `overview`[\s\S]*navigation instructions and repeated boilerplate/);
  assert.match(data, /passage context for every Story-content block/);
  assert.match(data, /A missing map, missing key, or extra key[\s\S]*no valid empty or silent fallback/);
  assert.match(bilingual, /same start, turn, and current boundary/);
  assert.match(bilingual, /Chapter depth remains semantically equivalent/);
  assert.match(bilingual, /English is also the sole Story-readiness and human-review gate/);
  assert.match(bilingual, /absence, incomplete prose, semantic drift, or outstanding translation debt cannot[\s\S]*block Stage 5/);
  assert.match(data, /zh\?: LanguagePresentation/);
  assert.match(validation, /English alone can activate Stage 5, complete review, and export/);
  assert.match(validation, /Chapter copy[\s\S]*retains every supported unit/);
  assert.match(validation, /`supporting_detail` fails readiness/);
  assert.match(validation, /Every Chapter title is followed by a distinct localized summary/);
  for (const concept of [/durable progress/, /substantive iteration/, /failure/]) {
    assert.match(validation, concept);
  }
  assert.match(validation, /## Workflow progress/);
  for (const contract of ["Background", "Decision process", "Direct learning", "Reusable rule", "Open questions", "Record the supported context, decision process, result, and open questions"]) {
    assert.match(narrative, new RegExp(contract));
  }
  for (const rule of ["Do not use metaphors, analogies", "X, not Y", "Cause not determined", "standard terminology", "actor Evidence"]) {
    assert.match(narrative, new RegExp(rule.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
  assert.match(narrative, /Do not set[\s\S]*global word, sentence, paragraph, or\s+character target/);
  assert.match(narrative, /Chapter brevity is never a selection, generation,[\s\S]*revision, or validation objective/);
  assert.match(narrative, /Readability may reorganize[\s\S]*but may not delete/);
  assert.match(narrative, /Chapter coverage ledger/);
  assert.match(narrative, /claim traceability for every material factual claim/);
  assert.match(narrative, /context-retention ledger/);
  assert.match(narrative, /Repeating one reference across many claims cannot satisfy this gate/);
  assert.match(narrative, /Make participant interaction legible/);
  assert.match(narrative, /## Chapter overview[\s\S]*lively and engaging[\s\S]*Do not add jokes/);
  assert.match(narrative, /## Inline AI Insight[\s\S]*participant actions, responses,[\s\S]*Never open with a[\s\S]*semantic passage/);
  assert.match(narrative, /localized functional role in Decision process/);
  assert.match(narrative, /Determine the actual semantic relationship first[\s\S]*connective adverb is optional/);
  assert.match(narrative, /open vocabulary,[\s\S]*not an allowlist/);
  assert.match(narrative, /Prefer natural syntactic variety over thesaurus substitution/);
  assert.match(narrative, /editorial preference, not a lexical[\s\S]*readiness rule/);
  assert.match(narrative, /must never claim a stronger relationship than Evidence supports/);
  assert.doesNotMatch([product, data, validation].join("\n"), /must use at least one relational connective|Connect those turns with at least one natural localized relation marker/);
  assert.doesNotMatch(narrative, /three to five concise sentences|four to seven concise sentences/);
  assert.match(narrative, /exactly one reviewable canonical Insight/);
  assert.match(lifecycle, /## Direct-edit transaction model/);
  assert.match(lifecycle, /Direct editing is the primary current lifecycle/);
  assert.match(lifecycle, /pending or needs evidence[\s\S]*evidence\/ledger provenance fails validation/);
  assert.match(lifecycle, /stale paired locale[\s\S]*informational[\s\S]*never blocks canonical English review/);
  assert.match(lifecycle, /Undo marks the most recently changed active-locale pending transaction reverted/);
  assert.match(interaction, /current\/total position plus[\s\S]*Previous\/Next controls/);
  assert.match(interaction, /Label it `AI insight` \/ `AI 洞察`[\s\S]*never opens with a semantic-passage number/);
  assert.match(validation, /## Direct Story editing/);
  assert.doesNotMatch([product, data, bilingual, validation, narrative, lifecycle, interaction].join("\n"), /BOM Sourcing Benchmark|127\.0\.0\.1:326[14]/);

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
  assert.match(skill, /Canonical Toolkit runtime/);
  assert.match(skill, /viewer\/app\/workspace\.tsx[\s\S]*InlineWorkspace/);
  assert.match(skill, /viewer\/app\/story-chapter-editor\.tsx[\s\S]*StoryChapterEditor/);
  assert.match(skill, /passage-context/);
  assert.match(skill, /narrative-writing-contract\.md/);
  assert.match(skill, /Direct typing, caret insertion, selection replacement\/deletion/);
  assert.match(skill, /human direct edits and\/or compatible legacy review records/);
  assert.match(skill, /completely fresh, contextless Agent[\s\S]*normal public Oxygen workflow request/);
  assert.match(skill, /Missing or unsupported English context makes that Chapter incomplete/);
  assert.match(skill, /Missing Chinese never[\s\S]*blocks English readiness/);
  assert.match(skill, /private latent reasoning/);
  assert.match(skill, /at least one supported[\s\S]*participant and complete actor coverage/);
  assert.match(skill, /machine-only events[\s\S]*cannot stand alone/);
  assert.match(skill, /Background, Decision process, Result, and Open questions/);
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
