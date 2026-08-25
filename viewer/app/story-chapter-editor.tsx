"use client";

import { useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type CompositionEvent as ReactCompositionEvent, type FormEvent as ReactFormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type SyntheticEvent } from "react";
import type {
  EvidenceReference,
  StoryHighlightItem,
  StoryLanguage,
  TimelineMilestone,
} from "../lib/timeline";
import { restoreEvidenceOrigin } from "../lib/story-navigation";
import {
  applyChapterReview,
  applyStoryReviewToBlock,
  canRedoStoryEdit,
  canMarkChapterReady,
  canUndoStoryEdit,
  cancelStoryAnnotation,
  chapterReviewSummary,
  discardStoryEdit,
  deriveDirectStoryMutation,
  insightReviewFeedbackState,
  markChapterReady,
  normalizeDirectBeforeInput,
  privacyReviewState,
  recordStoryEdit,
  redoStoryEdit,
  revertAppliedStoryEdit,
  returnChapterToReview,
  reviseHighlight,
  sanitizeStoryPaste,
  storyAnnotationSegments,
  storyEditSegments,
  storyWorkingBlock,
  undoStoryEdit,
  updateInsightReview,
  type ChapterReviewState,
  type DirectStoryMutation,
  type PrivacyDecision,
  type StoryEditTransaction,
  type StoryReviewAnnotation,
} from "../lib/story-review";

export type { ChapterReviewState, InsightReview, PrivacyDecision } from "../lib/story-review";

export type ChapterEvidenceContext = {
  storyKey: string;
  language: StoryLanguage;
  scrollTop: number;
  originId: string;
};

type PendingDirectInput = {
  blockId: string;
  mutation: DirectStoryMutation | null;
};

type ActiveComposition = {
  blockId: string;
  previousText: string;
};

type CompletedComposition = {
  blockId: string;
  nextText: string;
};

const ui = {
  en: {
    back: "Project story", chapter: "Chapter", previous: "Previous chapter", next: "Next chapter",
    aiDraft: "Initial AI draft", humanReview: "Review in progress", reviewedDraft: "Latest revision ready", ready: "Final Release Memory",
    releaseNote: "AI-organized · human-authoritative review", minRead: "min read",
    people: "People", peoplePrompt: "Who matters in this chapter?", localIdentity: "Local identity · hidden on export", participantRequired: "Participant evidence is required before this Chapter can be reviewed.", peopleHidden: "Participant roles are hidden by the current Privacy review.",
    story: "Story", background: "Background", decisionProcess: "Decision process", result: "Result", openQuestions: "Open questions",
    chapterGuide: "Read the Chapter, edit the Story where needed, review AI Insight and Privacy, then Apply review. Only All set confirms the final memory.",
    storyReadHelp: "Choose Edit to change the Story. Every change stays reviewable before it is applied.", storyEditHelp: "Type directly in the Story. Undo or discard any change. Apply Review when the draft is ready.",
    editStory: "Edit Story", finishEditing: "Finish editing", editingStory: "Editing Story", editMode: "Story Edit Mode", readMode: "Story read mode",
    editInstruction: "Edit one Story passage at a time. Click to type, or select text to replace or delete. Every change is recorded as a note; a cross-passage change is rejected without changing either passage.", undo: "Undo", redo: "Redo", noUndo: "Nothing to undo", noRedo: "Nothing to redo",
    aiInsight: "AI insight", aiInterpretation: "AI interpretation · separate from historical fact", observation: "Direct learning", lesson: "Reusable rule", completeInsight: "Complete Chapter insight",
    contextualInsight: "AI insight", contextualPrompt: "Select or click a Story passage to review its participant interaction, narrative explanation, and reusable rule.", selectedPassage: "Selected passage", whatHappened: "What was happening", whyMattered: "Why this mattered", learned: "What we learned", showContext: "Show AI insight", hideContext: "Hide AI insight", previousInsight: "Previous AI insight", nextInsight: "Next AI insight",
    editInsight: "Edit insight", reviseInsight: "Revise insight with AI", acceptInsight: "Accept", removeInsight: "Do not preserve",
    acceptedPending: "Accepted — pending Apply review", rejectedPending: "Marked Do not preserve — pending Apply review", changedPending: "Insight changes — pending Apply review", acceptedApplied: "Accepted Insight applied in revision", rejectedApplied: "Do not preserve applied in revision", changedApplied: "Insight changes applied in revision",
    save: "Save", cancel: "Cancel", changeInsight: "How would you like to change this?",
    delete: "Delete", revise: "Revise", add: "Add",
    pending: "Pending review", applied: "Applied", needsEvidence: "Needs reviewed evidence", cancelAnnotation: "Cancel annotation", discardEdit: "Discard", revertEdit: "Revert in a new revision", reviewPassage: "Review this passage", marginNotes: "Story review notes", focusAnnotation: "Show annotated passage", focusEdit: "Show edited passage",
    privacy: "Privacy", privacyPrompt: "What might need to be removed before release?", possibleSensitive: "Possible sensitive content",
    localOriginal: "Local original", unavailable: "Original content unavailable in the reviewed artifact.", sourceLanguage: "Source language",
    whyFlagged: "Why AI flagged it", keep: "Keep", redact: "Redact", reviewComplete: "Privacy review complete", reviewAgain: "Review again",
    evidence: "View local evidence", evidenceNote: "Exact source language · local only · never exported with the release chapter", primary: "Primary anchor", supporting: "Supporting evidence", inspect: "Inspect exact evidence",
    summary: "Review summary", revisions: "revisions", additions: "additions", removals: "removals", privacyDecisions: "privacy decisions", insightDecisions: "pending Insight decisions",
    privacyBlocks: "Complete every privacy decision before applying review.", apply: "Apply current review", applyingNote: "Apply creates another revised draft for you to inspect. It does not finalize or publish this Chapter.",
    addBlocked: "An addition still needs support from reviewed evidence. Cancel it or return to review before confirming.", directEvidenceBlocked: "A Story edit introduces a new factual claim that is not supported by the reviewed evidence. Inspect or discard that edit before applying.", insightBlocked: "Review the pending AI insight before confirming.", pendingBlocked: "Resolve every pending review item before confirming.", evidenceSupport: "Use wording that appears in the primary reviewed evidence", evidenceBlocked: "The cited exact evidence could not be resolved. Review the evidence reference before applying.", annotationConflict: "This selection overlaps another pending change or no longer matches the current draft. Keep edits within one current passage.", directEditConflict: "That mutation crosses or overlaps controlled edits. Undo or discard the affected note, then edit one passage at a time.", crossBlock: "Edit one Story passage at a time. Cross-passage changes were not applied.", translationBlocked: "The optional paired language is out of date. This does not block the canonical English review.", noPrivacy: "AI found no release concerns in the reviewed artifact.", removedFromRelease: "Removed from release", markReady: "All set", returnReview: "Continue reviewing", reopen: "Reopen review", readyNote: "Human-confirmed locally. This is not publication approval.", revision: "Revision", noPending: "No pending changes. Inspect the latest revision, then choose All set.",
  },
  zh: {
    back: "项目故事", chapter: "章节", previous: "上一章", next: "下一章",
    aiDraft: "初始 AI 草稿", humanReview: "审阅进行中", reviewedDraft: "最新修订稿待确认", ready: "最终发布记忆",
    releaseNote: "AI 组织 · 人工意见优先", minRead: "分钟阅读",
    people: "人物", peoplePrompt: "这一章里，谁最重要？", localIdentity: "本地身份 · 导出时隐藏", participantRequired: "本章必须有参与者证据，才能进入审阅。", peopleHidden: "当前隐私审阅已隐藏参与者角色。",
    story: "故事", background: "背景", decisionProcess: "决策过程", result: "结果", openQuestions: "待确认问题",
    chapterGuide: "先阅读章节；如需调整，再编辑故事并审阅 AI 洞察与隐私，然后应用审阅。只有“确认完成”才会确认最终记忆。",
    storyReadHelp: "选择“编辑”即可修改故事；所有改动都会保留为可审阅记录，应用前不会定稿。", storyEditHelp: "直接修改故事文字；任何改动都可以撤销或丢弃。草稿就绪后再应用审阅。",
    editStory: "编辑故事", finishEditing: "结束编辑", editingStory: "正在编辑故事", editMode: "故事编辑模式", readMode: "故事阅读模式",
    editInstruction: "每次只编辑一个故事段落。点击即可输入，或选中文字进行替换、删除；每项改动都会记录为批注，跨段操作会被完整拒绝且不会改动任何段落。", undo: "撤销", redo: "重做", noUndo: "没有可撤销的改动", noRedo: "没有可重做的改动",
    aiInsight: "AI 洞察", aiInterpretation: "AI 解释 · 与历史事实分开", observation: "直接经验", lesson: "可复用规则", completeInsight: "完整章节洞察",
    contextualInsight: "AI 洞察", contextualPrompt: "选择或点击故事段落，查看参与者互动、叙事讲解和可复用规则。", selectedPassage: "所选段落", whatHappened: "当时发生了什么", whyMattered: "为什么重要", learned: "我们学到了什么", showContext: "显示 AI 洞察", hideContext: "收起 AI 洞察", previousInsight: "上一条 AI 洞察", nextInsight: "下一条 AI 洞察",
    editInsight: "编辑洞察", reviseInsight: "让 AI 修改洞察", acceptInsight: "接受", removeInsight: "不保留",
    acceptedPending: "已接受——待应用审阅", rejectedPending: "已标记“不保留”——待应用审阅", changedPending: "洞察改动——待应用审阅", acceptedApplied: "已接受的洞察已应用于修订稿", rejectedApplied: "“不保留”决定已应用于修订稿", changedApplied: "洞察改动已应用于修订稿",
    save: "保存", cancel: "取消", changeInsight: "你希望怎样修改？",
    delete: "删除", revise: "修订", add: "补充",
    pending: "待处理", applied: "已应用", needsEvidence: "需要已审阅证据支持", cancelAnnotation: "取消批注", discardEdit: "丢弃", revertEdit: "在新修订中还原", reviewPassage: "审阅这段文字", marginNotes: "故事审阅批注", focusAnnotation: "定位批注原文", focusEdit: "定位修改位置",
    privacy: "隐私", privacyPrompt: "发布前，哪些内容可能需要移除？", possibleSensitive: "可能敏感的内容",
    localOriginal: "本地原文", unavailable: "已审阅材料中不包含原始内容。", sourceLanguage: "原文语言",
    whyFlagged: "AI 标记原因", keep: "保留", redact: "移除", reviewComplete: "隐私审阅已完成", reviewAgain: "重新审阅",
    evidence: "查看本地证据", evidenceNote: "保持精确原文 · 仅限本地 · 不随发布章节导出", primary: "主要锚点", supporting: "补充证据", inspect: "查看精确证据",
    summary: "审阅摘要", revisions: "处修订", additions: "处补充", removals: "处删除", privacyDecisions: "项隐私决定", insightDecisions: "项待应用洞察决定",
    privacyBlocks: "应用审阅前，请完成全部隐私决定。", apply: "应用当前审阅", applyingNote: "应用后会生成一版新的修订草稿供你再次检查；这不会定稿或发布本章。",
    addBlocked: "仍有补充内容需要已审阅证据支持。请取消该批注或返回审阅后再确认。", directEvidenceBlocked: "有一项故事改动引入了已审阅证据无法支持的新事实。请检查或丢弃该改动后再应用。", insightBlocked: "确认完成前，请先审阅待处理的 AI 洞察。", pendingBlocked: "确认完成前，请先解决所有待处理的审阅项。", evidenceSupport: "使用主要已审阅证据中确实出现的表述", evidenceBlocked: "无法解析本章引用的精确证据。请先检查证据引用，再应用审阅。", annotationConflict: "所选范围与另一项待处理改动重叠，或已不再匹配当前草稿。请只修改当前段落。", directEditConflict: "该操作跨越或重叠了受控改动。请先撤销或丢弃相关批注，再逐段修改。", crossBlock: "每次只编辑一个故事段落；跨段改动未被应用。", translationBlocked: "可选中文版本尚未同步；这不会阻塞英文主版本的审阅。", noPrivacy: "AI 未在已审阅材料中发现发布风险。", removedFromRelease: "已从发布稿移除", markReady: "确认完成", returnReview: "继续审阅", reopen: "重新打开审阅", readyNote: "已在本地获得人工确认；这不代表发布审批。", revision: "修订稿", noPending: "没有待应用的改动。请检查最新修订稿，然后选择“确认完成”。",
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
  return `${type} · ${state} · ${annotation.sourceLanguage.toUpperCase()}`;
}

function editTransactionLabel(transaction: StoryEditTransaction, language: StoryLanguage) {
  const labels = ui[language];
  const operation = transaction.operation === "delete" ? labels.delete : transaction.operation === "replace" ? labels.revise : labels.add;
  const state = transaction.resolution === "applied" ? labels.applied : transaction.resolution === "needs_evidence" ? labels.needsEvidence : labels.pending;
  return `${operation} · ${state} · ${transaction.sourceLanguage.toUpperCase()}`;
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
  const editorRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const pendingDirectInputRef = useRef<PendingDirectInput | null>(null);
  const activeCompositionRef = useRef<ActiveComposition | null>(null);
  const completedCompositionRef = useRef<CompletedComposition | null>(null);
  const backRef = useRef<HTMLButtonElement | null>(null);
  const restoredContextRef = useRef(false);
  const [editMode, setEditMode] = useState(false);
  const [contextTarget, setContextTarget] = useState<{ blockId: string; quote?: string } | null>(null);
  const [contextCollapsed, setContextCollapsed] = useState(false);
  const [focusedAnnotationId, setFocusedAnnotationId] = useState("");
  const [focusedEditId, setFocusedEditId] = useState("");
  const compositionOwner = `${story.key}\u0000${language}`;
  const [compositionDraftState, setCompositionDraftState] = useState<{
    owner: string;
    drafts: Record<string, string>;
  }>({ owner: compositionOwner, drafts: {} });
  const compositionDrafts = compositionDraftState.owner === compositionOwner ? compositionDraftState.drafts : {};
  const setCompositionDrafts = (update: Record<string, string> | ((drafts: Record<string, string>) => Record<string, string>)) => {
    setCompositionDraftState((current) => {
      const currentDrafts = current.owner === compositionOwner ? current.drafts : {};
      return {
        owner: compositionOwner,
        drafts: typeof update === "function" ? update(currentDrafts) : update,
      };
    });
  };
  const [instruction, setInstruction] = useState("");
  const [applyError, setApplyError] = useState("");
  const [applying, setApplying] = useState(false);
  const [insightMode, setInsightMode] = useState<"none" | "edit" | "revise">("none");
  const baseHighlight = presentation?.highlights[0];
  const insightReview = baseHighlight ? chapterReview.insightReviews[baseHighlight.id] : undefined;
  const visibleHighlight = insightReview?.localized[language] || baseHighlight;
  const [insightDraft, setInsightDraft] = useState<StoryHighlightItem | undefined>(visibleHighlight);
  const leaveEditMode = () => {
    pendingDirectInputRef.current = null;
    activeCompositionRef.current = null;
    completedCompositionRef.current = null;
    setCompositionDrafts({});
    setEditMode(false);
    setApplyError("");
  };

  useEffect(() => {
    pendingDirectInputRef.current = null;
    activeCompositionRef.current = null;
    completedCompositionRef.current = null;
  }, [language, story.key]);

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
        : applyStoryReviewToBlock(source, blockId, locale, chapterReview),
    ]));
    return result;
  }, { en: {}, zh: {} });
  const applyContext = {
    storyKey: story.key,
    privacyCandidates: candidates,
    privacyDecisions,
    reviewableInsightIds: baseHighlight ? [baseHighlight.id] : [],
    chapterEvidence: evidence,
    evidenceResolved: chapterReview.evidenceVerified,
    supportedAddIds: [],
    sourceBlocks,
    reviewedBlocks,
  };
  const activeAnnotationsByBlock = useMemo(() => chapterReview.annotations.reduce<Record<string, StoryReviewAnnotation[]>>((result, annotation) => {
    if (annotation.sourceLanguage === language && annotation.resolution !== "cancelled") (result[annotation.blockId] ||= []).push(annotation);
    return result;
  }, {}), [chapterReview.annotations, language]);
  const noteAnnotationsByBlock = useMemo(() => chapterReview.annotations.reduce<Record<string, StoryReviewAnnotation[]>>((result, annotation) => {
    if (annotation.resolution !== "cancelled") (result[annotation.blockId] ||= []).push(annotation);
    return result;
  }, {}), [chapterReview.annotations]);
  const activeEditsByBlock = useMemo(() => chapterReview.editTransactions.reduce<Record<string, StoryEditTransaction[]>>((result, transaction) => {
    if (transaction.storyKey === story.key && transaction.sourceLanguage === language && transaction.resolution !== "reverted") {
      (result[transaction.blockId] ||= []).push(transaction);
    }
    return result;
  }, {}), [chapterReview.editTransactions, language, story.key]);
  const noteEditsByBlock = useMemo(() => chapterReview.editTransactions.reduce<Record<string, StoryEditTransaction[]>>((result, transaction) => {
    if (transaction.storyKey === story.key && transaction.resolution !== "reverted") (result[transaction.blockId] ||= []).push(transaction);
    return result;
  }, {}), [chapterReview.editTransactions, story.key]);

  if (!episode || !presentation || !visibleHighlight || !insightDraft || !story.evidence) return null;
  if (presentation.people.length === 0) return <section className="simpleEpisode chapterEditor" role="region" aria-label={labels.chapter}>
    <div className="simpleEpisodeChrome"><div className="chapterCanvas chapterChromeCanvas"><button className="episodeBackLink" ref={backRef} onClick={onClose}>← {labels.back}</button></div></div>
    <div className="chapterCanvas"><p className="completionBlocker" role="alert">{labels.participantRequired}</p></div>
  </section>;

  const orderedPassageIds = [
    "scene",
    ...presentation.story.reconstruction.map((_, index) => `reconstruction-${index}`),
    ...presentation.story.importantDetails.map((_, index) => `detail-${index}`),
    "outcome",
    ...(presentation.story.uncertainty ? ["uncertainty"] : []),
  ];
  const activePassageId = contextTarget && orderedPassageIds.includes(contextTarget.blockId)
    ? contextTarget.blockId
    : orderedPassageIds[0];
  const activePassageIndex = activePassageId ? orderedPassageIds.indexOf(activePassageId) : -1;
  const activePassageContext = activePassageId ? presentation.passageContext[activePassageId] : undefined;

  const activateStoryBlockFromKeyboard = (event: ReactKeyboardEvent<HTMLElement>) => {
    const key = event.key.toLowerCase();
    if (key !== "enter" && key !== " " && key !== "space") return;
    const block = (event.target as HTMLElement).closest<HTMLElement>("[data-story-block]");
    if (!block) return;
    event.preventDefault();
    activatePassage(block.dataset.storyBlock || "");
  };

  const scrollToPassage = (blockId: string, focus = false) => {
    requestAnimationFrame(() => {
      const blocks = Array.from(articleRef.current?.querySelectorAll<HTMLElement>("[data-story-block]") || []);
      const block = blocks.find((candidate) => candidate.dataset.storyBlock === blockId);
      const behavior = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
      block?.scrollIntoView({ block: "center", behavior });
      if (focus) (editorRefs.current[blockId] || block)?.focus({ preventScroll: true });
    });
  };

  const activatePassage = (blockId: string, quote?: string, scroll = false) => {
    if (!orderedPassageIds.includes(blockId)) return;
    setContextTarget({ blockId, ...(quote ? { quote } : {}) });
    if (scroll) scrollToPassage(blockId);
  };

  const navigatePassage = (direction: -1 | 1) => {
    if (activePassageIndex < 0) return;
    const nextId = orderedPassageIds[activePassageIndex + direction];
    if (nextId) activatePassage(nextId, undefined, true);
  };

  const restoreEditorSelection = (blockId: string, start: number, end = start) => {
    requestAnimationFrame(() => {
      const editor = editorRefs.current[blockId];
      if (!editor) return;
      editor.focus({ preventScroll: true });
      const boundedStart = Math.min(start, editor.value.length);
      editor.setSelectionRange(boundedStart, Math.min(end, editor.value.length));
    });
  };

  const enterStoryEditMode = (blockId?: string, start = 0, end = start) => {
    if (chapterReview.stage === "human_confirmed") return;
    setApplyError("");
    if (blockId) activatePassage(blockId);
    setEditMode(true);
    if (blockId) restoreEditorSelection(blockId, start, end);
  };

  const handleStoryDoubleClick = (event: ReactMouseEvent<HTMLElement>) => {
    if (editMode || chapterReview.stage === "human_confirmed") return;
    const target = event.target as HTMLElement;
    const copy = target.closest<HTMLElement>("[data-story-copy]");
    const block = copy?.closest<HTMLElement>("[data-story-block]");
    const blockId = block?.dataset.storyBlock || "";
    if (!copy || !block || !blockId || !articleRef.current?.contains(block)) return;
    let start = 0;
    let end = 0;
    const selection = window.getSelection();
    if (selection?.rangeCount) {
      const range = selection.getRangeAt(0);
      if (copy.contains(range.startContainer) && copy.contains(range.endContainer)) {
        const beforeStart = range.cloneRange();
        beforeStart.selectNodeContents(copy);
        beforeStart.setEnd(range.startContainer, range.startOffset);
        const beforeEnd = range.cloneRange();
        beforeEnd.selectNodeContents(copy);
        beforeEnd.setEnd(range.endContainer, range.endOffset);
        start = beforeStart.toString().length;
        end = beforeEnd.toString().length;
      }
    }
    enterStoryEditMode(blockId, Math.min(start, end), Math.max(start, end));
  };

  const commitDirectMutation = (
    blockId: string,
    nextText: string,
    start: number,
    end: number,
    insertedText: string,
    selectionAfter: number,
  ) => {
    const source = sourceBlocks[language]?.[blockId];
    const baseText = reviewedBlocks[language]?.[blockId];
    if (typeof source !== "string" || typeof baseText !== "string") return;
    const result = recordStoryEdit(chapterReview, {
      storyKey: story.key,
      blockId,
      sourceLanguage: language,
      baseText,
      nextText,
      workingRange: { start, end },
      insertedText,
      ...(evidence[0] ? { supportingEvidence: [evidence[0]] } : {}),
    });
    if (result.blockedReason) {
      setApplyError(result.blockedReason === "annotation" ? labels.annotationConflict : labels.directEditConflict);
      restoreEditorSelection(blockId, start, end);
      return;
    }
    setApplyError("");
    setFocusedEditId(result.transactionId || "");
    activatePassage(blockId);
    onChapterReview(result.state);
    restoreEditorSelection(blockId, selectionAfter);
  };

  const captureDirectBeforeInput = (blockId: string, event: ReactFormEvent<HTMLTextAreaElement>) => {
    const editor = event.currentTarget as HTMLTextAreaElement | null;
    if (!editor) {
      pendingDirectInputRef.current = null;
      return;
    }
    const normalized = normalizeDirectBeforeInput({
      nativeEvent: event.nativeEvent,
      selectionStart: editor.selectionStart,
      selectionEnd: editor.selectionEnd,
      valueLength: editor.value.length,
    });
    pendingDirectInputRef.current = { blockId, mutation: normalized.mutation };
  };

  const handleDirectChange = (blockId: string, event: SyntheticEvent<HTMLTextAreaElement>) => {
    const editor = event.currentTarget as HTMLTextAreaElement | null;
    if (!editor) {
      pendingDirectInputRef.current = null;
      return;
    }
    const nextText = editor.value;
    const selectionAfter = editor.selectionStart;
    const native = event.nativeEvent && typeof event.nativeEvent === "object"
      ? event.nativeEvent as unknown as Record<string, unknown>
      : {};
    const isComposing = native.isComposing === true;
    const completedComposition = completedCompositionRef.current;
    if (!isComposing && completedComposition) {
      completedCompositionRef.current = null;
      if (completedComposition.blockId === blockId && completedComposition.nextText === nextText) {
        pendingDirectInputRef.current = null;
        return;
      }
    }
    const current = storyWorkingBlock(sourceBlocks[language][blockId] || "", story.key, blockId, language, chapterReview);
    const activeComposition = activeCompositionRef.current?.blockId === blockId ? activeCompositionRef.current : null;
    if (isComposing || activeComposition) {
      if (!activeComposition) activeCompositionRef.current = { blockId, previousText: current };
      setCompositionDrafts((drafts) => ({ ...drafts, [blockId]: nextText }));
      pendingDirectInputRef.current = null;
      if (isComposing) return;
      const previousText = activeComposition?.previousText || current;
      activeCompositionRef.current = null;
      setCompositionDrafts((drafts) => {
        const next = { ...drafts };
        delete next[blockId];
        return next;
      });
      const mutation = deriveDirectStoryMutation({ previousText, nextText, selectionAfter });
      completedCompositionRef.current = { blockId, nextText };
      if (mutation) commitDirectMutation(blockId, nextText, mutation.start, mutation.end, mutation.insertedText, selectionAfter);
      return;
    }
    const pending = pendingDirectInputRef.current?.blockId === blockId ? pendingDirectInputRef.current : null;
    pendingDirectInputRef.current = null;
    const mutation = deriveDirectStoryMutation({
      previousText: current,
      nextText,
      selectionAfter,
      beforeInputMutation: pending?.mutation,
    });
    if (mutation) commitDirectMutation(blockId, nextText, mutation.start, mutation.end, mutation.insertedText, selectionAfter);
  };

  const handleCompositionStart = (blockId: string, event: ReactCompositionEvent<HTMLTextAreaElement>) => {
    pendingDirectInputRef.current = null;
    completedCompositionRef.current = null;
    const editor = event.currentTarget as HTMLTextAreaElement | null;
    if (!editor) {
      activeCompositionRef.current = null;
      return;
    }
    const nextText = editor.value;
    const previousText = storyWorkingBlock(sourceBlocks[language][blockId] || "", story.key, blockId, language, chapterReview);
    activeCompositionRef.current = { blockId, previousText };
    setCompositionDrafts((drafts) => ({ ...drafts, [blockId]: nextText }));
  };

  const handleCompositionEnd = (blockId: string, event: ReactCompositionEvent<HTMLTextAreaElement>) => {
    const editor = event.currentTarget as HTMLTextAreaElement | null;
    const active = activeCompositionRef.current?.blockId === blockId ? activeCompositionRef.current : null;
    pendingDirectInputRef.current = null;
    activeCompositionRef.current = null;
    setCompositionDrafts((drafts) => {
      const next = { ...drafts };
      delete next[blockId];
      return next;
    });
    if (!active || !editor) return;
    const nextText = editor.value;
    const selectionAfter = editor.selectionStart;
    const mutation = deriveDirectStoryMutation({ previousText: active.previousText, nextText, selectionAfter });
    completedCompositionRef.current = { blockId, nextText };
    if (mutation) commitDirectMutation(blockId, nextText, mutation.start, mutation.end, mutation.insertedText, selectionAfter);
  };

  const handleDirectPaste = (blockId: string, event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    pendingDirectInputRef.current = null;
    if (activeCompositionRef.current) return;
    const editor = event.currentTarget as HTMLTextAreaElement | null;
    if (!editor) return;
    const insertedText = sanitizeStoryPaste(event.clipboardData.getData("text/plain"));
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const nextText = `${editor.value.slice(0, start)}${insertedText}${editor.value.slice(end)}`;
    commitDirectMutation(blockId, nextText, start, end, insertedText, start + insertedText.length);
  };

  const handleDirectKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || activeCompositionRef.current) return;
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "z") {
      event.preventDefault();
      onChapterReview(event.shiftKey ? redoStoryEdit(chapterReview, language) : undoStoryEdit(chapterReview, language));
    } else if (key === "y") {
      event.preventDefault();
      onChapterReview(redoStoryEdit(chapterReview, language));
    }
  };

  const activateStoryBlock = (event: ReactMouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).tagName === "TEXTAREA") return;
    if (String(window.getSelection()).trim().length >= 3) return;
    const block = (event.target as HTMLElement).closest<HTMLElement>("[data-story-block]");
    if (!block || !articleRef.current?.contains(block)) return;
    activatePassage(block.dataset.storyBlock || "");
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
      const directAdditions = chapterReview.editTransactions
        .filter((transaction) => transaction.storyKey === story.key
          && transaction.requiresEvidence
          && (transaction.resolution === "pending" || transaction.resolution === "needs_evidence"))
        .map((transaction) => ({
          annotationId: transaction.id,
          instruction: transaction.afterText,
          supportingEvidence: transaction.supportingEvidence || [],
        }));
      const response = await fetch("/api/evidence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chapterEvidence: evidence, additions: [...additions, ...directAdditions] }),
      });
      if (!response.ok) throw new Error(labels.evidenceBlocked);
      const verification = await response.json() as { evidenceResolved: boolean; supportedAddIds: string[] };
      const result = applyChapterReview(chapterReview, {
        ...applyContext,
        evidenceResolved: verification.evidenceResolved,
        supportedAddIds: verification.supportedAddIds.filter((id) => additions.some((addition) => addition.annotationId === id)),
        supportedEditIds: verification.supportedAddIds.filter((id) => directAdditions.some((addition) => addition.annotationId === id)),
      });
      if (result.blockedReason === "evidence") setApplyError(labels.evidenceBlocked);
      else if (result.blockedReason === "annotations") setApplyError(labels.annotationConflict);
      else if (result.blockedReason === "direct_evidence") {
        setApplyError(labels.directEvidenceBlocked);
        onChapterReview(result.state);
      }
      else onChapterReview(result.state);
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : labels.evidenceBlocked);
    } finally {
      setApplying(false);
    }
  };

  const blockCopy = (blockId: string, source: string) => chapterReview.redactedBlocks.includes(blockId)
    ? ""
    : sourceBlocks[language]?.[blockId] !== undefined
      ? storyWorkingBlock(source, story.key, blockId, language, chapterReview)
      : applyStoryReviewToBlock(source, blockId, language, chapterReview);

  const renderStoryCopy = (blockId: string, source: string) => {
    const directSegments = storyEditSegments(source, story.key, blockId, language, chapterReview);
    if (directSegments.some((segment) => segment.transactionIds.length)) return directSegments.map((segment, index) => segment.transactionIds.length
      ? <span className={`storyEditedRange ${segment.transactionIds.includes(focusedEditId) ? "focused" : ""}`} data-edit-ids={segment.transactionIds.join(" ")} tabIndex={-1} key={`${blockId}-edit-range-${index}`}>{segment.text}</span>
      : segment.text);
    const copy = blockCopy(blockId, source);
    return storyAnnotationSegments(
      copy, blockId, language, chapterReview.revision, chapterReview.annotations,
    ).map((segment, index) => segment.annotationIds.length
      ? <span className={`storyAnnotatedRange ${segment.annotationIds.includes(focusedAnnotationId) ? "focused" : ""}`} data-annotation-ids={segment.annotationIds.join(" ")} tabIndex={-1} key={`${blockId}-range-${index}`}>{segment.text}</span>
      : segment.text);
  };

  const focusAnnotation = (annotation: StoryReviewAnnotation) => {
    setFocusedAnnotationId(annotation.id);
    setFocusedEditId("");
    setContextTarget({ blockId: annotation.blockId, ...(annotation.sourceLanguage === language ? { quote: annotation.selection.text } : {}) });
    requestAnimationFrame(() => {
      const ranges = Array.from(articleRef.current?.querySelectorAll<HTMLElement>("[data-annotation-ids]") || []);
      const exactRange = ranges.find((range) => (range.dataset.annotationIds || "").split(" ").includes(annotation.id));
      const blocks = Array.from(articleRef.current?.querySelectorAll<HTMLElement>("[data-story-block]") || []);
      const block = blocks.find((candidate) => candidate.dataset.storyBlock === annotation.blockId);
      const target = exactRange || block;
      target?.scrollIntoView({ block: "center", behavior: "smooth" });
      target?.focus({ preventScroll: true });
    });
  };

  const focusEdit = (transaction: StoryEditTransaction) => {
    setFocusedEditId(transaction.id);
    setFocusedAnnotationId("");
    activatePassage(transaction.blockId, transaction.sourceLanguage === language ? transaction.afterText || transaction.beforeText : undefined);
    requestAnimationFrame(() => {
      const exactRange = Array.from(articleRef.current?.querySelectorAll<HTMLElement>("[data-edit-ids]") || [])
        .find((range) => (range.dataset.editIds || "").split(" ").includes(transaction.id));
      const block = Array.from(articleRef.current?.querySelectorAll<HTMLElement>("[data-story-block]") || [])
        .find((candidate) => candidate.dataset.storyBlock === transaction.blockId);
      const target = exactRange || block;
      const behavior = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
      target?.scrollIntoView({ block: "center", behavior });
      const editor = transaction.sourceLanguage === language ? editorRefs.current[transaction.blockId] : null;
      if (editor) {
        const segments = storyEditSegments(
          sourceBlocks[language][transaction.blockId] || "",
          story.key,
          transaction.blockId,
          language,
          chapterReview,
        );
        let cursor = 0;
        const segment = segments.find((item) => {
          const match = item.transactionIds.includes(transaction.id);
          if (!match) cursor += item.text.length;
          return match;
        });
        const start = segment ? cursor : Math.min(transaction.afterRange.start, editor.value.length);
        const end = segment ? cursor + segment.text.length : Math.min(transaction.afterRange.end, editor.value.length);
        editor.focus({ preventScroll: true });
        editor.setSelectionRange(start, end);
      } else target?.focus({ preventScroll: true });
    });
  };

  const revertEdit = (transaction: StoryEditTransaction) => {
    const source = sourceBlocks[transaction.sourceLanguage]?.[transaction.blockId];
    if (typeof source !== "string") return;
    const result = revertAppliedStoryEdit(chapterReview, transaction.id, source);
    if (result.blockedReason) {
      setApplyError(labels.directEditConflict);
      return;
    }
    setApplyError("");
    onChapterReview(result.state);
    if (result.transactionId) setFocusedEditId(result.transactionId);
  };

  const transactionQuote = (transaction: StoryEditTransaction) => {
    if (transaction.operation === "insert") return `+ ${transaction.afterText}`;
    if (transaction.operation === "delete") return `− ${transaction.beforeText}`;
    return `${transaction.beforeText} → ${transaction.afterText}`;
  };

  const renderMarginNotes = (blockId: string) => (noteAnnotationsByBlock[blockId] || []).length || (noteEditsByBlock[blockId] || []).length ? <aside className="storyMarginNotes" aria-label={labels.marginNotes} key={`${blockId}-annotations`}>
    {(noteEditsByBlock[blockId] || []).map((transaction) => <div className={`storyMarginNote direct ${transaction.operation} ${transaction.resolution} ${focusedEditId === transaction.id ? "focused" : ""}`} data-edit-note={transaction.id} key={transaction.id}>
      <button className="storyAnnotationFocus" onClick={() => focusEdit(transaction)} aria-label={`${labels.focusEdit}: ${transactionQuote(transaction)}`}>
        <span>{editTransactionLabel(transaction, language)}</span>
        <q>{transactionQuote(transaction)}</q>
        {transaction.revertsTransactionId && <p>{language === "zh" ? "用于还原此前已应用的改动" : "Reverses an earlier applied edit"}</p>}
      </button>
      {chapterReview.stage !== "human_confirmed" && (transaction.resolution === "pending" || transaction.resolution === "needs_evidence") && <button className="storyAnnotationCancel" onClick={() => onChapterReview(discardStoryEdit(chapterReview, transaction.id))}>{labels.discardEdit}</button>}
      {chapterReview.stage !== "human_confirmed" && transaction.resolution === "applied" && <button className="storyAnnotationCancel" onClick={() => revertEdit(transaction)}>{labels.revertEdit}</button>}
    </div>)}
    {(noteAnnotationsByBlock[blockId] || []).map((annotation) => <div className={`storyMarginNote ${annotation.type} ${focusedAnnotationId === annotation.id ? "focused" : ""}`} data-annotation-note={annotation.id} key={annotation.id}>
      <button className="storyAnnotationFocus" onClick={() => focusAnnotation(annotation)} aria-label={`${labels.focusAnnotation}: ${annotation.selection.text}`}>
        <span>{annotationLabel(annotation, language)}</span>
        <q>{annotation.selection.text}</q>
        {annotation.instruction && <p>{annotation.instruction}</p>}
      </button>
      {chapterReview.stage !== "human_confirmed" && ["pending", "needs_evidence"].includes(annotation.resolution) && <button className="storyAnnotationCancel" onClick={() => onChapterReview(cancelStoryAnnotation(chapterReview, annotation.id))}>{labels.cancelAnnotation}</button>}
    </div>)}
  </aside> : <span className="storyMarginEmpty" aria-hidden="true" />;

  const renderParagraph = (blockId: string, source: string, className?: string) => {
    const copy = blockCopy(blockId, source);
    return <div className="storyBlockRow" data-story-row={blockId} key={blockId}>
      {renderMarginNotes(blockId)}
      <div className={`reviewableStoryBlock ${activeAnnotationsByBlock[blockId]?.length || activeEditsByBlock[blockId]?.length ? "annotated" : ""} ${activePassageId === blockId ? "contextActive" : ""}`} data-story-block={blockId} tabIndex={editMode ? -1 : 0} aria-label={labels.reviewPassage} onClick={activateStoryBlock} onKeyDown={editMode ? undefined : activateStoryBlockFromKeyboard}>
        {copy ? editMode ? <textarea
          className={`storyDirectEditor ${className || ""}`}
          data-story-copy
          data-story-editor={blockId}
          ref={(node) => { editorRefs.current[blockId] = node; }}
          value={compositionDrafts[blockId] ?? copy}
          rows={Math.max(2, (compositionDrafts[blockId] ?? copy).split("\n").length)}
          aria-label={`${labels.editingStory}: ${labels.reviewPassage}`}
          onBeforeInput={(event) => captureDirectBeforeInput(blockId, event)}
          onChange={(event) => handleDirectChange(blockId, event)}
          onCompositionStart={(event) => handleCompositionStart(blockId, event)}
          onCompositionEnd={(event) => handleCompositionEnd(blockId, event)}
          onPaste={(event) => handleDirectPaste(blockId, event)}
          onKeyDown={handleDirectKeyDown}
          onFocus={() => activatePassage(blockId)}
        /> : <p className={className} data-story-copy>{renderStoryCopy(blockId, source)}</p> : <p className="removedStoryBlock">{labels.removedFromRelease}</p>}
      </div>
    </div>;
  };

  const renderListItem = (blockId: string, source: string) => {
    const copy = blockCopy(blockId, source);
    return <div className="storyBlockRow storyListRow" data-story-row={blockId} key={blockId}>
      {renderMarginNotes(blockId)}
      <div className={`reviewableStoryBlock ${activeAnnotationsByBlock[blockId]?.length || activeEditsByBlock[blockId]?.length ? "annotated" : ""} ${activePassageId === blockId ? "contextActive" : ""}`} data-story-block={blockId} role="listitem" tabIndex={editMode ? -1 : 0} aria-label={labels.reviewPassage} onClick={activateStoryBlock} onKeyDown={editMode ? undefined : activateStoryBlockFromKeyboard}>
        {copy ? editMode ? <textarea
          className="storyDirectEditor storyListEditor"
          data-story-copy
          data-story-editor={blockId}
          ref={(node) => { editorRefs.current[blockId] = node; }}
          value={compositionDrafts[blockId] ?? copy}
          rows={Math.max(1, (compositionDrafts[blockId] ?? copy).split("\n").length)}
          aria-label={`${labels.editingStory}: ${labels.reviewPassage}`}
          onBeforeInput={(event) => captureDirectBeforeInput(blockId, event)}
          onChange={(event) => handleDirectChange(blockId, event)}
          onCompositionStart={(event) => handleCompositionStart(blockId, event)}
          onCompositionEnd={(event) => handleCompositionEnd(blockId, event)}
          onPaste={(event) => handleDirectPaste(blockId, event)}
          onKeyDown={handleDirectKeyDown}
          onFocus={() => activatePassage(blockId)}
        /> : <span data-story-copy>{renderStoryCopy(blockId, source)}</span> : <span className="removedStoryBlock">{labels.removedFromRelease}</span>}
      </div>
    </div>;
  };

  const visiblePeople = presentation.people.filter((person) => !chapterReview.redactedBlocks.includes(`people:${person.id}`));
  const insightFeedback = insightReviewFeedbackState(insightReview);
  const insightFeedbackText = insightFeedback === "accepted_pending" ? labels.acceptedPending
    : insightFeedback === "rejected_pending" ? labels.rejectedPending
      : insightFeedback === "changed_pending" ? labels.changedPending
        : insightFeedback === "accepted_applied" ? `${labels.acceptedApplied} ${insightReview?.appliedRevision || chapterReview.revision}`
          : insightFeedback === "rejected_applied" ? `${labels.rejectedApplied} ${insightReview?.appliedRevision || chapterReview.revision}`
            : insightFeedback === "changed_applied" ? `${labels.changedApplied} ${insightReview?.appliedRevision || chapterReview.revision}` : "";
  // Do not render Privacy-redacted insight copy. A review decision of Do not
  // preserve remains visible locally with its applied-revision status so the
  // reviewer can verify or change it; release projection still omits it.
  const insightSuppressed = chapterReview.redactedBlocks.includes(`insight:${visibleHighlight.id}`);

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

  const canonicalInsightDisclosure = !insightSuppressed ? <details className={`canonicalInsightDisclosure ${insightReview?.status === "rejected" ? "rejected" : ""}`} data-canonical-insight={visibleHighlight.id} data-inline-insight={visibleHighlight.id}>
    <summary><span>✦ {labels.aiInsight}</span><b>{visibleHighlight.title}</b><small>{labels.aiInterpretation}</small></summary>
    <div className="canonicalInsightBody">
      <div className="inlineInsightHead"><span>{labels.completeInsight}</span>{chapterReview.stage !== "human_confirmed" && <div>
        <button title={labels.editInsight} aria-label={labels.editInsight} onClick={() => setInsightMode(insightMode === "edit" ? "none" : "edit")}>{language === "zh" ? "编辑" : "Edit"}</button>
        <button title={labels.reviseInsight} aria-label={labels.reviseInsight} onClick={() => setInsightMode(insightMode === "revise" ? "none" : "revise")}>{language === "zh" ? "修改" : "Revise"}</button>
      </div>}</div>
      {insightMode === "edit" ? <div className="inlineInsightEdit">
        <label>{language === "zh" ? "标题" : "Title"}<input value={insightDraft.title} onChange={(event) => setInsightDraft({ ...insightDraft, title: event.target.value })} /></label>
        <label>{labels.observation}<textarea rows={3} value={insightDraft.noticed} onChange={(event) => setInsightDraft({ ...insightDraft, noticed: event.target.value })} /></label>
        <label>{labels.lesson}<textarea rows={3} value={insightDraft.lesson} onChange={(event) => setInsightDraft({ ...insightDraft, lesson: event.target.value })} /></label>
        <div className="compactActions"><button className="primary" disabled={!insightDraft.title.trim() || !insightDraft.noticed.trim() || !insightDraft.lesson.trim()} onClick={saveInsightEdit}>{labels.save}</button><button onClick={() => setInsightMode("none")}>{labels.cancel}</button></div>
      </div> : insightMode === "revise" ? <div className="inlineInsightEdit"><label>{labels.changeInsight}<textarea rows={3} value={instruction} onChange={(event) => setInstruction(event.target.value)} /></label><div className="compactActions"><button className="primary" disabled={!instruction.trim()} onClick={applyInsightRevision}>{labels.save}</button><button onClick={() => setInsightMode("none")}>{labels.cancel}</button></div></div> : <>
        <dl><div><dt>{labels.observation}</dt><dd>{visibleHighlight.noticed}</dd></div><div><dt>{labels.lesson}</dt><dd>{visibleHighlight.lesson}</dd></div></dl>
        {insightFeedbackText && <p className={`insightReviewFeedback ${insightReview?.resolution || ""}`} role="status" aria-live="polite" aria-atomic="true"><span aria-hidden="true">✓</span>{insightFeedbackText}</p>}
        {chapterReview.stage !== "human_confirmed" && <div className="inlineInsightReview"><button className={insightFeedback === "accepted_pending" ? "selected" : ""} aria-pressed={insightFeedback === "accepted_pending"} onClick={() => onChapterReview(updateInsightReview(chapterReview, visibleHighlight.id, language, { status: "accepted", text: visibleHighlight.lesson }))}>{insightFeedback === "accepted_pending" ? `✓ ${labels.acceptedPending}` : labels.acceptInsight}</button><button className={insightFeedback === "rejected_pending" ? "selected" : ""} aria-pressed={insightFeedback === "rejected_pending"} onClick={() => onChapterReview(updateInsightReview(chapterReview, visibleHighlight.id, language, { status: "rejected", text: visibleHighlight.lesson }))}>{insightFeedback === "rejected_pending" ? `✓ ${labels.rejectedPending}` : labels.removeInsight}</button></div>}
      </>}
    </div>
  </details> : null;

  return <section className="simpleEpisode chapterEditor" role="region" aria-labelledby="episode-title">
    <div className="simpleEpisodeChrome">
      <div className="chapterCanvas chapterChromeCanvas">
        <button className="episodeBackLink" ref={backRef} onClick={onClose}>← {labels.back}</button>
        <div className="simpleEpisodePosition">{labels.chapter} {position} / {total}</div>
        <div className="simpleEpisodeNav">
          <button onClick={onPrevious} disabled={position === 1} aria-label={labels.previous}>←</button>
          <button onClick={onNext} disabled={position === total} aria-label={labels.next}>→</button>
        </div>
      </div>
    </div>

    <div className="simpleEpisodeScroll" ref={scrollRef}>
      <header className="simpleEpisodeHero">
        <div className="releaseDraftLabel"><b>{reviewStageLabel(chapterReview, language)}</b><span>{labels.releaseNote}</span></div>
        <div className="simpleEpisodeMeta"><span>{blockCopy("phase", presentation.phase) || labels.removedFromRelease}</span><time>{fmt(episode.startTimestamp || milestone.timestamp, language)}</time><span>≈ {episode.readingTimeMinutes} {labels.minRead}</span></div>
        <h2 id="episode-title">{blockCopy("title", presentation.title) || labels.removedFromRelease}</h2>
        <p className="episodeOverview">{blockCopy("overview", presentation.overview) || labels.removedFromRelease}</p>
        <p className="chapterReviewGuide">{labels.chapterGuide}</p>
      </header>

      <div className="simpleEpisodeBody">
        <section className="episodePrimarySection peopleSection" data-episode-section="people" aria-labelledby="people-heading">
          <div className="simpleSectionHead"><div><h3 id="people-heading">{labels.people}</h3><p>{labels.peoplePrompt}</p></div></div>
          {visiblePeople.length ? <div className="peopleList">{visiblePeople.map((person) => <div className="personRow" key={person.id}>
            <b aria-label={person.releaseLabel}>{person.releaseLabel}</b><div><strong>{person.role}</strong><p>{person.description}</p></div>
          </div>)}</div> : <p className="emptySectionCopy">{labels.peopleHidden}</p>}
          {visiblePeople.length > 0 && <p className="identityNote">{labels.localIdentity}</p>}
        </section>

        <section className="episodePrimarySection storySection" data-episode-section="story" aria-labelledby="story-heading">
          <div className="simpleSectionHead storySectionHead"><div><h3 id="story-heading">{labels.story}</h3><p>{editMode ? labels.storyEditHelp : labels.storyReadHelp}</p></div>{!editMode && <button className="storyEditToggle" aria-label={labels.editStory} aria-pressed="false" disabled={chapterReview.stage === "human_confirmed"} onClick={() => enterStoryEditMode()}><span aria-hidden="true">✎</span>{language === "zh" ? "编辑" : "Edit"}</button>}</div>
          {editMode && <div className="storyEditingBar" role="toolbar" aria-label={labels.editMode}>
            <div><b>{labels.editingStory}</b><span>{labels.editInstruction}</span></div>
            <div className="storyEditingActions">
              <button disabled={!canUndoStoryEdit(chapterReview, language)} title={canUndoStoryEdit(chapterReview, language) ? labels.undo : labels.noUndo} aria-label={labels.undo} onClick={() => onChapterReview(undoStoryEdit(chapterReview, language))}>↶ {labels.undo}</button>
              <button disabled={!canRedoStoryEdit(chapterReview, language)} title={canRedoStoryEdit(chapterReview, language) ? labels.redo : labels.noRedo} aria-label={labels.redo} onClick={() => onChapterReview(redoStoryEdit(chapterReview, language))}>↷ {labels.redo}</button>
              <button className="finishEditing" onClick={leaveEditMode}>{labels.finishEditing}</button>
            </div>
          </div>}
          <div className={`storyReviewWorkspace ${editMode ? "editing" : "reading"}`} data-story-mode={editMode ? "edit" : "read"}>
            <article className="chapterArticle storyDocument" aria-label={editMode ? labels.editMode : labels.readMode} ref={articleRef} onDoubleClick={handleStoryDoubleClick}>
              <h4 className="storySubheading">{labels.background}</h4>
              {renderParagraph("scene", presentation.story.scene, "chapterLead")}
              <h4 className="storySubheading">{labels.decisionProcess}</h4>
              {presentation.story.reconstruction.map((paragraph, index) => renderParagraph(`reconstruction-${index}`, paragraph))}
              <div className="storyImportantList" role="list">{presentation.story.importantDetails.map((detail, index) => renderListItem(`detail-${index}`, detail))}</div>
              <h4 className="storySubheading">{labels.result}</h4>
              {renderParagraph("outcome", presentation.story.decisionOutcome)}
              {presentation.story.uncertainty && <><h4 className="storySubheading storyUncertaintyHeading">{labels.openQuestions}</h4>{renderParagraph("uncertainty", presentation.story.uncertainty)}</>}
              {canonicalInsightDisclosure && <div className="storyBlockRow canonicalInsightRow"><span className="storyMarginEmpty" aria-hidden="true" />{canonicalInsightDisclosure}</div>}
            </article>
            <aside className={`passageInsightPanel ${contextCollapsed ? "collapsed" : ""}`} data-context-block={activePassageId || ""} aria-label={labels.contextualInsight}>
              <header><div><span>✦</span><b>{labels.contextualInsight}</b></div><button onClick={() => setContextCollapsed((current) => !current)} aria-label={contextCollapsed ? labels.showContext : labels.hideContext}>{contextCollapsed ? "+" : "−"}</button></header>
              <nav className="passageInsightNav" aria-label={labels.contextualInsight}>
                <button disabled={activePassageIndex <= 0} onClick={() => navigatePassage(-1)} aria-label={labels.previousInsight}>←</button>
                <span>{activePassageIndex >= 0 ? activePassageIndex + 1 : 0} / {orderedPassageIds.length}</span>
                <button disabled={activePassageIndex < 0 || activePassageIndex >= orderedPassageIds.length - 1} onClick={() => navigatePassage(1)} aria-label={labels.nextInsight}>→</button>
              </nav>
              {!contextCollapsed && <div className="passageInsightBody">{activePassageContext ? <>
                {contextTarget?.quote && <blockquote><small>{labels.selectedPassage}</small>{contextTarget.quote}</blockquote>}
                <div className="passageNarrative"><p>{activePassageContext.whatWasHappening}</p><p>{activePassageContext.whyItMattered}</p>{activePassageContext.whatWeLearned && <p>{activePassageContext.whatWeLearned}</p>}</div>
                {activePassageContext.reusableLesson && <section className="passageLesson"><h5>{labels.lesson}</h5><p>{activePassageContext.reusableLesson}</p></section>}
              </> : <p className="passageInsightPrompt">{labels.contextualPrompt}</p>}</div>}
            </aside>
          </div>
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
          <ul><li><b>{summary.revise}</b> {labels.revisions}</li><li><b>{summary.add}</b> {labels.additions}</li><li><b>{summary.delete}</b> {labels.removals}</li><li><b>{summary.pendingInsights}</b> {labels.insightDecisions}</li><li><b>{privacyState.reviewed} / {candidates.length}</b> {labels.privacyDecisions}</li></ul>
          <p>{labels.applyingNote}</p>
          {!privacyState.complete && <p className="completionBlocker">{labels.privacyBlocks}</p>}
          {applyError && <p className="completionBlocker" role="alert">{applyError}</p>}
          {chapterReview.staleTranslations.length > 0 && <p className="completionNotice">{labels.translationBlocked}</p>}
          {chapterReview.stage === "reviewing" ? <button className="completionPrimary" disabled={!privacyState.complete || applying} onClick={handleApplyReview}>{labels.apply}</button> : chapterReview.stage === "revision_ready" ? <>
            {summary.needsEvidenceAdd > 0 && <p className="completionBlocker">{labels.addBlocked}</p>}
            <div className="completionActions"><span>{summary.needsEvidenceAdd > 0 ? labels.addBlocked : summary.pendingInsights > 0 ? labels.insightBlocked : summary.pendingAnnotations > 0 ? labels.pendingBlocked : labels.noPending}</span><button className="completionPrimary" disabled={!canMarkChapterReady(chapterReview, applyContext)} onClick={() => { leaveEditMode(); onChapterReview(markChapterReady(chapterReview, applyContext)); }}>{labels.markReady}</button></div>
          </> : <div className="readyConfirmation"><b>{labels.ready}</b><p>{labels.readyNote}</p><button onClick={() => onChapterReview(returnChapterToReview(chapterReview))}>{labels.reopen}</button></div>}
        </section>
      </div>
    </div>

  </section>;
}
