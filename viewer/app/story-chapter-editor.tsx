"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import type {
  EvidenceReference,
  StoryHighlightItem,
  StoryLanguage,
  TimelineMilestone,
} from "../lib/timeline";
import { restoreEvidenceOrigin } from "../lib/story-navigation";
import {
  addStoryAnnotation,
  applyAnnotationsToBlock,
  applyChapterReview,
  canMarkChapterReady,
  cancelStoryAnnotation,
  chapterReviewSummary,
  createStoryAnnotation,
  hasStoryAnnotationConflict,
  markChapterReady,
  privacyReviewState,
  returnChapterToReview,
  reviseHighlight,
  storyAnnotationSegments,
  updateInsightReview,
  type ChapterReviewState,
  type PrivacyDecision,
  type StoryAnnotationType,
  type StoryReviewAnnotation,
} from "../lib/story-review";

export type { ChapterReviewState, InsightReview, PrivacyDecision } from "../lib/story-review";

export type ChapterEvidenceContext = {
  storyKey: string;
  language: StoryLanguage;
  scrollTop: number;
  originId: string;
};

type SelectionTarget = {
  blockId: string;
  start: number;
  end: number;
  text: string;
  left: number;
  top: number;
};

const ui = {
  en: {
    back: "Project story", chapter: "Chapter", previous: "Previous chapter", next: "Next chapter",
    aiDraft: "Initial AI draft", humanReview: "Review in progress", reviewedDraft: "Latest revision ready", ready: "Final Release Memory",
    releaseNote: "AI-compressed · human-authoritative review", minRead: "min read",
    people: "People", peoplePrompt: "Who matters in this chapter?", localIdentity: "Local identity · hidden on export", noPeople: "No supported participant was identified for this chapter.",
    story: "Story", setup: "The setup", turn: "The turn", mattered: "What mattered", followed: "What followed", uncertain: "Still uncertain",
    aiInsight: "AI insight", aiInterpretation: "AI interpretation · not historical fact", observation: "Observation", lesson: "Reusable lesson",
    editInsight: "Edit insight", reviseInsight: "Revise insight with AI", acceptInsight: "Accept", removeInsight: "Do not preserve",
    save: "Save", cancel: "Cancel", changeInsight: "How would you like to change this?",
    delete: "Delete", revise: "Revise", add: "Add", revisePrompt: "What should be corrected here?", addPrompt: "What is missing here?",
    instructionPlaceholder: "Describe the correction without rewriting the whole paragraph.", pending: "Pending review", applied: "Applied", needsEvidence: "Needs reviewed evidence", cancelAnnotation: "Cancel annotation", reviewPassage: "Review this passage",
    privacy: "Privacy", privacyPrompt: "What might need to be removed before release?", possibleSensitive: "Possible sensitive content",
    localOriginal: "Local original", unavailable: "Original content unavailable in the reviewed artifact.", sourceLanguage: "Source language",
    whyFlagged: "Why AI flagged it", keep: "Keep", redact: "Redact", reviewComplete: "Privacy review complete", reviewAgain: "Review again",
    evidence: "View local evidence", evidenceNote: "Exact source language · local only · never exported with the release chapter", primary: "Primary anchor", supporting: "Supporting evidence", inspect: "Inspect exact evidence",
    summary: "Review summary", revisions: "revisions", additions: "additions", removals: "removals", privacyDecisions: "privacy decisions",
    privacyBlocks: "Complete every privacy decision before applying review.", apply: "Apply review & prepare release", applyingNote: "Human instructions are authoritative. Unsupported additions are flagged rather than invented.",
    addBlocked: "An addition still needs support from reviewed evidence. Cancel it or return to review before confirming.", insightBlocked: "Review the pending AI insight before confirming.", pendingBlocked: "Resolve every pending review item before confirming.", evidenceSupport: "Use wording that appears in the primary reviewed evidence", evidenceBlocked: "The cited exact evidence could not be resolved. Review the evidence reference before applying.", annotationConflict: "This selection overlaps another pending annotation or no longer matches the current draft. Use separate, current ranges.", translationBlocked: "The paired language is stale. Review the same semantic passage in the other language before confirming.", noPrivacy: "AI found no release concerns in the reviewed artifact.", removedFromRelease: "Removed from release", markReady: "All set", returnReview: "Continue reviewing", reopen: "Reopen review", readyNote: "Human-confirmed locally. This is not publication approval.", revision: "Revision",
  },
  zh: {
    back: "项目故事", chapter: "章节", previous: "上一章", next: "下一章",
    aiDraft: "初始 AI 草稿", humanReview: "审阅进行中", reviewedDraft: "最新修订稿待确认", ready: "最终发布记忆",
    releaseNote: "AI 压缩 · 人工意见优先", minRead: "分钟阅读",
    people: "人物", peoplePrompt: "这一章里，谁最重要？", localIdentity: "本地身份 · 导出时隐藏", noPeople: "这一章没有识别出有证据支持的参与者。",
    story: "故事", setup: "当时的局面", turn: "转折如何发生", mattered: "真正重要的细节", followed: "后来发生了什么", uncertain: "仍不确定",
    aiInsight: "AI 洞察", aiInterpretation: "AI 解释 · 并非历史事实", observation: "观察", lesson: "可复用经验",
    editInsight: "编辑洞察", reviseInsight: "让 AI 修改洞察", acceptInsight: "接受", removeInsight: "不保留",
    save: "保存", cancel: "取消", changeInsight: "你希望怎样修改？",
    delete: "删除", revise: "修订", add: "补充", revisePrompt: "这里应当怎样纠正？", addPrompt: "这里缺少什么？",
    instructionPlaceholder: "说明需要纠正的地方，无需重写整段。", pending: "待处理", applied: "已应用", needsEvidence: "需要已审阅证据支持", cancelAnnotation: "取消批注", reviewPassage: "审阅这段文字",
    privacy: "隐私", privacyPrompt: "发布前，哪些内容可能需要移除？", possibleSensitive: "可能敏感的内容",
    localOriginal: "本地原文", unavailable: "已审阅材料中不包含原始内容。", sourceLanguage: "原文语言",
    whyFlagged: "AI 标记原因", keep: "保留", redact: "移除", reviewComplete: "隐私审阅已完成", reviewAgain: "重新审阅",
    evidence: "查看本地证据", evidenceNote: "保持精确原文 · 仅限本地 · 不随发布章节导出", primary: "主要锚点", supporting: "补充证据", inspect: "查看精确证据",
    summary: "审阅摘要", revisions: "处修订", additions: "处补充", removals: "处删除", privacyDecisions: "项隐私决定",
    privacyBlocks: "应用审阅前，请完成全部隐私决定。", apply: "应用审阅并准备发布", applyingNote: "人工意见优先；缺乏支持的补充会被标记，不会被编造。",
    addBlocked: "仍有补充内容需要已审阅证据支持。请取消该批注或返回审阅后再确认。", insightBlocked: "确认完成前，请先审阅待处理的 AI 洞察。", pendingBlocked: "确认完成前，请先解决所有待处理的审阅项。", evidenceSupport: "使用主要已审阅证据中确实出现的表述", evidenceBlocked: "无法解析本章引用的精确证据。请先检查证据引用，再应用审阅。", annotationConflict: "所选范围与另一条待处理批注重叠，或已不再匹配当前草稿。请使用互不重叠的当前文本范围。", translationBlocked: "另一语言版本仍待同步。请在另一语言中审阅同一语义段落后再确认。", noPrivacy: "AI 未在已审阅材料中发现发布风险。", removedFromRelease: "已从发布稿移除", markReady: "确认完成", returnReview: "继续审阅", reopen: "重新打开审阅", readyNote: "已在本地获得人工确认；这不代表发布审批。", revision: "修订稿",
  },
} as const;

const fmt = (value: string | undefined, language: StoryLanguage) => value
  ? new Date(value).toLocaleString(language === "zh" ? "zh-CN" : "en-US", { dateStyle: "medium", timeStyle: "short" })
  : language === "zh" ? "时间不可用" : "Time unavailable";

const reviewStageLabel = (state: ChapterReviewState, language: StoryLanguage) => {
  const labels = ui[language];
  if (state.stage === "human_confirmed") return labels.ready;
  if (state.stage === "revision_ready") return `${labels.reviewedDraft} · ${labels.revision} ${state.revision}`;
  if (state.revision > 1) return `${labels.humanReview} · ${labels.revision} ${state.revision}`;
  return labels.aiDraft;
};

function annotationLabel(annotation: StoryReviewAnnotation, language: StoryLanguage) {
  const labels = ui[language];
  const type = annotation.type === "delete" ? labels.delete : annotation.type === "revise" ? labels.revise : labels.add;
  const state = annotation.resolution === "applied" ? labels.applied : annotation.resolution === "needs_evidence" ? labels.needsEvidence : labels.pending;
  return `${type} · ${state}`;
}

export function StoryChapterEditor(props: {
  milestone: TimelineMilestone;
  position: number;
  total: number;
  language: StoryLanguage;
  privacyDecisions: Record<string, PrivacyDecision>;
  chapterReview: ChapterReviewState;
  initialScrollTop?: number;
  focusOriginId?: string;
  evidenceError?: string;
  onContextRestored?: () => void;
  onPrivacyDecision: (candidateId: string, decision?: PrivacyDecision) => void;
  onChapterReview: (review: ChapterReviewState) => void;
  onOpenEvidence: (evidence: EvidenceReference, context: ChapterEvidenceContext) => void;
  onClose: () => void;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const {
    milestone, position, total, language, privacyDecisions, chapterReview, initialScrollTop = 0, focusOriginId, evidenceError,
    onContextRestored, onPrivacyDecision, onChapterReview, onOpenEvidence, onClose, onPrevious, onNext,
  } = props;
  const { story } = milestone;
  const episode = story.releaseEpisode;
  const presentation = story.reviewPresentation?.[language];
  const labels = ui[language];
  const articleRef = useRef<HTMLElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const backRef = useRef<HTMLButtonElement | null>(null);
  const restoredContextRef = useRef(false);
  const [selection, setSelection] = useState<SelectionTarget | null>(null);
  const [annotationMode, setAnnotationMode] = useState<Exclude<StoryAnnotationType, "delete"> | null>(null);
  const [instruction, setInstruction] = useState("");
  const [supportAddition, setSupportAddition] = useState(false);
  const [applyError, setApplyError] = useState("");
  const [applying, setApplying] = useState(false);
  const [insightMode, setInsightMode] = useState<"none" | "edit" | "revise">("none");
  const baseHighlight = presentation?.highlights[0];
  const insightReview = baseHighlight ? chapterReview.insightReviews[baseHighlight.id] : undefined;
  const visibleHighlight = insightReview?.localized[language] || baseHighlight;
  const [insightDraft, setInsightDraft] = useState<StoryHighlightItem | undefined>(visibleHighlight);

  useEffect(() => {
    if (restoredContextRef.current) return;
    restoredContextRef.current = true;
    const frame = requestAnimationFrame(() => {
      if (scrollRef.current && initialScrollTop) scrollRef.current.scrollTo({ top: initialScrollTop });
      const origin = focusOriginId ? document.getElementById(focusOriginId) : null;
      restoreEvidenceOrigin(origin, backRef.current);
      onContextRestored?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusOriginId, initialScrollTop, onContextRestored, story.key]);

  const candidates = presentation?.privacy.candidates || [];
  const privacyState = privacyReviewState(candidates, privacyDecisions);
  const summary = chapterReviewSummary(chapterReview);
  const evidence = story.evidence ? [story.evidence.primary, ...story.evidence.supporting] : [];
  const sourceBlocks = (["en", "zh"] as const).reduce<Record<StoryLanguage, Record<string, string>>>((result, locale) => {
    const copy = story.reviewPresentation?.[locale];
    if (!copy) return result;
    const blocks = {
      scene: copy.story.scene,
      ...Object.fromEntries(copy.story.reconstruction.map((paragraph, index) => [`reconstruction-${index}`, paragraph])),
      ...Object.fromEntries(copy.story.importantDetails.map((detail, index) => [`detail-${index}`, detail])),
      outcome: copy.story.decisionOutcome,
      ...(copy.story.uncertainty ? { uncertainty: copy.story.uncertainty } : {}),
    };
    result[locale] = blocks;
    return result;
  }, { en: {}, zh: {} });
  const reviewedBlocks = (["en", "zh"] as const).reduce<Record<StoryLanguage, Record<string, string>>>((result, locale) => {
    result[locale] = Object.fromEntries(Object.entries(sourceBlocks[locale]).map(([blockId, source]) => [
      blockId,
      chapterReview.redactedBlocks.includes(blockId)
        ? ""
        : applyAnnotationsToBlock(source, blockId, locale, chapterReview.annotations),
    ]));
    return result;
  }, { en: {}, zh: {} });
  const applyContext = {
    privacyCandidates: candidates,
    privacyDecisions,
    chapterEvidence: evidence,
    evidenceResolved: chapterReview.evidenceVerified,
    supportedAddIds: [],
    sourceBlocks,
    reviewedBlocks,
  };
  const annotationsByBlock = useMemo(() => chapterReview.annotations.reduce<Record<string, StoryReviewAnnotation[]>>((result, annotation) => {
    if (annotation.resolution !== "cancelled") (result[annotation.blockId] ||= []).push(annotation);
    return result;
  }, {}), [chapterReview.annotations]);

  if (!episode || !presentation || !visibleHighlight || !insightDraft || !story.evidence) return null;

  const clearSelection = () => {
    window.getSelection()?.removeAllRanges();
    setSelection(null);
    setAnnotationMode(null);
    setInstruction("");
    setSupportAddition(false);
    setApplyError("");
  };

  const captureSelection = () => {
    if (chapterReview.stage === "human_confirmed") return;
    const nativeSelection = window.getSelection();
    if (!nativeSelection || nativeSelection.isCollapsed || nativeSelection.rangeCount !== 1) {
      setSelection(null);
      return;
    }
    const range = nativeSelection.getRangeAt(0);
    const copy = (range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentElement
      : range.commonAncestorContainer as Element)?.closest<HTMLElement>("[data-story-copy]");
    const block = copy?.closest<HTMLElement>("[data-story-block]");
    if (!copy || !block || !articleRef.current?.contains(copy) || !copy.contains(range.startContainer) || !copy.contains(range.endContainer)) {
      setSelection(null);
      return;
    }
    const text = range.toString().trim();
    if (text.length < 3) {
      setSelection(null);
      return;
    }
    const leading = range.toString().indexOf(text);
    const prefix = range.cloneRange();
    prefix.selectNodeContents(copy);
    prefix.setEnd(range.startContainer, range.startOffset);
    const start = prefix.toString().length + Math.max(0, leading);
    const rect = range.getBoundingClientRect();
    setSelection({
      blockId: block.dataset.storyBlock || "",
      start,
      end: start + text.length,
      text,
      left: Math.max(12, Math.min(window.innerWidth - 250, rect.left + rect.width / 2 - 120)),
      top: Math.max(12, rect.top - 52),
    });
  };

  const captureKeyboardSelection = (event: ReactKeyboardEvent<HTMLElement>) => {
    const key = event.key.toLowerCase();
    if (chapterReview.stage === "human_confirmed" || (key !== "enter" && key !== " " && key !== "space")) return;
    const block = (event.target as HTMLElement).closest<HTMLElement>("[data-story-block]");
    const copy = block?.querySelector<HTMLElement>("[data-story-copy]");
    const text = copy?.textContent?.trim();
    if (!block || !copy || !text) return;
    event.preventDefault();
    const rect = copy.getBoundingClientRect();
    setSelection({
      blockId: block.dataset.storyBlock || "",
      start: 0,
      end: text.length,
      text,
      left: Math.max(12, Math.min(window.innerWidth - 250, rect.left + Math.min(rect.width / 2, 180))),
      top: Math.max(12, rect.top - 52),
    });
  };

  const captureDoubleClickSelection = (event: ReactMouseEvent<HTMLElement>) => {
    if (chapterReview.stage === "human_confirmed" || String(window.getSelection()).trim()) return;
    const block = (event.target as HTMLElement).closest<HTMLElement>("[data-story-block]");
    const copy = block?.querySelector<HTMLElement>("[data-story-copy]");
    const text = copy?.textContent || "";
    const caret = document.caretRangeFromPoint?.(event.clientX, event.clientY);
    if (!block || !copy || !text || !caret || !copy.contains(caret.startContainer)) return;
    const prefix = document.createRange();
    prefix.selectNodeContents(copy);
    prefix.setEnd(caret.startContainer, caret.startOffset);
    const offset = Math.min(text.length - 1, prefix.toString().length);
    const wordCharacter = (value: string) => /[\p{L}\p{N}_-]/u.test(value);
    let start = offset;
    let end = offset;
    while (start > 0 && wordCharacter(text[start - 1])) start -= 1;
    while (end < text.length && wordCharacter(text[end])) end += 1;
    if (end - start < 2) return;
    setSelection({
      blockId: block.dataset.storyBlock || "",
      start,
      end,
      text: text.slice(start, end),
      left: Math.max(12, Math.min(window.innerWidth - 250, event.clientX - 120)),
      top: Math.max(12, event.clientY - 52),
    });
  };

  const createAnnotation = (type: StoryAnnotationType, textInstruction?: string) => {
    if (!selection) return;
    const annotation = createStoryAnnotation({
      blockId: selection.blockId,
      type,
      sourceLanguage: language,
      selection: { start: selection.start, end: selection.end, text: selection.text },
      baseRevision: chapterReview.revision,
      ...(textInstruction?.trim() ? { instruction: textInstruction.trim() } : {}),
      ...(type === "add" && supportAddition && evidence[0] ? { supportingEvidence: [evidence[0]] } : {}),
    });
    if (hasStoryAnnotationConflict(chapterReview, annotation)) {
      setApplyError(labels.annotationConflict);
      return;
    }
    onChapterReview(addStoryAnnotation(chapterReview, annotation));
    clearSelection();
  };

  const handleApplyReview = async () => {
    setApplying(true);
    setApplyError("");
    try {
      const additions = chapterReview.annotations
        .filter((annotation) => annotation.type === "add" && annotation.resolution === "pending")
        .map((annotation) => ({
          annotationId: annotation.id,
          instruction: annotation.instruction || "",
          supportingEvidence: annotation.supportingEvidence || [],
        }));
      const response = await fetch("/api/evidence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chapterEvidence: evidence, additions }),
      });
      if (!response.ok) throw new Error(labels.evidenceBlocked);
      const verification = await response.json() as { evidenceResolved: boolean; supportedAddIds: string[] };
      const result = applyChapterReview(chapterReview, {
        ...applyContext,
        evidenceResolved: verification.evidenceResolved,
        supportedAddIds: verification.supportedAddIds,
      });
      if (result.blockedReason === "evidence") setApplyError(labels.evidenceBlocked);
      else if (result.blockedReason === "annotations") setApplyError(labels.annotationConflict);
      else onChapterReview(result.state);
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : labels.evidenceBlocked);
    } finally {
      setApplying(false);
    }
  };

  const blockCopy = (blockId: string, source: string) => chapterReview.redactedBlocks.includes(blockId)
    ? ""
    : chapterReview.revision > 1
    ? applyAnnotationsToBlock(source, blockId, language, chapterReview.annotations)
    : source;

  const renderStoryCopy = (blockId: string, copy: string) => storyAnnotationSegments(
    copy, blockId, language, chapterReview.revision, chapterReview.annotations,
  ).map((segment, index) => segment.annotationIds.length
    ? <span className="storyAnnotatedRange" data-annotation-ids={segment.annotationIds.join(" ")} key={`${blockId}-range-${index}`}>{segment.text}</span>
    : segment.text);

  const renderAnnotations = (blockId: string) => (annotationsByBlock[blockId] || []).length ? <div className="storyAnnotations" aria-label={labels.pending} key={`${blockId}-annotations`}>
    {(annotationsByBlock[blockId] || []).map((annotation) => <div className={`storyAnnotation ${annotation.type}`} key={annotation.id}>
      <span>{annotationLabel(annotation, language)}</span>
      <q>{annotation.selection.text}</q>
      {annotation.instruction && <p>{annotation.instruction}</p>}
      {chapterReview.stage !== "human_confirmed" && ["pending", "needs_evidence"].includes(annotation.resolution) && <button onClick={() => onChapterReview(cancelStoryAnnotation(chapterReview, annotation.id))}>{labels.cancelAnnotation}</button>}
    </div>)}
  </div> : null;

  const renderParagraph = (blockId: string, source: string, className?: string) => {
    const copy = blockCopy(blockId, source);
    if (!copy) return renderAnnotations(blockId);
    return <div className={`reviewableStoryBlock ${annotationsByBlock[blockId]?.length ? "annotated" : ""}`} data-story-block={blockId} tabIndex={0} aria-label={labels.reviewPassage} onKeyDown={captureKeyboardSelection} key={blockId}>
      <p className={className} data-story-copy>{renderStoryCopy(blockId, copy)}</p>
      {renderAnnotations(blockId)}
    </div>;
  };

  const renderListItem = (blockId: string, source: string) => {
    const copy = blockCopy(blockId, source);
    if (!copy) return <li key={blockId}>{renderAnnotations(blockId)}</li>;
    return <li className={annotationsByBlock[blockId]?.length ? "annotated" : ""} data-story-block={blockId} key={blockId} tabIndex={0} aria-label={labels.reviewPassage} onKeyDown={captureKeyboardSelection}>
      <span data-story-copy>{renderStoryCopy(blockId, copy)}</span>{renderAnnotations(blockId)}
    </li>;
  };

  const visiblePeople = presentation.people.filter((person) => !chapterReview.redactedBlocks.includes(`people:${person.id}`));
  const insightSuppressed = chapterReview.redactedBlocks.includes(`insight:${visibleHighlight.id}`)
    || (insightReview?.status === "rejected" && insightReview.resolution === "applied");

  const saveInsightEdit = () => {
    onChapterReview(updateInsightReview(chapterReview, visibleHighlight.id, language, { status: "overridden", text: insightDraft.lesson.trim(), highlight: insightDraft, revision: "direct" }));
    setInsightMode("none");
  };
  const applyInsightRevision = () => {
    const revised = reviseHighlight(visibleHighlight, instruction, language);
    if (!revised) return;
    setInsightDraft(revised);
    onChapterReview(updateInsightReview(chapterReview, visibleHighlight.id, language, { status: "overridden", text: revised.lesson, highlight: revised, revision: "ai" }));
    setInstruction("");
    setInsightMode("none");
  };

  const handleToolbarMouseDown = (event: ReactMouseEvent) => event.preventDefault();

  return <section className="simpleEpisode chapterEditor" role="region" aria-labelledby="episode-title">
    <div className="simpleEpisodeChrome">
      <button className="episodeBackLink" ref={backRef} onClick={onClose}>← {labels.back}</button>
      <div className="simpleEpisodePosition">{labels.chapter} {position} / {total}</div>
      <div className="simpleEpisodeNav">
        <button onClick={onPrevious} disabled={position === 1} aria-label={labels.previous}>←</button>
        <button onClick={onNext} disabled={position === total} aria-label={labels.next}>→</button>
      </div>
    </div>

    <div className="simpleEpisodeScroll" ref={scrollRef}>
      <header className="simpleEpisodeHero">
        <div className="releaseDraftLabel"><b>{reviewStageLabel(chapterReview, language)}</b><span>{labels.releaseNote}</span></div>
        <div className="simpleEpisodeMeta"><span>{blockCopy("phase", presentation.phase) || labels.removedFromRelease}</span><time>{fmt(episode.startTimestamp || milestone.timestamp, language)}</time><span>≈ {episode.readingTimeMinutes} {labels.minRead}</span></div>
        <h2 id="episode-title">{blockCopy("title", presentation.title) || labels.removedFromRelease}</h2>
        <p className="episodeOverview">{blockCopy("overview", presentation.overview) || labels.removedFromRelease}</p>
      </header>

      <div className="simpleEpisodeBody">
        <section className="episodePrimarySection peopleSection" data-episode-section="people" aria-labelledby="people-heading">
          <div className="simpleSectionHead"><div><h3 id="people-heading">{labels.people}</h3><p>{labels.peoplePrompt}</p></div></div>
          {visiblePeople.length ? <div className="peopleList">{visiblePeople.map((person) => <div className="personRow" key={person.id}>
            <b aria-label={person.releaseLabel}>{person.releaseLabel}</b><div><strong>{person.role}</strong><p>{person.description}</p></div>
          </div>)}</div> : <p className="emptySectionCopy">{labels.noPeople}</p>}
          {visiblePeople.length > 0 && <p className="identityNote">{labels.localIdentity}</p>}
        </section>

        <section className="episodePrimarySection storySection" data-episode-section="story" aria-labelledby="story-heading">
          <div className="simpleSectionHead"><div><h3 id="story-heading">{labels.story}</h3></div></div>
          <article className="chapterArticle" ref={articleRef} onMouseUp={captureSelection} onKeyUp={captureSelection} onDoubleClick={captureDoubleClickSelection}>
            <h4>{labels.setup}</h4>
            {renderParagraph("scene", presentation.story.scene, "chapterLead")}
            <h4>{labels.turn}</h4>
            {presentation.story.reconstruction.map((paragraph, index) => renderParagraph(`reconstruction-${index}`, paragraph))}

            {!insightSuppressed && <aside className={`inlineInsight ${insightReview?.status === "rejected" ? "rejected" : ""}`} data-inline-insight={visibleHighlight.id}>
              <div className="inlineInsightHead"><span>{labels.aiInsight}</span><small>{labels.aiInterpretation}</small>{chapterReview.stage !== "human_confirmed" && <div>
                <button title={labels.editInsight} aria-label={labels.editInsight} onClick={() => setInsightMode(insightMode === "edit" ? "none" : "edit")}>{language === "zh" ? "编辑" : "Edit"}</button>
                <button title={labels.reviseInsight} aria-label={labels.reviseInsight} onClick={() => setInsightMode(insightMode === "revise" ? "none" : "revise")}>{language === "zh" ? "修改" : "Revise"}</button>
              </div>}</div>
              {insightMode === "edit" ? <div className="inlineInsightEdit">
                <label>{language === "zh" ? "标题" : "Title"}<input value={insightDraft.title} onChange={(event) => setInsightDraft({ ...insightDraft, title: event.target.value })} /></label>
                <label>{labels.observation}<textarea rows={3} value={insightDraft.noticed} onChange={(event) => setInsightDraft({ ...insightDraft, noticed: event.target.value })} /></label>
                <label>{labels.lesson}<textarea rows={3} value={insightDraft.lesson} onChange={(event) => setInsightDraft({ ...insightDraft, lesson: event.target.value })} /></label>
                <div className="compactActions"><button className="primary" disabled={!insightDraft.title.trim() || !insightDraft.noticed.trim() || !insightDraft.lesson.trim()} onClick={saveInsightEdit}>{labels.save}</button><button onClick={() => setInsightMode("none")}>{labels.cancel}</button></div>
              </div> : insightMode === "revise" ? <div className="inlineInsightEdit"><label>{labels.changeInsight}<textarea rows={3} value={instruction} onChange={(event) => setInstruction(event.target.value)} /></label><div className="compactActions"><button className="primary" disabled={!instruction.trim()} onClick={applyInsightRevision}>{labels.save}</button><button onClick={() => setInsightMode("none")}>{labels.cancel}</button></div></div> : <>
                <h5>{visibleHighlight.title}</h5><dl><div><dt>{labels.observation}</dt><dd>{visibleHighlight.noticed}</dd></div><div><dt>{labels.lesson}</dt><dd>{visibleHighlight.lesson}</dd></div></dl>
                {chapterReview.stage !== "human_confirmed" && <div className="inlineInsightReview"><button onClick={() => onChapterReview(updateInsightReview(chapterReview, visibleHighlight.id, language, { status: "accepted", text: visibleHighlight.lesson }))}>{labels.acceptInsight}</button><button onClick={() => onChapterReview(updateInsightReview(chapterReview, visibleHighlight.id, language, { status: "rejected", text: visibleHighlight.lesson }))}>{labels.removeInsight}</button></div>}
              </>}
            </aside>}

            <h4>{labels.mattered}</h4>
            <ul>{presentation.story.importantDetails.map((detail, index) => renderListItem(`detail-${index}`, detail))}</ul>
            <h4>{labels.followed}</h4>
            {renderParagraph("outcome", presentation.story.decisionOutcome)}
            {presentation.story.uncertainty && <div className="storyUncertainty"><b>{labels.uncertain}:</b>{renderParagraph("uncertainty", presentation.story.uncertainty)}</div>}
          </article>
        </section>

        <section className="episodePrimarySection privacySection" data-episode-section="privacy" aria-labelledby="privacy-heading">
          <div className="simpleSectionHead"><div><h3 id="privacy-heading">{labels.privacy}</h3><p>{labels.privacyPrompt}</p></div></div>
          <p className="privacySummary">{candidates.length ? presentation.privacy.summary : labels.noPrivacy}</p>
          {privacyState.active ? <article className="privacyDecisionCard" data-privacy-candidate={privacyState.active.id}>
            <div className="privacyProgress"><span>{privacyState.reviewed + 1} / {candidates.length}</span><span>{labels.possibleSensitive}</span></div>
            <h4>{privacyState.active.title}</h4>
            <div className="privacyContext"><section><h5>{labels.localOriginal}</h5>{privacyState.active.original.availability === "available"
              ? <><blockquote lang={privacyState.active.original.sourceLanguage}>{privacyState.active.original.excerpt}</blockquote><small>{labels.sourceLanguage}: {privacyState.active.original.sourceLanguage?.toUpperCase()}</small></>
              : <p className="privacyUnavailable">{labels.unavailable}</p>}</section>
              <section><h5>{labels.whyFlagged}</h5><p>{privacyState.active.whyFlagged}</p></section></div>
            <div className="privacyActions"><button onClick={() => onPrivacyDecision(privacyState.active!.id, "keep")}>{labels.keep}</button><button className="primary" onClick={() => onPrivacyDecision(privacyState.active!.id, "redact")}>{labels.redact} →</button></div>
          </article> : <div className="privacyComplete"><b>{labels.reviewComplete}</b><span>{privacyState.reviewed} / {candidates.length}</span>{chapterReview.stage !== "human_confirmed" && <button onClick={() => { candidates.forEach((candidate) => onPrivacyDecision(candidate.id, undefined)); onChapterReview(returnChapterToReview(chapterReview)); }}>{labels.reviewAgain}</button>}</div>}
        </section>

        <details className="localEvidenceDisclosure">
          <summary>{labels.evidence} → <span>{evidence.length}</span></summary><p>{labels.evidenceNote}</p>
          {evidenceError && <p className="completionBlocker" role="alert">{evidenceError}</p>}
          <div>{evidence.map((item, index) => { const originId=`chapter-evidence-${index}`; return <button id={originId} key={`${item.documentId}:${item.eventId}`} onClick={() => onOpenEvidence(item, { storyKey: story.key, language, scrollTop: scrollRef.current?.scrollTop || 0, originId })}>
            <span>{index === 0 ? labels.primary : item.label || labels.supporting}</span><code>{item.documentId} / {item.eventId}</code><b>{labels.inspect} →</b>
          </button>})}</div>
        </details>

        <section className="chapterCompletion" aria-labelledby="review-summary-heading">
          <div><span>{reviewStageLabel(chapterReview, language)}</span><h3 id="review-summary-heading">{labels.summary}</h3></div>
          <ul><li><b>{summary.revise}</b> {labels.revisions}</li><li><b>{summary.add}</b> {labels.additions}</li><li><b>{summary.delete}</b> {labels.removals}</li><li><b>{privacyState.reviewed} / {candidates.length}</b> {labels.privacyDecisions}</li></ul>
          <p>{labels.applyingNote}</p>
          {!privacyState.complete && <p className="completionBlocker">{labels.privacyBlocks}</p>}
          {applyError && <p className="completionBlocker" role="alert">{applyError}</p>}
          {chapterReview.staleTranslations.length > 0 && <p className="completionBlocker">{labels.translationBlocked}</p>}
          {chapterReview.stage === "reviewing" ? <button className="completionPrimary" disabled={!privacyState.complete || applying} onClick={handleApplyReview}>{labels.apply}</button> : chapterReview.stage === "revision_ready" ? <>
            {summary.needsEvidenceAdd > 0 && <p className="completionBlocker">{labels.addBlocked}</p>}
            <div className="completionActions"><span>{summary.needsEvidenceAdd > 0 ? labels.addBlocked : summary.pendingInsights > 0 ? labels.insightBlocked : summary.pendingAnnotations > 0 ? labels.pendingBlocked : chapterReview.staleTranslations.length > 0 ? labels.translationBlocked : language === "zh" ? "没有待应用的批注" : "No pending annotations"}</span><button className="completionPrimary" disabled={!canMarkChapterReady(chapterReview, applyContext)} onClick={() => onChapterReview(markChapterReady(chapterReview, applyContext))}>{labels.markReady}</button></div>
          </> : <div className="readyConfirmation"><b>{labels.ready}</b><p>{labels.readyNote}</p><button onClick={() => onChapterReview(returnChapterToReview(chapterReview))}>{labels.reopen}</button></div>}
        </section>
      </div>
    </div>

    {selection && <div className="selectionToolbar" role="toolbar" aria-label={labels.pending} style={{ left: selection.left, top: selection.top }} onMouseDown={handleToolbarMouseDown}>
      <button title={labels.delete} aria-label={labels.delete} onClick={() => createAnnotation("delete")}><span>{labels.delete}</span></button>
      <button title={labels.revise} aria-label={labels.revise} onClick={() => setAnnotationMode("revise")}><span>{labels.revise}</span></button>
      <button title={labels.add} aria-label={labels.add} onClick={() => setAnnotationMode("add")}><span>{labels.add}</span></button>
      {annotationMode && <form className="selectionPrompt" onSubmit={(event) => { event.preventDefault(); createAnnotation(annotationMode, instruction); }}>
        <label>{annotationMode === "revise" ? labels.revisePrompt : labels.addPrompt}<textarea autoFocus rows={3} value={instruction} placeholder={labels.instructionPlaceholder} onChange={(event) => setInstruction(event.target.value)} /></label>
        {annotationMode === "add" && evidence[0] && <label className="selectionEvidenceSupport"><input type="checkbox" checked={supportAddition} onChange={(event) => setSupportAddition(event.target.checked)} />{labels.evidenceSupport}</label>}
        <div><button type="button" onClick={clearSelection}>{labels.cancel}</button><button type="submit" disabled={!instruction.trim()}>{labels.save}</button></div>
      </form>}
    </div>}
  </section>;
}
