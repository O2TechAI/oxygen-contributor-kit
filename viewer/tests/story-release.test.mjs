import test from "node:test";
import assert from "node:assert/strict";
import {
  applyChapterReview,
  emptyChapterReview,
  markChapterReady,
  recordStoryEdit,
} from "../lib/story-review.ts";
import {
  buildReviewedStoryRelease,
  releaseOrganizationReason,
  reviewedStoryPackageEntry,
  sanitizeReviewedStoryRelease,
} from "../lib/story-release.ts";
import { POST as exportReviewedHtml } from "../app/api/organization/export/route.ts";
import { STORY_PREFIX } from "../lib/timeline.ts";

const candidate = {
  id: "local-detail", title: "Local detail", explanation: "Review it", recommendation: "redact",
  releaseTargets: ["detail-0"], original: { availability: "available", excerpt: "local-only", sourceLanguage: "en" },
  whyFlagged: "It can identify the local environment.",
};

const locale = (language) => ({
  phase: language === "zh" ? "阶段" : "Phase",
  title: language === "zh" ? "已审阅章节" : "Reviewed chapter",
  timelineSummary: language === "zh" ? "简短变化" : "Concise change",
  before: language === "zh" ? "之前" : "Before",
  after: language === "zh" ? "之后" : "After",
  timelineChips: [],
  overview: language === "zh" ? "说明转折。" : "Explains the turn.",
  people: [{
    id: "local-person", releaseLabel: "A", role: language === "zh" ? "负责人" : "Owner",
    description: language === "zh" ? "定义边界。" : "Defined the boundary.", localIdentityState: "local_only",
    evidence: [{ documentId: "doc", eventId: "event" }],
  }],
  story: {
    scene: language === "zh" ? "团队需要决定。" : "The team needed to decide.",
    reconstruction: [language === "zh" ? "证据改变了方向。" : "Evidence changed direction."],
    importantDetails: [language === "zh" ? "本地细节。" : "Local detail."],
    decisionOutcome: language === "zh" ? "采用安全路径。" : "Use the safe path.",
  },
  passageContext: {
    scene: { whatWasHappening: "LOCAL_PASSAGE_SCENE", whyItMattered: "LOCAL_PASSAGE_WHY" },
    "reconstruction-0": { whatWasHappening: "LOCAL_PASSAGE_RECONSTRUCTION", whyItMattered: "LOCAL_PASSAGE_TURN" },
    "detail-0": { whatWasHappening: "LOCAL_PASSAGE_DETAIL", whyItMattered: "LOCAL_PASSAGE_LEARNING" },
    outcome: { whatWasHappening: "LOCAL_PASSAGE_OUTCOME", whyItMattered: "LOCAL_PASSAGE_RESULT", reusableLesson: "LOCAL_PASSAGE_LESSON" },
  },
  highlights: [{
    id: "lesson", title: language === "zh" ? "共同标准" : "Shared standard",
    noticed: language === "zh" ? "证据形成共识。" : "Evidence created alignment.",
    lesson: language === "zh" ? "先定义成功。" : "Define success first.",
  }],
  privacy: { summary: "One candidate", candidates: [candidate] },
});

const milestone = {
  id: "event",
  story: {
    key: "chapter", kind: "decision",
    reviewPresentation: { en: locale("en"), zh: locale("zh"), semanticAnchors: ["decision"] },
  },
};

const evidence = { documentId: "doc", eventId: "event" };
const reviewContext = (privacyDecision) => ({
  storyKey: milestone.story.key,
  privacyCandidates: [candidate],
  privacyDecisions: { "local-detail": privacyDecision },
  reviewableInsightIds: ["lesson"],
  chapterEvidence: [evidence],
  evidenceResolved: true,
  supportedAddIds: [],
  sourceBlocks: { en: {}, zh: {} },
  reviewedBlocks: { en: {}, zh: {} },
});

test("release projection includes only human-confirmed allowlisted Chapter copy", () => {
  const pending = buildReviewedStoryRelease([milestone], { chapter: emptyChapterReview() });
  assert.deepEqual(pending.chapters, []);

  const context = reviewContext("redact");
  let review = applyChapterReview(emptyChapterReview(), context).state;
  review = markChapterReady(review, context);
  const release = buildReviewedStoryRelease([milestone], { chapter: review });
  assert.equal(release.publication_approved, false);
  assert.equal(release.chapters.length, 1);
  assert.deepEqual(release.chapters[0].en.story.importantDetails, []);
  assert.deepEqual(release.chapters[0].zh.story.importantDetails, []);
  assert.deepEqual(release.chapters[0].en.people[0], {
    releaseLabel: "A", role: "Owner", description: "Defined the boundary.",
  });

  const serialized = JSON.stringify(release);
  for (const forbidden of [
    "local-only", "localIdentityState", "original", "excerpt", "documentId", "eventId",
    "annotations", "instruction", "LOCAL_PASSAGE_", "coverageLedger", "claimTraceability",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden));
  }
});

test("canonical English review and release do not require a Chinese sidecar", () => {
  const englishOnly = structuredClone(milestone);
  delete englishOnly.story.reviewPresentation.zh;
  const context = reviewContext("keep");
  let review = applyChapterReview(emptyChapterReview(), context).state;
  review = markChapterReady(review, context);

  const release = buildReviewedStoryRelease([englishOnly], { chapter: review });
  assert.equal(release.chapters.length, 1);
  assert.ok(release.chapters[0].en);
  assert.equal(release.chapters[0].zh, undefined);
  assert.ok(sanitizeReviewedStoryRelease(release));
  assert.ok(reviewedStoryPackageEntry(release));
});

test("localization debt is non-blocking and omits the stale sidecar from release", () => {
  const sourceBlocks = {
    en: { scene: locale("en").story.scene },
    zh: { scene: locale("zh").story.scene },
  };
  let review = recordStoryEdit(emptyChapterReview(), {
    storyKey: "chapter", blockId: "scene", sourceLanguage: "en",
    baseText: sourceBlocks.en.scene, nextText: "The group needed to decide.",
    workingRange: { start: 4, end: 8 }, insertedText: "group", now: 100,
  }).state;
  const context = { ...reviewContext("keep"), sourceBlocks, reviewedBlocks: sourceBlocks };
  review = applyChapterReview(review, context).state;
  assert.deepEqual(review.staleTranslations, [{ subject: "story:scene", language: "zh", count: 1 }]);
  review = markChapterReady(review, context);
  assert.equal(review.stage, "human_confirmed");

  const release = buildReviewedStoryRelease([milestone], { chapter: review });
  assert.equal(release.chapters[0].en.story.scene, "The group needed to decide.");
  assert.equal(release.chapters[0].zh, undefined);
});

test("applied direct Story edits reach serialized release copy while the edit ledger and local passage assistance do not", async () => {
  const sourceBlocks = {
    en: {
      scene: locale("en").story.scene,
      "reconstruction-0": locale("en").story.reconstruction[0],
      "detail-0": locale("en").story.importantDetails[0],
      outcome: locale("en").story.decisionOutcome,
    },
    zh: {
      scene: locale("zh").story.scene,
      "reconstruction-0": locale("zh").story.reconstruction[0],
      "detail-0": locale("zh").story.importantDetails[0],
      outcome: locale("zh").story.decisionOutcome,
    },
  };
  let review = recordStoryEdit(emptyChapterReview(), {
    storyKey: "chapter", blockId: "scene", sourceLanguage: "en", baseText: sourceBlocks.en.scene,
    nextText: "The group needed to decide.", workingRange: { start: 4, end: 8 }, insertedText: "group", now: 100,
  }).state;
  review = recordStoryEdit(review, {
    storyKey: "chapter", blockId: "scene", sourceLanguage: "zh", baseText: sourceBlocks.zh.scene,
    nextText: "小组需要决定。", workingRange: { start: 0, end: 2 }, insertedText: "小组", now: 200,
  }).state;
  const context = { ...reviewContext("keep"), sourceBlocks, reviewedBlocks: sourceBlocks };
  review = applyChapterReview(review, context).state;
  assert.deepEqual(review.staleTranslations, []);
  review = markChapterReady(review, context);
  assert.equal(review.stage, "human_confirmed");

  const release = buildReviewedStoryRelease([milestone], { chapter: review });
  assert.equal(release.chapters[0].en.story.scene, "The group needed to decide.");
  assert.equal(release.chapters[0].zh.story.scene, "小组需要决定。");
  assert.doesNotMatch(JSON.stringify(release), /editTransactions|beforeText|afterText|Passage|LOCAL_PASSAGE_/);

  const wrongChapter = structuredClone(review);
  wrongChapter.editTransactions[0].storyKey = "different-chapter";
  assert.deepEqual(buildReviewedStoryRelease([milestone], { chapter: wrongChapter }).chapters, []);

  const untrusted = structuredClone(release);
  untrusted.chapters[0].editTransactions = [{ beforeText: "LEDGER_SENTINEL", afterText: "LEDGER_SENTINEL" }];
  untrusted.chapters[0].passageContext = { scene: "PASSAGE_SENTINEL" };
  const packageEntry = reviewedStoryPackageEntry(untrusted);
  assert.match(packageEntry.data, /The group needed to decide\./);
  assert.match(packageEntry.data, /小组需要决定。/);
  assert.doesNotMatch(packageEntry.data, /LEDGER_SENTINEL|PASSAGE_SENTINEL|editTransactions|passageContext/);

  const response = await exportReviewedHtml(new Request("http://localhost/api/organization/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reviewedStory: untrusted }),
  }));
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /The group needed to decide\./);
  assert.doesNotMatch(html, /LEDGER_SENTINEL|PASSAGE_SENTINEL|editTransactions|passageContext/);
});

test("server sanitizer reconstructs the reviewed Story from an explicit allowlist", () => {
  const context = reviewContext("keep");
  let review = applyChapterReview(emptyChapterReview(), context).state;
  review = markChapterReady(review, context);
  const release = buildReviewedStoryRelease([milestone], { chapter: review });
  assert.deepEqual(release.chapters[0].en.story.importantDetails, ["Local detail."]);
  assert.deepEqual(release.chapters[0].zh.story.importantDetails, ["本地细节。"]);
  const untrusted = structuredClone(release);
  untrusted.privateEvidence = "must-not-ship";
  untrusted.chapters[0].localReview = { original: "must-not-ship" };
  untrusted.chapters[0].en.people[0].localIdentityState = "local_only";
  const sanitized = sanitizeReviewedStoryRelease(untrusted);
  assert.ok(sanitized);
  assert.doesNotMatch(JSON.stringify(sanitized), /must-not-ship|localIdentityState|localReview|privateEvidence/);
  assert.equal(sanitizeReviewedStoryRelease({ ...untrusted, publication_approved: true }), null);
  const divergent = structuredClone(release);
  divergent.chapters[0].zh.people[0].releaseLabel = "B";
  assert.equal(sanitizeReviewedStoryRelease(divergent), null);

  const multipleInsights = structuredClone(release);
  for (const language of ["en", "zh"]) {
    multipleInsights.chapters[0][language].insights.push({
      ...multipleInsights.chapters[0][language].insights[0],
      id: "second-lesson",
      title: language === "zh" ? "另一条洞察" : "Another insight",
    });
  }
  assert.equal(sanitizeReviewedStoryRelease(multipleInsights), null);

  const entry = reviewedStoryPackageEntry(untrusted);
  assert.equal(entry.name, "story/reviewed-project-story.json");
  assert.deepEqual(JSON.parse(entry.data), sanitized);
  assert.doesNotMatch(entry.data, /must-not-ship|localIdentityState|localReview|privateEvidence/);
});

test("release projection fails closed when source data contains multiple reviewable insights", () => {
  const context = reviewContext("keep");
  let review = applyChapterReview(emptyChapterReview(), context).state;
  review = markChapterReady(review, context);
  const multipleInsightMilestone = structuredClone(milestone);
  for (const language of ["en", "zh"]) {
    multipleInsightMilestone.story.reviewPresentation[language].highlights.push({
      ...multipleInsightMilestone.story.reviewPresentation[language].highlights[0],
      id: "second-lesson",
      title: language === "zh" ? "另一条洞察" : "Another insight",
    });
  }
  assert.deepEqual(buildReviewedStoryRelease([multipleInsightMilestone], { chapter: review }).chapters, []);
});

test("HTML export serializes only the server-sanitized reviewed Story", async () => {
  const context = reviewContext("redact");
  let review = applyChapterReview(emptyChapterReview(), context).state;
  review = markChapterReady(review, context);
  const untrusted = structuredClone(buildReviewedStoryRelease([milestone], { chapter: review }));
  untrusted.privateEvidence = "must-not-ship";
  untrusted.chapters[0].localOriginal = "must-not-ship";
  const response = await exportReviewedHtml(new Request("http://localhost/api/organization/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reviewedStory: untrusted }),
  }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  const html = await response.text();
  assert.match(html, /Reviewed chapter/);
  assert.doesNotMatch(html, /must-not-ship|localOriginal|privateEvidence|localIdentityState/);
});

test("release projection excludes a manually confirmed Chapter without verified evidence", () => {
  const unverified = { ...emptyChapterReview(), stage: "human_confirmed" };
  assert.equal(unverified.evidenceVerified, false);
  assert.deepEqual(buildReviewedStoryRelease([milestone], { chapter: unverified }).chapters, []);
});

test("release projection excludes human-confirmed state with malformed applied provenance", () => {
  const malformed = {
    ...emptyChapterReview(),
    stage: "human_confirmed",
    revision: 2,
    evidenceVerified: true,
    annotations: [{
      id: "bad", blockId: "scene", type: "delete", sourceLanguage: "en",
      selection: { start: 0, end: 3, text: "not" },
      resolution: "applied", baseRevision: 1, appliedRevision: 2,
    }],
    revisionHistory: [{ revision: 2, annotationIds: ["bad"], insightIds: [], privacyDecisions: {} }],
  };
  assert.deepEqual(buildReviewedStoryRelease([milestone], { chapter: malformed }).chapters, []);
});

test("release projection rejects forged pending or unrecorded insight state", () => {
  const context = reviewContext("keep");
  let review = applyChapterReview(emptyChapterReview(), context).state;
  review = markChapterReady(review, context);

  const pendingRejected = structuredClone(review);
  pendingRejected.insightReviews.lesson = {
    status: "rejected", text: "Do not preserve", localized: {}, pendingLanguages: [], resolution: "pending",
  };
  assert.deepEqual(buildReviewedStoryRelease([milestone], { chapter: pendingRejected }).chapters, []);

  const unrecordedRejected = structuredClone(review);
  unrecordedRejected.insightReviews.lesson = {
    status: "rejected", text: "Do not preserve", localized: {}, pendingLanguages: [],
    resolution: "applied", appliedRevision: 2,
  };
  assert.deepEqual(buildReviewedStoryRelease([milestone], { chapter: unrecordedRejected }).chapters, []);
});

test("release projection derives Privacy redaction from the latest recorded decision", () => {
  const context = reviewContext("redact");
  let review = applyChapterReview(emptyChapterReview(), context).state;
  review = markChapterReady(review, context);
  assert.deepEqual(review.redactedBlocks, ["detail-0"]);

  const missingRedaction = { ...structuredClone(review), redactedBlocks: [] };
  assert.deepEqual(buildReviewedStoryRelease([milestone], { chapter: missingRedaction }).chapters, []);

  const staleHistory = structuredClone(review);
  staleHistory.revisionHistory.at(-1).privacyDecisions["local-detail"] = "keep";
  assert.deepEqual(buildReviewedStoryRelease([milestone], { chapter: staleHistory }).chapters, []);

  const forgedTarget = { ...structuredClone(review), redactedBlocks: ["detail-0", "outcome"] };
  assert.deepEqual(buildReviewedStoryRelease([milestone], { chapter: forgedTarget }).chapters, []);
});

test("evidence-supported People can be redacted later without leaking role Evidence", () => {
  const personCandidate = {
    ...candidate,
    id: "local-person-privacy",
    releaseTargets: ["people:local-person"],
  };
  const personMilestone = structuredClone(milestone);
  for (const language of ["en", "zh"]) {
    personMilestone.story.reviewPresentation[language].privacy.candidates = [personCandidate];
  }
  const context = {
    ...reviewContext("redact"),
    storyKey: personMilestone.story.key,
    privacyCandidates: [personCandidate],
    privacyDecisions: { "local-person-privacy": "redact" },
  };
  let review = applyChapterReview(emptyChapterReview(), context).state;
  review = markChapterReady(review, context);
  const release = buildReviewedStoryRelease([personMilestone], { chapter: review });
  assert.deepEqual(release.chapters[0].en.people, []);
  assert.deepEqual(release.chapters[0].zh.people, []);
  assert.doesNotMatch(JSON.stringify(release), /documentId|eventId|local-person/);
});

test("package organization summaries strip Story review metadata before serialization", () => {
  const source = STORY_PREFIX + JSON.stringify({
    schema: "oxygen.story-highlight/2",
    timelineSummary: "A release-safe milestone summary.",
    reviewPresentation: { en: { privacy: { candidates: [{ original: { excerpt: "must-not-ship" } }] } } },
    evidence: { primary: { documentId: "private-doc", eventId: "private-event" } },
  });
  assert.equal(releaseOrganizationReason(source), "A release-safe milestone summary.");
  assert.equal(releaseOrganizationReason("Ordinary release reason"), "Ordinary release reason");
  assert.doesNotMatch(releaseOrganizationReason(source), /must-not-ship|private-doc|private-event/);
});
