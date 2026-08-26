import {
  LEGACY_STORY_PREFIX,
  STORY_COVERAGE_KEYS,
  STORY_PREFIX,
  SUCCESSOR_STORY_PREFIX,
  parseStorySource,
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
  eventType?: string | null;
  actorId?: string | null;
  actorType?: string | null;
};

export type StoryCandidateFailureCode =
  | "STORY_CANDIDATE_MISSING"
  | "STORY_CHAPTER_INVALID"
  | "STORY_KEY_DUPLICATED"
  | "STORY_SUMMARY_MISSING"
  | "STORY_SUMMARY_INCONSISTENT"
  | "STORY_CHAPTER_OVERVIEW_INVALID"
  | "STORY_PHASE_ORDER_INVALID"
  | "STORY_PHASE_QUALITY_INVALID"
  | "STORY_CURRENT_STATE_INVALID"
  | "STORY_NARRATIVE_SELF_REVIEW_MISSING"
  | "STORY_NARRATIVE_CONTRACT_FAILED"
  | "STORY_JUDGMENT_COVERAGE_INVALID"
  | "STORY_CONTEXT_RETENTION_INVALID"
  | "STORY_CLAIM_TRACEABILITY_INVALID"
  | "STORY_EVIDENCE_UNQUALIFIED"
  | "STORY_EVIDENCE_UNRESOLVED"
  | "STORY_EVIDENCE_DOCUMENT_MISMATCH"
  | "STORY_VALIDATION_FAILED"
  | "STORY_PEOPLE_EVIDENCE_INVALID";

export type StoryCandidateValidation =
  | { ok: true; chapterCount: number; canonicalCandidate: string }
  | { ok: false; code: StoryCandidateFailureCode };

const failure = (code: StoryCandidateFailureCode): StoryCandidateValidation => ({ ok: false, code });

export type SuccessorStorySourceFailureCode =
  | "SUCCESSOR_STORY_CANDIDATE_MISSING"
  | "SUCCESSOR_STORY_CHAPTER_INVALID"
  | "SUCCESSOR_STORY_KEY_DUPLICATED"
  | "SUCCESSOR_STORY_PHASE_INVALID"
  | "SUCCESSOR_STORY_PHASE_ORDER_INVALID"
  | "SUCCESSOR_STORY_EVIDENCE_INVALID"
  | "SUCCESSOR_STORY_PEOPLE_INVALID"
  | "SUCCESSOR_STORY_CONTEXT_RETENTION_INVALID"
  | "SUCCESSOR_STORY_INSIGHT_GROUNDING_INVALID";

export type SuccessorStorySourceValidation =
  | { ok: true; chapterCount: number; canonicalCandidate: string }
  | { ok: false; code: SuccessorStorySourceFailureCode };

const successorFailure = (
  code: SuccessorStorySourceFailureCode,
): SuccessorStorySourceValidation => ({ ok: false, code });

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
  /^the team was working on the project\.?$/i,
  /^this passage shows\b/i,
  /^the evidence supported (?:a|the) change\.?$/i,
  /^the project adopted the new direction\.?$/i,
  /^the evidence supported a more explicit decision boundary\b/i,
  /^this highlights the importance of\b/i,
  /^the key takeaway is\b/i,
  /^(?:团队需要|这段文字表明|证据支持了更明确的决策边界|这凸显了|关键启示是)/,
  /^(?:团队正在开展项目|证据支持了(?:一项|这项)?变更|项目采用了新的方向)。?$/,
];
const PROHIBITED_EDITORIAL_STYLE = [
  /\bthe team needed to\b/i,
  /\bthis passage shows\b/i,
  /\bthis highlights the importance of\b/i,
  /\bthe key takeaway is\b/i,
  /\bthe project learned\b/i,
  /\bthe evidence wanted\b/i,
  /\bthe workflow fought back\b/i,
  /\brather than\b/i,
  /\binstead of\b/i,
  /,\s*(?:but\s+)?not\b/i,
  /\bnot\b[^.!?。！？]{0,80}\b(?:but|rather)\b/i,
  /(?:团队需要|这段文字表明|这凸显了|关键启示是|项目学会了|证据想要|工作流进行了反抗)/,
  /(?:不是.{0,40}而是|而不是|而非)/,
  /\b(?:evidence|workflow|model|agent|system|data|project)\s+(?:wanted|felt|believed|fought|hoped)\b/i,
];

const ACTOR_TYPES = new Set([
  "human", "user", "assistant", "ai", "agent", "implementation agent", "research agent",
  "reviewer", "operator", "speaker", "owner", "project owner", "technical lead",
  "data contributor", "contributor", "participant",
]);
const ACTOR_EVENTS = new Set([
  "message", "record", "speech", "instruction", "approval", "disagreement", "decision",
  "assignment", "agent action", "reviewer action", "operator action", "ownership",
]);
const CHAPTER_NAVIGATION_PROMPTS = [
  /^open (?:this|the) chapter\b/i,
  /^read (?:this|the) chapter\b/i,
  /^view (?:this|the) chapter\b/i,
  /^(?:打开|阅读|查看)(?:本|这)(?:章|章节)/,
];
const PASSAGE_IMPLEMENTATION_META = [
  /\b(?:this is\s+)?(?:the\s+)?(?:first|second|third|fourth|fifth|next|previous|semantic|numbered)\s+passage\b/i,
  /\bsemantic passage\s*\d+\b/i,
  /(?:这是)?本章第\s*\d+\s*个?(?:语义)?段落/,
  /第\s*\d+\s*个?语义段落/,
];

function looksLikeGenericFiller(value: string) {
  const compact = value.replace(/\s+/g, " ").trim();
  const englishWords = compact.match(/[A-Za-z0-9][A-Za-z0-9_-]*/g)?.length || 0;
  return GENERIC_FILLER.some((pattern) => pattern.test(compact))
    && (englishWords ? englishWords < 14 : compact.length < 32);
}

function isChapterNavigationPrompt(value: string) {
  const compact = value.replace(/\s+/g, " ").trim();
  return CHAPTER_NAVIGATION_PROMPTS.some((pattern) => pattern.test(compact));
}

function containsPassageImplementationMeta(value: string) {
  const compact = value.replace(/\s+/g, " ").trim();
  return PASSAGE_IMPLEMENTATION_META.some((pattern) => pattern.test(compact));
}

function actorSignature(row: StoryEvidenceRow) {
  const actorType = normalizedCopy(row.actorType || "");
  const eventType = normalizedCopy(row.eventType || "");
  if (actorType === "tool" || actorType === "system") {
    if (!row.actorId?.trim() || !ACTOR_EVENTS.has(eventType)) return "";
  } else if (!ACTOR_TYPES.has(actorType) && !(row.actorId?.trim() && ACTOR_EVENTS.has(eventType))) return "";
  const actorId = normalizedCopy(row.actorId || "");
  return JSON.stringify([actorType || "actor", actorId || eventType]);
}

function violatesEditorialStyle(value: string) {
  const compact = value.replace(/\s+/g, " ").trim();
  return PROHIBITED_EDITORIAL_STYLE.some((pattern) => pattern.test(compact));
}

function editorialCopy(annotation: StoryAnnotation) {
  const summary = annotation.reviewPresentation.projectSummary;
  const presentation = annotation.reviewPresentation.en;
  return [
    summary?.en || "",
    presentation.phase, presentation.title, presentation.timelineSummary,
    presentation.before, presentation.after, presentation.overview,
    ...presentation.people.flatMap((person) => [person.role, person.description]),
    presentation.story.scene, ...presentation.story.reconstruction,
    ...presentation.story.importantDetails, presentation.story.decisionOutcome,
    presentation.story.uncertainty || "",
    ...Object.values(presentation.passageContext).flatMap((context) => [
      context.whatWasHappening, context.whyItMattered,
      context.whatWeLearned || "", context.reusableLesson || "",
    ]),
    ...presentation.highlights.flatMap((insight) => [insight.title, insight.noticed, insight.lesson]),
  ];
}

function participantRolesAreIntegrated(
  presentation: StoryAnnotation["reviewPresentation"]["en"],
) {
  const decisionProcess = normalizedCopy(presentation.story.reconstruction.join(" "));
  return presentation.people.every((person) => {
    const role = normalizedCopy(person.role);
    return role.length > 1 && ` ${decisionProcess} `.includes(` ${role} `);
  });
}

function narrativeQualityPasses(annotation: StoryAnnotation) {
  const presentation = annotation.reviewPresentation.en;
  const canonicalStory = annotation.reviewPresentation.en.story;
  const editorial = annotation.narrativeReview?.editorial;
  if (!editorial
    || editorial.standardTerminology !== true
    || editorial.neutralStructure !== true
    || editorial.factualClaimsEvidenceBound !== true
    || editorial.interpretationSeparated !== true
    || editorial.uncertaintyPreserved !== true
    || editorial.prohibitedStyleChecked !== true
    || editorialCopy(annotation).some(violatesEditorialStyle)
    || GENERIC_TITLES.has(normalizedCopy(annotation.title))
    || GENERIC_TITLES.has(normalizedCopy(presentation.title))
    || !participantRolesAreIntegrated(presentation)
    || annotation.releaseEpisode.scene !== canonicalStory.scene
    || JSON.stringify(annotation.releaseEpisode.reconstruction) !== JSON.stringify(canonicalStory.reconstruction)
    || JSON.stringify(annotation.releaseEpisode.importantDetails) !== JSON.stringify(canonicalStory.importantDetails)
    || annotation.releaseEpisode.decisionOutcome !== canonicalStory.decisionOutcome
    || (annotation.releaseEpisode.uncertainty || "") !== (canonicalStory.uncertainty || "")) return false;
  return (() => {
    const blocks = new Map<string, string>([
      ["scene", presentation.story.scene],
      ...presentation.story.reconstruction.map((copy, index) => [`reconstruction-${index}`, copy] as const),
      ...presentation.story.importantDetails.map((copy, index) => [`detail-${index}`, copy] as const),
      ["outcome", presentation.story.decisionOutcome],
      ...(presentation.story.uncertainty ? [["uncertainty", presentation.story.uncertainty] as const] : []),
    ]);
    if ([...blocks.values()].some(looksLikeGenericFiller)) return false;
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
        || fields.some(looksLikeGenericFiller)
        || fields.some(containsPassageImplementationMeta)) return false;
      passageCopy.push(...fields);
    }
    const insight = presentation.highlights[0];
    const insightFields = [insight.title, insight.noticed, insight.lesson];
    const comparedCopy = [...blocks.values(), ...passageCopy].map(normalizedCopy);
    return new Set(insightFields.map(normalizedCopy)).size === insightFields.length
      && insightFields.every((copy) => !looksLikeGenericFiller(copy)
        && !comparedCopy.includes(normalizedCopy(copy)));
  })();
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
  const chapterOverviewsEn = new Set<string>();
  let currentStateChapterCount = 0;

  for (const row of candidateRows) {
    if (!row.summary.startsWith(STORY_PREFIX) || row.summary.startsWith(LEGACY_STORY_PREFIX)) {
      return failure("STORY_CHAPTER_INVALID");
    }
    const parsed = parseStoryAnnotation(row.summary);
    if (!parsed || parsed.schema !== "oxygen.story-highlight/2") {
      return failure("STORY_CHAPTER_INVALID");
    }
    if (parsed.kind === "current_state") currentStateChapterCount += 1;
    if (keys.has(parsed.key)) return failure("STORY_KEY_DUPLICATED");
    keys.add(parsed.key);

    const summary = parsed.reviewPresentation.projectSummary;
    if (!summary?.en?.trim()) return failure("STORY_SUMMARY_MISSING");
    const canonicalSummary = summary.en.trim();
    if (projectSummary && canonicalSummary !== projectSummary) {
      return failure("STORY_SUMMARY_INCONSISTENT");
    }
    projectSummary = canonicalSummary;

    const overviewEn = parsed.reviewPresentation.en.overview.trim();
    const normalizedOverviewEn = normalizedCopy(overviewEn);
    const exactSingleFieldCopy = [
      parsed.reviewPresentation.en.title,
      parsed.reviewPresentation.en.timelineSummary,
      parsed.reviewPresentation.en.before,
      parsed.reviewPresentation.en.after,
      parsed.reviewPresentation.en.story.scene,
      parsed.reviewPresentation.en.story.decisionOutcome,
    ].some((value) => normalizedCopy(value) === normalizedOverviewEn);
    if (isChapterNavigationPrompt(overviewEn)
      || looksLikeGenericFiller(overviewEn)
      || exactSingleFieldCopy
      || chapterOverviewsEn.has(normalizedOverviewEn)) {
      return failure("STORY_CHAPTER_OVERVIEW_INVALID");
    }
    chapterOverviewsEn.add(normalizedOverviewEn);

    const narrativeReview = parsed.narrativeReview;
    if (!narrativeReview) return failure("STORY_NARRATIVE_SELF_REVIEW_MISSING");
    if (!narrativeQualityPasses(parsed)) return failure("STORY_NARRATIVE_CONTRACT_FAILED");
    const phase = parsed.reviewPresentation.en.phase.trim();
    const phaseRationale = narrativeReview.phase.rationale.trim();
    if (normalizedCopy(parsed.phase) !== normalizedCopy(phase)
      || GENERIC_PHASES.has(normalizedCopy(phase))
      || normalizedCopy(phaseRationale) === normalizedCopy(phase)
      || looksLikeGenericFiller(phaseRationale)) {
      return failure("STORY_PHASE_QUALITY_INVALID");
    }
    if (phaseRationales.has(parsed.phase)
      && phaseRationales.get(parsed.phase) !== normalizedCopy(phaseRationale)) {
      return failure("STORY_PHASE_QUALITY_INVALID");
    }
    phaseRationales.set(parsed.phase, normalizedCopy(phaseRationale));

    if (parsed.phase !== activePhase) {
      if (completedPhases.has(parsed.phase)) return failure("STORY_PHASE_ORDER_INVALID");
      if (activePhase && activePhaseRationale === normalizedCopy(phaseRationale)) {
        return failure("STORY_PHASE_QUALITY_INVALID");
      }
      if (activePhase) completedPhases.add(activePhase);
      activePhase = parsed.phase;
      activePhaseRationale = normalizedCopy(phaseRationale);
    }

    const chapterEvidence = new Map<string, { row: StoryEvidenceRow; actor: string }>();
    for (const reference of [parsed.evidence.primary, ...parsed.evidence.supporting]) {
      const resolution = resolveEvidenceTarget(evidenceRows, reference.eventId);
      if (resolution.status !== "resolved") return failure("STORY_EVIDENCE_UNRESOLVED");
      if (reference.eventId !== resolution.itemId) return failure("STORY_EVIDENCE_UNQUALIFIED");
      const evidenceRow = evidenceRows[resolution.index];
      if (!evidenceRow) return failure("STORY_EVIDENCE_UNRESOLVED");
      if (evidenceRow?.documentId !== reference.documentId) {
        return failure("STORY_EVIDENCE_DOCUMENT_MISMATCH");
      }
      chapterEvidence.set(JSON.stringify([reference.documentId, resolution.itemId]), {
        row: evidenceRow,
        actor: actorSignature(evidenceRow),
      });
    }

    const people = parsed.reviewPresentation.en.people;
    const actorCoverage = narrativeReview.actorCoverage;
    const requiredActors = new Set([...chapterEvidence.values()].map((entry) => entry.actor).filter(Boolean));
    if (people.length === 0) return failure("STORY_VALIDATION_FAILED");
    if (requiredActors.size > 0) {
      if (actorCoverage?.state !== "people_present"
        || JSON.stringify(actorCoverage.personIds) !== JSON.stringify(people.map((person) => person.id))) {
        return failure("STORY_PEOPLE_EVIDENCE_INVALID");
      }
      const coveredActors = new Set<string>();
      for (const person of people) {
        if (!person.evidence?.length) return failure("STORY_PEOPLE_EVIDENCE_INVALID");
        const personActors = new Set<string>();
        for (const reference of person.evidence) {
          const resolution = resolveEvidenceTarget(evidenceRows, reference.eventId);
          if (resolution.status !== "resolved") return failure("STORY_PEOPLE_EVIDENCE_INVALID");
          if (reference.eventId !== resolution.itemId) {
            return failure("STORY_PEOPLE_EVIDENCE_INVALID");
          }
          const key = JSON.stringify([reference.documentId, resolution.itemId]);
          const chapterEntry = chapterEvidence.get(key);
          if (!chapterEntry || chapterEntry.row.documentId !== reference.documentId || !chapterEntry.actor) {
            return failure("STORY_PEOPLE_EVIDENCE_INVALID");
          }
          personActors.add(chapterEntry.actor);
        }
        if (personActors.size !== 1 || [...personActors].some((actor) => coveredActors.has(actor))) {
          return failure("STORY_PEOPLE_EVIDENCE_INVALID");
        }
        personActors.forEach((actor) => coveredActors.add(actor));
      }
      if ([...requiredActors].some((actor) => !coveredActors.has(actor))) {
        return failure("STORY_PEOPLE_EVIDENCE_INVALID");
      }
    } else return failure("STORY_PEOPLE_EVIDENCE_INVALID");

    const storyBlocks = [
      "scene",
      ...parsed.reviewPresentation.en.story.reconstruction.map((_, index) => `reconstruction-${index}`),
      ...parsed.reviewPresentation.en.story.importantDetails.map((_, index) => `detail-${index}`),
      "outcome",
      ...(parsed.reviewPresentation.en.story.uncertainty ? ["uncertainty"] : []),
    ];
    const peopleBlocks = people.map((person) => `people:${person.id}`);
    const insightBlocks = parsed.reviewPresentation.en.highlights.map((insight) => `insight:${insight.id}`);
    const expectedTraceKinds = new Map([
      ["overview", "factual_claim"] as const,
      ...peopleBlocks.map((blockId) => [blockId, "factual_claim"] as const),
      ...storyBlocks.map((blockId) => [blockId, "factual_claim"] as const),
      ...insightBlocks.map((blockId) => [blockId, "insight_input"] as const),
    ]);
    const referenceBelongsToChapter = (reference: { documentId: string; eventId: string }) => {
      const resolution = resolveEvidenceTarget(evidenceRows, reference.eventId);
      if (resolution.status !== "resolved" || reference.eventId !== resolution.itemId) return false;
      const entry = chapterEvidence.get(JSON.stringify([reference.documentId, resolution.itemId]));
      return Boolean(entry && entry.row.documentId === reference.documentId);
    };
    const referenceResolves = (reference: { documentId: string; eventId: string }) => {
      const resolution = resolveEvidenceTarget(evidenceRows, reference.eventId);
      if (resolution.status !== "resolved" || reference.eventId !== resolution.itemId) return false;
      return evidenceRows[resolution.index]?.documentId === reference.documentId;
    };
    const referenceKey = (reference: { documentId: string; eventId: string }) => (
      JSON.stringify([reference.documentId, reference.eventId])
    );
    const traceability = narrativeReview.claimTraceability;
    if (!traceability?.length) return failure("STORY_CLAIM_TRACEABILITY_INVALID");
    const traceEvidenceByBlock = new Map<string, Set<string>>();
    const traceUnitsByBlock = new Map<string, Set<string>>();
    for (const claim of traceability) {
      const expectedKind = expectedTraceKinds.get(claim.blockId);
      if (!expectedKind || claim.kind !== expectedKind
        || !claim.evidence.length || !claim.evidence.every(referenceBelongsToChapter)) {
        return failure("STORY_CLAIM_TRACEABILITY_INVALID");
      }
      const keysForBlock = traceEvidenceByBlock.get(claim.blockId) || new Set<string>();
      claim.evidence.forEach((reference) => keysForBlock.add(referenceKey(reference)));
      traceEvidenceByBlock.set(claim.blockId, keysForBlock);
      if (claim.unitIds?.length) {
        const unitsForBlock = traceUnitsByBlock.get(claim.blockId) || new Set<string>();
        claim.unitIds.forEach((unitId) => unitsForBlock.add(unitId));
        traceUnitsByBlock.set(claim.blockId, unitsForBlock);
      }
    }
    if ([...expectedTraceKinds.keys()].some((blockId) => !traceEvidenceByBlock.has(blockId))) {
      return failure("STORY_CLAIM_TRACEABILITY_INVALID");
    }

    const retention = narrativeReview.contextRetention;
    if (!retention) return failure("STORY_CONTEXT_RETENTION_INVALID");
    const declaredScope = new Set(retention.sourceScope.map(referenceKey));
    const chapterScope = new Set([
      parsed.evidence.primary,
      ...parsed.evidence.supporting,
    ].map(referenceKey));
    const requiredScope = new Set<string>();
    for (const claim of traceability) {
      if (claim.kind === "factual_claim") {
        claim.evidence.forEach((reference) => requiredScope.add(referenceKey(reference)));
      }
    }
    for (const unit of retention.units) {
      if (unit.state === "represented") requiredScope.add(referenceKey(unit.evidence));
    }
    const sameScope = (left: Set<string>, right: Set<string>) => (
      left.size === right.size && [...left].every((key) => right.has(key))
    );
    if (!retention.sourceScope.every(referenceBelongsToChapter)
      || !sameScope(declaredScope, chapterScope)
      || !sameScope(chapterScope, requiredScope)) {
      return failure("STORY_CONTEXT_RETENTION_INVALID");
    }
    const representedUnits = new Map(retention.units
      .filter((unit) => unit.state === "represented")
      .map((unit) => [unit.id, unit]));
    if (representedUnits.size !== retention.representedUnitCount) {
      return failure("STORY_CONTEXT_RETENTION_INVALID");
    }
    for (const unit of retention.units) {
      if (unit.state === "excluded" && !referenceResolves(unit.evidence)) {
        return failure("STORY_CONTEXT_RETENTION_INVALID");
      }
      if (unit.state === "represented" && !referenceBelongsToChapter(unit.evidence)) {
        return failure("STORY_CONTEXT_RETENTION_INVALID");
      }
      if (unit.state !== "represented") continue;
      const evidenceKeyForUnit = referenceKey(unit.evidence);
      for (const blockId of unit.blockIds) {
        if (!storyBlocks.includes(blockId)
          || !traceUnitsByBlock.get(blockId)?.has(unit.id)
          || !traceEvidenceByBlock.get(blockId)?.has(evidenceKeyForUnit)) {
          return failure("STORY_CONTEXT_RETENTION_INVALID");
        }
      }
    }
    for (const claim of traceability) {
      for (const unitId of claim.unitIds || []) {
        const unit = representedUnits.get(unitId);
        if (!unit || !unit.blockIds.includes(claim.blockId)
          || !unit.evidence || !claim.evidence.some((reference) => (
            referenceKey(reference) === referenceKey(unit.evidence)
          ))) return failure("STORY_CONTEXT_RETENTION_INVALID");
      }
    }

    const coverage = narrativeReview.coverageLedger;
    if (!coverage) return failure("STORY_JUDGMENT_COVERAGE_INVALID");
    for (const key of STORY_COVERAGE_KEYS) {
      const item = coverage[key];
      if (!item) return failure("STORY_JUDGMENT_COVERAGE_INVALID");
      if (item.state === "represented") {
        if (!item.evidence.every(referenceBelongsToChapter)
          || item.blockIds.some((blockId) => key === "participants"
            ? !peopleBlocks.includes(blockId)
            : !storyBlocks.includes(blockId))) {
          return failure("STORY_JUDGMENT_COVERAGE_INVALID");
        }
        for (const blockId of item.blockIds) {
          const claimEvidence = traceEvidenceByBlock.get(blockId);
          if (!claimEvidence || !item.evidence.some((reference) => claimEvidence.has(referenceKey(reference)))) {
            return failure("STORY_JUDGMENT_COVERAGE_INVALID");
          }
        }
      } else if (item.state === "supporting_detail") {
        // Historical artifacts remain parseable, but a new reviewable Chapter must
        // place every supported explanatory unit in a traceable Story block.
        return failure("STORY_CONTEXT_RETENTION_INVALID");
      }
    }
    const requiredRepresentations: Array<[typeof STORY_COVERAGE_KEYS[number], string]> = [
      ["mainProblem", "scene"],
      ["finalAction", "outcome"],
      ["result", "outcome"],
    ];
    if (requiredRepresentations.some(([key, blockId]) => (
      coverage[key].state !== "represented" || !coverage[key].blockIds.includes(blockId)
    ))) return failure("STORY_JUDGMENT_COVERAGE_INVALID");
    const participantCoverage = coverage.participants;
    if (participantCoverage.state !== "represented"
      || JSON.stringify([...participantCoverage.blockIds].sort()) !== JSON.stringify([...peopleBlocks].sort())) {
      return failure("STORY_JUDGMENT_COVERAGE_INVALID");
    }
    const peopleEvidence = new Set(people.flatMap((person) => (person.evidence || []).map(referenceKey)));
    if (JSON.stringify([...new Set(participantCoverage.evidence.map(referenceKey))].sort())
      !== JSON.stringify([...peopleEvidence].sort())) {
      return failure("STORY_JUDGMENT_COVERAGE_INVALID");
    }
    const uncertaintyCoverage = coverage.remainingUncertainty;
    if (parsed.reviewPresentation.en.story.uncertainty) {
      if (uncertaintyCoverage.state !== "represented"
        || !uncertaintyCoverage.blockIds.includes("uncertainty")) {
        return failure("STORY_JUDGMENT_COVERAGE_INVALID");
      }
    } else if (uncertaintyCoverage.state !== "not_supported") {
      return failure("STORY_JUDGMENT_COVERAGE_INVALID");
    }
    annotations.push(parsed);
  }

  if (currentStateChapterCount !== 1 || annotations.at(-1)?.kind !== "current_state") {
    return failure("STORY_CURRENT_STATE_INVALID");
  }

  return {
    ok: true,
    chapterCount: annotations.length,
    canonicalCandidate: JSON.stringify(candidateRows.map((row) => ({ id: row.id, summary: row.summary }))),
  };
}

const successorGenericPhases = new Set([
  ...GENERIC_PHASES,
  "general work",
  "other",
  "later stage",
]);
const successorPhaseLabelPattern = /^[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*(?:\s+[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*)?$/u;

/** Validate staged Story-First source semantics without activating the result
 * into current Review Session, Viewer, or release consumers. */
export function validateSuccessorStorySourcePackage(
  candidateRows: StoryCandidateRow[],
  evidenceRows: StoryEvidenceRow[],
): SuccessorStorySourceValidation {
  if (!candidateRows.length) return successorFailure("SUCCESSOR_STORY_CANDIDATE_MISSING");
  const keys = new Set<string>();
  const completedPhases = new Set<string>();
  const phaseLabels = new Map<string, string>();
  let activePhase = "";

  for (const row of candidateRows) {
    if (!row.summary.startsWith(SUCCESSOR_STORY_PREFIX)) {
      return successorFailure("SUCCESSOR_STORY_CHAPTER_INVALID");
    }
    const parsed = parseStorySource(row.summary);
    if (!parsed || parsed.schema !== "oxygen.story/3") {
      return successorFailure("SUCCESSOR_STORY_CHAPTER_INVALID");
    }
    if (keys.has(parsed.key)) return successorFailure("SUCCESSOR_STORY_KEY_DUPLICATED");
    keys.add(parsed.key);

    const phaseId = parsed.phase.id;
    const phaseLabel = parsed.phase.label.trim();
    const phaseWordCount = phaseLabel.split(/\s+/u).length;
    if (phaseWordCount < 1 || phaseWordCount > 2
      || !successorPhaseLabelPattern.test(phaseLabel)
      || successorGenericPhases.has(normalizedCopy(phaseLabel))) {
      return successorFailure("SUCCESSOR_STORY_PHASE_INVALID");
    }
    const existingPhaseLabel = phaseLabels.get(phaseId);
    if (existingPhaseLabel && existingPhaseLabel !== phaseLabel) {
      return successorFailure("SUCCESSOR_STORY_PHASE_INVALID");
    }
    phaseLabels.set(phaseId, phaseLabel);
    if (phaseId !== activePhase) {
      if (completedPhases.has(phaseId)) {
        return successorFailure("SUCCESSOR_STORY_PHASE_ORDER_INVALID");
      }
      if (activePhase) completedPhases.add(activePhase);
      activePhase = phaseId;
    }

    const chapterEvidence = new Map<string, { row: StoryEvidenceRow; actor: string }>();
    const evidenceReferences = [parsed.evidence.primary, ...parsed.evidence.supporting];
    for (const reference of evidenceReferences) {
      const resolution = resolveEvidenceTarget(evidenceRows, reference.eventId);
      if (resolution.status !== "resolved" || reference.eventId !== resolution.itemId) {
        return successorFailure("SUCCESSOR_STORY_EVIDENCE_INVALID");
      }
      const evidenceRow = evidenceRows[resolution.index];
      if (!evidenceRow || evidenceRow.documentId !== reference.documentId) {
        return successorFailure("SUCCESSOR_STORY_EVIDENCE_INVALID");
      }
      chapterEvidence.set(JSON.stringify([reference.documentId, reference.eventId]), {
        row: evidenceRow,
        actor: actorSignature(evidenceRow),
      });
    }
    const belongsToChapter = (reference: { documentId: string; eventId: string }) => (
      chapterEvidence.has(JSON.stringify([reference.documentId, reference.eventId]))
    );

    if (parsed.people.length === 0) return successorFailure("SUCCESSOR_STORY_PEOPLE_INVALID");
    const requiredActors = new Set([...chapterEvidence.values()].map((entry) => entry.actor).filter(Boolean));
    if (requiredActors.size === 0) return successorFailure("SUCCESSOR_STORY_PEOPLE_INVALID");
    const coveredActors = new Set<string>();
    for (const person of parsed.people) {
      if (!person.evidence.every(belongsToChapter)) {
        return successorFailure("SUCCESSOR_STORY_PEOPLE_INVALID");
      }
      const personActors = new Set(person.evidence.map((reference) => (
        chapterEvidence.get(JSON.stringify([reference.documentId, reference.eventId]))?.actor || ""
      )));
      if (personActors.size !== 1 || personActors.has("")
        || [...personActors].some((actor) => coveredActors.has(actor))) {
        return successorFailure("SUCCESSOR_STORY_PEOPLE_INVALID");
      }
      personActors.forEach((actor) => coveredActors.add(actor));
    }
    if ([...requiredActors].some((actor) => !coveredActors.has(actor))) {
      return successorFailure("SUCCESSOR_STORY_PEOPLE_INVALID");
    }

    const representedEvidence = new Set<string>();
    const storyBlocks = new Map(parsed.story.blocks.map((block) => [block.id, block]));
    for (const block of parsed.story.blocks) {
      if (!block.evidence.every(belongsToChapter)) {
        return successorFailure("SUCCESSOR_STORY_EVIDENCE_INVALID");
      }
      block.evidence.forEach((reference) => representedEvidence.add(
        JSON.stringify([reference.documentId, reference.eventId]),
      ));
    }
    const excludedEvidence = new Set<string>();
    for (const exclusion of parsed.contextRetention.excluded) {
      const key = JSON.stringify([exclusion.evidence.documentId, exclusion.evidence.eventId]);
      if (!belongsToChapter(exclusion.evidence) || representedEvidence.has(key)) {
        return successorFailure("SUCCESSOR_STORY_CONTEXT_RETENTION_INVALID");
      }
      excludedEvidence.add(key);
    }
    if ([...chapterEvidence.keys()].some((key) => (
      !representedEvidence.has(key) && !excludedEvidence.has(key)
    ))) return successorFailure("SUCCESSOR_STORY_CONTEXT_RETENTION_INVALID");

    for (const insight of parsed.insights) {
      const anchoredBlocks = insight.quote.storyBlockIds.map((blockId) => storyBlocks.get(blockId));
      if (anchoredBlocks.some((block) => !block)
        || !insight.evidence.every(belongsToChapter)) {
        return successorFailure("SUCCESSOR_STORY_INSIGHT_GROUNDING_INVALID");
      }
      const anchoredEvidence = new Set(anchoredBlocks.flatMap((block) => (
        block?.evidence.map((reference) => JSON.stringify([reference.documentId, reference.eventId])) || []
      )));
      if (insight.evidence.some((reference) => !anchoredEvidence.has(
        JSON.stringify([reference.documentId, reference.eventId]),
      ))) return successorFailure("SUCCESSOR_STORY_INSIGHT_GROUNDING_INVALID");
    }
  }

  return {
    ok: true,
    chapterCount: candidateRows.length,
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
