import {
  LEGACY_STORY_PREFIX,
  STORY_PREFIX,
  parseStoryAnnotation,
  resolveEvidenceTarget,
  selectProjectTimeline,
  type StoryAnnotation,
  type TimelineCandidate,
  type TimelineMilestone,
} from "./timeline.ts";

export type StoryCandidateRow = {
  id: string;
  documentId: string;
  summary: string;
};

export type StoryEvidenceRow = {
  id: string;
  documentId: string;
};

export type StoryCandidateFailureCode =
  | "STORY_CANDIDATE_MISSING"
  | "STORY_CHAPTER_INVALID"
  | "STORY_KEY_DUPLICATED"
  | "STORY_SUMMARY_MISSING"
  | "STORY_SUMMARY_INCONSISTENT"
  | "STORY_PHASE_ORDER_INVALID"
  | "STORY_PHASE_QUALITY_INVALID"
  | "STORY_NARRATIVE_SELF_REVIEW_MISSING"
  | "STORY_NARRATIVE_CONTRACT_FAILED"
  | "STORY_EVIDENCE_UNRESOLVED"
  | "STORY_EVIDENCE_DOCUMENT_MISMATCH";

export type StoryCandidateValidation =
  | { ok: true; chapterCount: number; canonicalCandidate: string }
  | { ok: false; code: StoryCandidateFailureCode };

const failure = (code: StoryCandidateFailureCode): StoryCandidateValidation => ({ ok: false, code });

const normalizedCopy = (value: string) => value.toLowerCase()
  .replace(/[^a-z0-9\p{L}]+/gu, " ")
  .trim();

const GENERIC_TITLES = new Set([
  "project update", "benchmark discussion", "project evolution", "workflow progress",
  "项目更新", "基准讨论", "项目演进", "工作流进展",
]);
const GENERIC_PHASES = new Set([
  "project evolution", "project update", "workflow progress",
  "项目演进", "项目更新", "工作流进展",
]);
const GENERIC_FILLER = [
  /^the team needed to\b/i,
  /^this passage shows\b/i,
  /^the evidence supported a more explicit decision boundary\b/i,
  /^this highlights the importance of\b/i,
  /^the key takeaway is\b/i,
  /^(?:团队需要|这段文字表明|证据支持了更明确的决策边界|这凸显了|关键启示是)/,
];

function looksLikeGenericFiller(value: string) {
  const compact = value.replace(/\s+/g, " ").trim();
  const englishWords = compact.match(/[A-Za-z0-9][A-Za-z0-9_-]*/g)?.length || 0;
  return GENERIC_FILLER.some((pattern) => pattern.test(compact))
    && (englishWords ? englishWords < 14 : compact.length < 32);
}

function sentenceCount(value: string) {
  return value.split(/[.!?。！？]+/u).filter((sentence) => sentence.trim()).length;
}

function narrativeQualityPasses(annotation: StoryAnnotation) {
  const presentations = [annotation.reviewPresentation.en, annotation.reviewPresentation.zh];
  const canonicalStory = annotation.reviewPresentation.en.story;
  if (GENERIC_TITLES.has(normalizedCopy(annotation.title))
    || presentations.some((presentation) => GENERIC_TITLES.has(normalizedCopy(presentation.title)))
    || annotation.releaseEpisode.scene !== canonicalStory.scene
    || JSON.stringify(annotation.releaseEpisode.reconstruction) !== JSON.stringify(canonicalStory.reconstruction)
    || JSON.stringify(annotation.releaseEpisode.importantDetails) !== JSON.stringify(canonicalStory.importantDetails)
    || annotation.releaseEpisode.decisionOutcome !== canonicalStory.decisionOutcome
    || (annotation.releaseEpisode.uncertainty || "") !== (canonicalStory.uncertainty || "")) return false;
  return presentations.every((presentation) => {
    const blocks = new Map<string, string>([
      ["scene", presentation.story.scene],
      ...presentation.story.reconstruction.map((copy, index) => [`reconstruction-${index}`, copy] as const),
      ...presentation.story.importantDetails.map((copy, index) => [`detail-${index}`, copy] as const),
      ["outcome", presentation.story.decisionOutcome],
      ...(presentation.story.uncertainty ? [["uncertainty", presentation.story.uncertainty] as const] : []),
    ]);
    const passageCopy: string[] = [];
    for (const [blockId, source] of blocks) {
      const context = presentation.passageContext[blockId];
      if (!context?.whatWasHappening?.trim()
        || !context.whyItMattered?.trim()
        || !context.whatWeLearned?.trim()
        || !context.reusableLesson?.trim()) return false;
      const fields = [
        context.whatWasHappening, context.whyItMattered,
        context.whatWeLearned, context.reusableLesson,
      ];
      const normalizedFields = fields.map(normalizedCopy);
      if (normalizedFields.includes(normalizedCopy(source))
        || new Set(normalizedFields).size !== normalizedFields.length
        || fields.some(looksLikeGenericFiller)) return false;
      passageCopy.push(...fields);
    }
    const insight = presentation.highlights[0];
    const insightFields = [insight.title, insight.noticed, insight.lesson];
    const comparedCopy = [...blocks.values(), ...passageCopy].map(normalizedCopy);
    return new Set(insightFields.map(normalizedCopy)).size === insightFields.length
      && insightFields.every((copy) => !looksLikeGenericFiller(copy)
        && !comparedCopy.includes(normalizedCopy(copy)))
      && sentenceCount(`${insight.noticed} ${insight.lesson}`) >= 3
      && sentenceCount(`${insight.noticed} ${insight.lesson}`) <= 8;
  });
}

/** Validate one complete staged Story package without exposing any Story or Evidence payload. */
export function validateStoryCandidatePackage(
  candidateRows: StoryCandidateRow[],
  evidenceRows: StoryEvidenceRow[],
): StoryCandidateValidation {
  if (!candidateRows.length) return failure("STORY_CANDIDATE_MISSING");
  const annotations: StoryAnnotation[] = [];
  const keys = new Set<string>();
  let projectSummary = "";
  let activePhase = "";
  let activePhaseRationale = "";
  const completedPhases = new Set<string>();
  const phaseRationales = new Map<string, string>();
  const phaseLabelsZh = new Map<string, string>();

  for (const row of candidateRows) {
    if (!row.summary.startsWith(STORY_PREFIX) || row.summary.startsWith(LEGACY_STORY_PREFIX)) {
      return failure("STORY_CHAPTER_INVALID");
    }
    const parsed = parseStoryAnnotation(row.summary);
    if (!parsed || parsed.schema !== "oxygen.story-highlight/2") {
      return failure("STORY_CHAPTER_INVALID");
    }
    if (keys.has(parsed.key)) return failure("STORY_KEY_DUPLICATED");
    keys.add(parsed.key);

    const summary = parsed.reviewPresentation.projectSummary;
    if (!summary?.en?.trim() || !summary.zh?.trim()) return failure("STORY_SUMMARY_MISSING");
    const canonicalSummary = JSON.stringify({ en: summary.en.trim(), zh: summary.zh.trim() });
    if (projectSummary && canonicalSummary !== projectSummary) {
      return failure("STORY_SUMMARY_INCONSISTENT");
    }
    projectSummary = canonicalSummary;

    const narrativeReview = parsed.narrativeReview;
    if (!narrativeReview) return failure("STORY_NARRATIVE_SELF_REVIEW_MISSING");
    if (!narrativeQualityPasses(parsed)) return failure("STORY_NARRATIVE_CONTRACT_FAILED");
    const phase = parsed.reviewPresentation.en.phase.trim();
    const phaseZh = parsed.reviewPresentation.zh.phase.trim();
    const phaseRationale = narrativeReview.phase.rationale.trim();
    if (normalizedCopy(parsed.phase) !== normalizedCopy(phase)
      || GENERIC_PHASES.has(normalizedCopy(phase))
      || GENERIC_PHASES.has(normalizedCopy(phaseZh))
      || normalizedCopy(phaseRationale) === normalizedCopy(phase)
      || looksLikeGenericFiller(phaseRationale)) {
      return failure("STORY_PHASE_QUALITY_INVALID");
    }
    if (phaseRationales.has(parsed.phase)
      && phaseRationales.get(parsed.phase) !== normalizedCopy(phaseRationale)) {
      return failure("STORY_PHASE_QUALITY_INVALID");
    }
    if (phaseLabelsZh.has(parsed.phase)
      && phaseLabelsZh.get(parsed.phase) !== normalizedCopy(phaseZh)) {
      return failure("STORY_PHASE_QUALITY_INVALID");
    }
    phaseRationales.set(parsed.phase, normalizedCopy(phaseRationale));
    phaseLabelsZh.set(parsed.phase, normalizedCopy(phaseZh));

    if (parsed.phase !== activePhase) {
      if (completedPhases.has(parsed.phase)) return failure("STORY_PHASE_ORDER_INVALID");
      if (activePhase && activePhaseRationale === normalizedCopy(phaseRationale)) {
        return failure("STORY_PHASE_QUALITY_INVALID");
      }
      if (activePhase) completedPhases.add(activePhase);
      activePhase = parsed.phase;
      activePhaseRationale = normalizedCopy(phaseRationale);
    }

    for (const reference of [parsed.evidence.primary, ...parsed.evidence.supporting]) {
      const resolution = resolveEvidenceTarget(evidenceRows, reference.eventId);
      if (resolution.status !== "resolved") return failure("STORY_EVIDENCE_UNRESOLVED");
      if (evidenceRows[resolution.index]?.documentId !== reference.documentId) {
        return failure("STORY_EVIDENCE_DOCUMENT_MISMATCH");
      }
    }
    annotations.push(parsed);
  }

  return {
    ok: true,
    chapterCount: annotations.length,
    canonicalCandidate: JSON.stringify(candidateRows.map((row) => ({ id: row.id, summary: row.summary }))),
  };
}

/** Render only explicit v2 Chapters. Fallback/legacy milestones are never a review-ready Story. */
export function selectReviewableStoryTimeline<T extends TimelineCandidate>(
  events: T[],
): Array<TimelineMilestone<T>> {
  const milestones = selectProjectTimeline(events, Number.MAX_SAFE_INTEGER);
  return milestones.length > 0 && milestones.every((milestone) => (
    milestone.story.explicit
    && Boolean(milestone.story.releaseEpisode)
    && Boolean(milestone.story.reviewPresentation)
    && Boolean(milestone.story.insight)
    && Boolean(milestone.story.evidence)
  ))
    ? milestones
    : [];
}
