"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type CompositionEvent as ReactCompositionEvent,
  type FormEvent as ReactFormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type SyntheticEvent,
} from "react";
import {
  type StoryInsight,
  type StoryLanguage,
  type StorySource,
} from "../lib/timeline";
import { type StoryReviewFocusTarget } from "../lib/story-navigation";
import type { StoryPrivacyCandidate, StoryPrivacyState } from "./story-privacy-ui";
import {
  applyChapterReview,
  applyStoryReviewToBlock,
  canMarkChapterReady,
  canRedoStoryEdit,
  canUndoStoryEdit,
  deriveDirectStoryMutation,
  editAiInsight,
  humanQuoteText,
  markChapterReady,
  normalizeDirectBeforeInput,
  recordStoryEdit,
  redoStoryEdit,
  returnChapterToReview,
  saveHumanInsight,
  sanitizeStoryPaste,
  storyBlocks,
  chapterReviewCompletionBlockers,
  storyWorkingBlock,
  undoStoryEdit,
  updateAiInsightDecision,
  type ChapterReviewContext,
  type ChapterReviewState,
  type DirectStoryMutation,
  type HumanInsightContent,
  type StoryInsightContent,
  type StoryTextSelection,
} from "../lib/story-review";

export type { ChapterReviewState } from "../lib/story-review";

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

type InsightDraft = {
  title: string;
  background: string;
  directlyAcquiredExperience: string;
  principle: string;
};

type StorySelection = {
  blockId: string;
  selection: StoryTextSelection;
};

const storyBlockerCopy = {
  review_state_invalid: "Review state needs attention.",
  privacy_incomplete: "Privacy review is incomplete.",
  evidence_unverified: "Evidence review is incomplete.",
  annotation_pending: "A Story review change still needs Apply review.",
  annotation_needs_evidence: "A Story review change needs reviewed Evidence.",
  direct_edit_pending: "A Story edit still needs Apply review.",
  direct_edit_needs_evidence: "A Story edit needs reviewed Evidence.",
  insight_pending: "An Insight change still needs Apply review.",
  privacy_decisions_stale: "Privacy decisions need review.",
  revision_provenance_mismatch: "This Chapter review needs to be refreshed.",
  redaction_targets_mismatch: "Privacy redactions need review.",
  ai_insight_decision_missing: "An AI Insight decision is missing.",
  ai_insight_decision_pending: "An AI Insight decision still needs Apply review.",
  ai_insight_reaccept_required: "An edited AI Insight requires a new Accept.",
  human_insight_pending: "A human-created Insight still needs Save.",
} as const;

function storyReviewContext(
  source: StorySource,
  chapterReview?: ChapterReviewState,
): ChapterReviewContext {
  const blocks = storyBlocks(source);
  const reviewedBlocks = chapterReview ? {
    en: Object.fromEntries(source.story.blocks.map((block) => [
      block.id,
      applyStoryReviewToBlock(block.text, block.id, "en", chapterReview),
    ])),
    zh: {},
  } : blocks;
  return {
    source,
    privacyCandidates: [],
    privacyDecisions: {},
    targetCatalog: new Map(),
    evidenceResolved: true,
    supportedAddIds: [],
    supportedEditIds: [],
    sourceBlocks: blocks,
    reviewedBlocks,
  };
}

function insightDraft(content: StoryInsightContent): InsightDraft {
  return {
    title: content.title || "",
    background: content.background,
    directlyAcquiredExperience: content.directlyAcquiredExperience,
    principle: content.principle,
  };
}

function humanInsightDraft(content: HumanInsightContent): InsightDraft {
  return {
    title: content.title || "",
    background: content.background,
    directlyAcquiredExperience: content.directlyAcquiredExperience,
    principle: content.principle,
  };
}

function groundedEvidence(source: StorySource, blockIds: string[]) {
  const evidence = source.story.blocks
    .filter((block) => blockIds.includes(block.id))
    .flatMap((block) => block.evidence)
    .map(({ documentId, eventId }) => ({ documentId, eventId }));
  return [...new Map(evidence.map((item) => [JSON.stringify([item.documentId, item.eventId]), item])).values()];
}

function contentFromDraft(draft: InsightDraft, evidence: StoryInsightContent["evidence"]) {
  return {
    ...(draft.title.trim() ? { title: draft.title.trim() } : {}),
    background: draft.background.trim(),
    directlyAcquiredExperience: draft.directlyAcquiredExperience.trim(),
    principle: draft.principle.trim(),
    evidence,
  };
}

function validInsightDraft(draft: InsightDraft) {
  return Boolean(draft.background.trim()
    && draft.directlyAcquiredExperience.trim()
    && draft.principle.trim());
}

function nodeElement(node: Node | null) {
  return node instanceof Element ? node : node?.parentElement || null;
}

function readStorySelection(root: HTMLElement, selection: Selection | null): StorySelection | null {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  const startCopy = nodeElement(range.startContainer)?.closest<HTMLElement>("[data-story-copy]");
  const endCopy = nodeElement(range.endContainer)?.closest<HTMLElement>("[data-story-copy]");
  if (!startCopy || startCopy !== endCopy || !root.contains(startCopy) || !root.contains(endCopy)) return null;
  const block = startCopy.closest<HTMLElement>("[data-story-block]");
  const blockId = block?.dataset.storyBlock || "";
  if (!blockId) return null;
  const beforeStart = range.cloneRange();
  beforeStart.selectNodeContents(startCopy);
  beforeStart.setEnd(range.startContainer, range.startOffset);
  const beforeEnd = range.cloneRange();
  beforeEnd.selectNodeContents(startCopy);
  beforeEnd.setEnd(range.endContainer, range.endOffset);
  const start = beforeStart.toString().length;
  const end = beforeEnd.toString().length;
  const text = (startCopy.textContent || "").slice(start, end);
  return text.trim() && text === range.toString()
    ? { blockId, selection: { start, end, text } }
    : null;
}

function InsightEditor({
  draft,
  onChange,
  onSave,
  onCancel,
  fixedQuote,
}: {
  draft: InsightDraft;
  onChange: (draft: InsightDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  fixedQuote: string;
}) {
  return <div className="inlineInsightEdit storyInsightEditor">
    <label>Title <small>Optional presentation metadata</small><input value={draft.title} onChange={(event) => onChange({ ...draft, title: event.target.value })} /></label>
    <label>Background<textarea rows={3} value={draft.background} onChange={(event) => onChange({ ...draft, background: event.target.value })} /></label>
    <div className="storySelectedQuote"><b>Quote · read-only</b><blockquote>{fixedQuote}</blockquote></div>
    <label>Directly Acquired Experience<textarea rows={3} value={draft.directlyAcquiredExperience} onChange={(event) => onChange({ ...draft, directlyAcquiredExperience: event.target.value })} /></label>
    <label>Principle<textarea rows={3} value={draft.principle} onChange={(event) => onChange({ ...draft, principle: event.target.value })} /></label>
    <div className="compactActions"><button className="primary" disabled={!validInsightDraft(draft)} onClick={onSave}>Save</button><button onClick={onCancel}>Cancel</button></div>
  </div>;
}

function AiInsightCard({
  source,
  insight,
  chapterReview,
  onChapterReview,
  insightRef,
  language,
}: {
  source: StorySource;
  insight: StoryInsight;
  chapterReview: ChapterReviewState;
  onChapterReview: (review: ChapterReviewState) => void;
  insightRef: (node: HTMLElement | null) => void;
  language: StoryLanguage;
}) {
  const review = chapterReview.sourceInsightReviews[insight.id];
  const sourceContent: StoryInsightContent = {
    ...(insight.title === undefined ? {} : { title: insight.title }),
    background: insight.background,
    anchorStoryBlockId: insight.anchorStoryBlockId,
    quote: insight.quote,
    directlyAcquiredExperience: insight.directlyAcquiredExperience,
    principle: insight.principle,
    evidence: insight.evidence.map((reference) => ({ ...reference })),
  };
  const visible = review?.editedContent || sourceContent;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => insightDraft(visible));
  const reopen = () => chapterReview.stage === "human_confirmed"
    ? returnChapterToReview(chapterReview) as ChapterReviewState
    : chapterReview;
  const beginEdit = () => {
    if (chapterReview.stage === "human_confirmed") onChapterReview(reopen());
    setDraft(insightDraft(visible));
    setEditing(true);
  };
  const decide = (decision: "accepted" | "rejected") => {
    onChapterReview(updateAiInsightDecision(reopen(), source, insight.id, decision));
  };
  const save = () => {
    const next = editAiInsight(reopen(), source, insight.id, {
      ...contentFromDraft(draft, sourceContent.evidence),
      anchorStoryBlockId: sourceContent.anchorStoryBlockId,
      quote: sourceContent.quote,
    });
    onChapterReview(next);
    setEditing(false);
  };
  const status = !review || review.decision === "pending"
    ? review?.version && review.version > 1 ? `Edited version ${review.version} · Accept required` : "Pending"
    : review.resolution === "pending"
      ? `${review.decision === "accepted" ? "Accept" : "Do not preserve"} pending Apply review`
      : `${review.decision === "accepted" ? "Accepted" : "Do not preserve"} · revision ${review.appliedRevision}`;
  return <article className={`storyInsightCard ${review?.decision === "rejected" ? "rejected" : ""}`} data-story-insight={insight.id} data-insight-origin="source_ai" ref={insightRef} tabIndex={-1}>
    <header><div><span>✦ {language === "zh" ? "AI 洞察" : "AI Insight"}</span><b>{visible.title || "Untitled Insight"}</b><small>AI-generated · separate from historical fact</small></div><span className="storyInsightStatus" role="status" aria-live="polite">{status}</span></header>
    {editing ? <InsightEditor draft={draft} onChange={setDraft} onSave={save} onCancel={() => setEditing(false)} fixedQuote={sourceContent.quote.text} /> : <>
      <dl>
        <div><dt>Background</dt><dd>{visible.background}</dd></div>
        <div><dt>Quote</dt><dd><blockquote>{sourceContent.quote.text}</blockquote></dd></div>
        <div><dt>Directly Acquired Experience</dt><dd>{visible.directlyAcquiredExperience}</dd></div>
        <div><dt>Principle</dt><dd>{visible.principle}</dd></div>
      </dl>
      <div className="inlineInsightReview storyInsightActions">
        <button className={review?.decision === "accepted" && review.resolution === "pending" ? "selected" : ""} aria-pressed={review?.decision === "accepted" && review.resolution === "pending"} onClick={() => decide("accepted")}>✓ Accept</button>
        <button onClick={beginEdit}>Edit</button>
        <button className={review?.decision === "rejected" && review.resolution === "pending" ? "selected" : ""} aria-pressed={review?.decision === "rejected" && review.resolution === "pending"} onClick={() => decide("rejected")}>× Do not preserve</button>
      </div>
    </>}
  </article>;
}

function HumanInsightCard({
  source,
  insightId,
  chapterReview,
  onChapterReview,
  insightRef,
}: {
  source: StorySource;
  insightId: string;
  chapterReview: ChapterReviewState;
  onChapterReview: (review: ChapterReviewState) => void;
  insightRef: (node: HTMLElement | null) => void;
}) {
  const review = chapterReview.humanInsights[insightId];
  const exactQuote = humanQuoteText(chapterReview, source, review.content);
  const status = review.decision === "human_approved" && review.resolution === "applied"
    ? `Human-approved · revision ${review.appliedRevision}`
    : exactQuote ? "Save required" : "Quote selection needs review";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => humanInsightDraft(review.content));
  const [saveError, setSaveError] = useState("");
  const context = useMemo(() => storyReviewContext(source), [source]);
  const beginEdit = () => {
    if (chapterReview.stage === "human_confirmed") {
      onChapterReview(returnChapterToReview(chapterReview) as ChapterReviewState);
    }
    setDraft(humanInsightDraft(review.content));
    setEditing(true);
    setSaveError("");
  };
  const save = () => {
    const base = chapterReview.stage === "human_confirmed"
      ? returnChapterToReview(chapterReview) as ChapterReviewState
      : chapterReview;
    const result = saveHumanInsight(base, context, insightId, {
      ...contentFromDraft(draft, groundedEvidence(source, [review.content.quote.storyBlockId])),
      quote: review.content.quote,
    });
    if (result.blockedReason) {
      setSaveError("This human Insight could not be saved against the current Story grounding.");
      return;
    }
    onChapterReview(result.state);
    setEditing(false);
  };
  return <article className="storyInsightCard humanCreated" data-story-insight={insightId} data-insight-origin="human_created" ref={insightRef} tabIndex={-1}>
    <header><div><span>Human Insight</span><b>{review.content.title || "Untitled Insight"}</b><small>Human-created · approved on Save</small></div><span className="storyInsightStatus">{status}</span></header>
    {editing ? <InsightEditor draft={draft} onChange={setDraft} onSave={save} onCancel={() => setEditing(false)} fixedQuote={exactQuote || "Quote needs a new Story selection."} /> : <>
      <dl>
        <div><dt>Background</dt><dd>{review.content.background}</dd></div>
        <div><dt>Quote</dt><dd><blockquote>{exactQuote || "Quote needs a new Story selection."}</blockquote></dd></div>
        <div><dt>Directly Acquired Experience</dt><dd>{review.content.directlyAcquiredExperience}</dd></div>
        <div><dt>Principle</dt><dd>{review.content.principle}</dd></div>
      </dl>
      <div className="inlineInsightReview storyInsightActions"><button onClick={beginEdit}>Edit human Insight</button></div>
    </>}
    {saveError && <p className="completionBlocker" role="alert">{saveError}</p>}
  </article>;
}

export function StoryChapterEditor({
  source,
  position,
  total,
  chapterReview,
  reviewFocus,
  onReviewFocusHandled,
  onChapterReview,
  onClose,
  onPrevious,
  onNext,
  language,
  storyPrivacyState,
  storyPrivacyCandidates,
  storyPrivacyReady,
  onOpenStoryPrivacy,
}: {
  source: StorySource;
  position: number;
  total: number;
  chapterReview: ChapterReviewState;
  reviewFocus?: StoryReviewFocusTarget;
  onReviewFocusHandled?: () => void;
  onChapterReview: (review: ChapterReviewState) => void;
  onClose: () => void;
  onPrevious: () => void;
  onNext: () => void;
  language: StoryLanguage;
  storyPrivacyState: StoryPrivacyState["status"];
  storyPrivacyCandidates: StoryPrivacyCandidate[];
  storyPrivacyReady: boolean;
  onOpenStoryPrivacy: () => void;
}) {
  const storyRef = useRef<HTMLElement | null>(null);
  const completionRef = useRef<HTMLElement | null>(null);
  const insightRefs = useRef<Record<string, HTMLElement | null>>({});
  const editorRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const pendingDirectInputRef = useRef<PendingDirectInput | null>(null);
  const activeCompositionRef = useRef<ActiveComposition | null>(null);
  const completedCompositionRef = useRef<CompletedComposition | null>(null);
  const [selection, setSelection] = useState<StorySelection | null>(null);
  const [selectionError, setSelectionError] = useState("");
  const [editMode, setEditMode] = useState(false);
  const [compositionDrafts, setCompositionDrafts] = useState<Record<string, string>>({});
  const [humanDraft, setHumanDraft] = useState<{
    id: string;
    quote: HumanInsightContent["quote"];
    draft: InsightDraft;
  } | null>(null);
  const [applyError, setApplyError] = useState("");
  const [applying, setApplying] = useState(false);
  const context = useMemo(() => storyReviewContext(source, chapterReview), [chapterReview, source]);
  const blockers = useMemo(
    () => chapterReviewCompletionBlockers(chapterReview, context),
    [chapterReview, context],
  );
  const readingMinutes = Math.max(1, Math.ceil(source.story.blocks
    .reduce((count, block) => count + block.text.trim().split(/\s+/u).length, 0) / 220));
  const aiInsightsByBlock = useMemo(() => source.insights.reduce<Record<string, StoryInsight[]>>((result, insight) => {
    const ownerBlockId = insight.anchorStoryBlockId;
    if (source.story.blocks.some((block) => block.id === ownerBlockId)) (result[ownerBlockId] ||= []).push(insight);
    return result;
  }, {}), [source]);
  const humanInsightIdsByBlock = useMemo(() => Object.keys(chapterReview.humanInsights).sort().reduce<Record<string, string[]>>((result, insightId) => {
    const ownerBlockId = chapterReview.humanInsights[insightId].content.quote.storyBlockId;
    if (source.story.blocks.some((block) => block.id === ownerBlockId)) (result[ownerBlockId] ||= []).push(insightId);
    return result;
  }, {}), [chapterReview.humanInsights, source.story.blocks]);

  useEffect(() => {
    if (!reviewFocus) return;
    const target = reviewFocus.targetKind === "insight" && reviewFocus.targetId
      ? insightRefs.current[reviewFocus.targetId]
      : null;
    const destination = target || completionRef.current;
    destination?.scrollIntoView({ block: "center", behavior: "smooth" });
    destination?.focus({ preventScroll: true });
    onReviewFocusHandled?.();
  }, [onReviewFocusHandled, reviewFocus]);

  const captureSelection = () => {
    if (editMode) return;
    const root = storyRef.current;
    if (!root) return;
    const current = readStorySelection(root, window.getSelection());
    const sourceBlock = current && source.story.blocks.find((block) => block.id === current.blockId);
    const reviewed = sourceBlock
      ? applyStoryReviewToBlock(sourceBlock.text, sourceBlock.id, "en", chapterReview)
      : null;
    if (!current || typeof reviewed !== "string"
      || reviewed.slice(current.selection.start, current.selection.end) !== current.selection.text) {
      setSelection(null);
      setSelectionError(window.getSelection()?.isCollapsed
        ? ""
        : "Select text within one current Story passage to add an Insight.");
      return;
    }
    setSelection(current);
    setSelectionError("");
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
    if (chapterReview.stage === "human_confirmed" || humanDraft) return;
    setSelection(null);
    setSelectionError("");
    setApplyError("");
    setEditMode(true);
    if (blockId) restoreEditorSelection(blockId, start, end);
  };

  const leaveEditMode = () => {
    pendingDirectInputRef.current = null;
    activeCompositionRef.current = null;
    completedCompositionRef.current = null;
    setCompositionDrafts({});
    setEditMode(false);
  };

  const handleStoryDoubleClick = (event: ReactMouseEvent<HTMLElement>) => {
    if (editMode || chapterReview.stage === "human_confirmed" || humanDraft) return;
    const target = event.target as HTMLElement;
    const copy = target.closest<HTMLElement>("[data-story-copy]");
    const block = copy?.closest<HTMLElement>("[data-story-block]");
    const blockId = block?.dataset.storyBlock || "";
    if (!copy || !block || !blockId || !storyRef.current?.contains(block)) return;
    let start = 0;
    let end = 0;
    const currentSelection = window.getSelection();
    if (currentSelection?.rangeCount) {
      const range = currentSelection.getRangeAt(0);
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
    const sourceBlock = source.story.blocks.find((block) => block.id === blockId);
    if (!sourceBlock) return;
    const baseText = applyStoryReviewToBlock(sourceBlock.text, blockId, "en", chapterReview);
    const result = recordStoryEdit(chapterReview, {
      storyKey: source.key,
      blockId,
      sourceLanguage: "en",
      baseText,
      nextText,
      workingRange: { start, end },
      insertedText,
      ...(sourceBlock.evidence[0] ? { supportingEvidence: [sourceBlock.evidence[0]] } : {}),
    });
    if (result.blockedReason) {
      setApplyError(result.blockedReason === "annotation"
        ? "This Story passage already has a controlled review change. Resolve it before editing directly."
        : "That mutation crosses or overlaps controlled edits. Undo or discard the affected edit, then change one passage at a time.");
      restoreEditorSelection(blockId, start, end);
      return;
    }
    setApplyError("");
    onChapterReview(result.state as ChapterReviewState);
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
    const sourceBlock = source.story.blocks.find((block) => block.id === blockId);
    if (!sourceBlock) return;
    const current = storyWorkingBlock(sourceBlock.text, source.key, blockId, "en", chapterReview);
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
    const sourceBlock = source.story.blocks.find((block) => block.id === blockId);
    if (!editor || !sourceBlock) {
      activeCompositionRef.current = null;
      return;
    }
    activeCompositionRef.current = {
      blockId,
      previousText: storyWorkingBlock(sourceBlock.text, source.key, blockId, "en", chapterReview),
    };
    const nextText = editor.value;
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
      onChapterReview((event.shiftKey
        ? redoStoryEdit(chapterReview, "en")
        : undoStoryEdit(chapterReview, "en")) as ChapterReviewState);
    } else if (key === "y") {
      event.preventDefault();
      onChapterReview(redoStoryEdit(chapterReview, "en") as ChapterReviewState);
    }
  };

  const beginHumanInsight = () => {
    if (!selection) return;
    if (chapterReview.stage === "human_confirmed") {
      onChapterReview(returnChapterToReview(chapterReview) as ChapterReviewState);
    }
    setHumanDraft({
      id: `human:${crypto.randomUUID()}`,
      quote: {
        chapterKey: source.key,
        storyBlockId: selection.blockId,
        selection: selection.selection,
        baseRevision: chapterReview.revision,
      },
      draft: {
        title: "",
        background: "",
        directlyAcquiredExperience: "",
        principle: "",
      },
    });
    setSelection(null);
  };

  const saveHumanInsightDraft = () => {
    if (!humanDraft) return;
    const base = chapterReview.stage === "human_confirmed"
      ? returnChapterToReview(chapterReview) as ChapterReviewState
      : chapterReview;
    const content: HumanInsightContent = {
      ...contentFromDraft(humanDraft.draft, groundedEvidence(source, [humanDraft.quote.storyBlockId])),
      quote: humanDraft.quote,
    };
    const result = saveHumanInsight(base, context, humanDraft.id, content);
    if (result.blockedReason) {
      setApplyError("This human Insight could not be saved against the current Story grounding.");
      return;
    }
    onChapterReview(result.state);
    setHumanDraft(null);
    setApplyError("");
  };

  const applyReview = async () => {
    if (!storyPrivacyReady) {
      setApplyError("Resolve the current Chapter Privacy references in Release Preview before applying this review.");
      return;
    }
    setApplying(true);
    setApplyError("");
    try {
      const directAdditions = chapterReview.editTransactions
        .filter((transaction) => transaction.storyKey === source.key
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
        body: JSON.stringify({
          chapterEvidence: [source.evidence.primary, ...source.evidence.supporting],
          additions: directAdditions,
        }),
      });
      if (!response.ok) throw new Error("The reviewed Evidence could not be verified.");
      const verification = await response.json() as { evidenceResolved: boolean; supportedAddIds: string[] };
      const result = applyChapterReview(chapterReview, {
        ...context,
        evidenceResolved: verification.evidenceResolved,
        supportedEditIds: verification.supportedAddIds.filter((id) => directAdditions.some((addition) => addition.annotationId === id)),
      });
      if (result.blockedReason) {
        if (result.blockedReason === "direct_evidence") onChapterReview(result.state);
        setApplyError("The current review could not be applied safely. Recheck the bounded review items below.");
        return;
      }
      leaveEditMode();
      onChapterReview(result.state);
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : "The current review could not be applied safely.");
    } finally {
      setApplying(false);
    }
  };

  return <section className="simpleEpisode chapterEditor storyChapterEditor" role="region" aria-labelledby="story-chapter-title">
    <div className="simpleEpisodeChrome"><div className="chapterCanvas chapterChromeCanvas">
      <button className="episodeBackLink" onClick={onClose}>← Project story</button>
      <div className="simpleEpisodePosition">Chapter {position} / {total}</div>
      <div className="simpleEpisodeNav"><button onClick={onPrevious} disabled={position === 1} aria-label="Previous chapter">←</button><button onClick={onNext} disabled={position === total} aria-label="Next chapter">→</button></div>
    </div></div>
    <div className="simpleEpisodeScroll">
      <header className="simpleEpisodeHero">
        <div className="releaseDraftLabel"><b>{chapterReview.stage === "human_confirmed" ? "Final Release Memory" : chapterReview.stage === "revision_ready" ? `Latest revision ready · Revision ${chapterReview.revision}` : chapterReview.revision > 1 ? `Review in progress · Revision ${chapterReview.revision}` : "Initial AI draft"}</b><span>Story-first review · human-authoritative</span></div>
        <div className="simpleEpisodeMeta"><span>{source.phase.label}</span><span>≈ {readingMinutes} min read</span></div>
        <h2 id="story-chapter-title">{source.title}</h2>
        <p className="episodeOverview">{source.overview}</p>
        <p className="chapterReviewGuide">{source.insights.length
          ? "Read the Story, resolve each AI Insight independently, and add a human Insight from one selected Story passage when useful."
          : "Review the Story as-is, and add a human Insight from selected Story text only if useful."}</p>
      </header>
      <div className="simpleEpisodeBody">
        <section className="episodePrimarySection peopleSection" aria-labelledby="story-people-heading">
          <div className="simpleSectionHead"><div><h3 id="story-people-heading">People</h3><p>Supported actors in this Chapter</p></div></div>
          <div className="storyPeopleList">{source.people.map((person) => <div className="storyPersonRow" key={person.id}><strong>{person.releaseLabel}</strong><p>{person.description}</p></div>)}</div>
          <p className="identityNote">Local identity · hidden on export</p>
        </section>
        <section className="episodePrimarySection storySection" aria-labelledby="story-content-heading">
          <div className="simpleSectionHead storySectionHead"><div><h3 id="story-content-heading">Story</h3><p>{editMode ? "Type directly in one Story passage. Undo or discard changes before Apply Review." : "Select text within one passage to author a grounded human Insight."}</p></div>{!editMode && <button className="storyEditToggle" aria-label="Edit Story" aria-pressed="false" disabled={chapterReview.stage === "human_confirmed" || Boolean(humanDraft)} onClick={() => enterStoryEditMode()}><span aria-hidden="true">✎</span>Edit Story</button>}</div>
          {editMode && <div className="storyEditingBar" role="toolbar" aria-label="Story Edit Mode">
            <div><b>Editing Story</b><span>Edit one Story passage at a time. Every change remains in the common review ledger until Apply Review.</span></div>
            <div className="storyEditingActions">
              <button disabled={!canUndoStoryEdit(chapterReview, "en")} title={canUndoStoryEdit(chapterReview, "en") ? "Undo" : "Nothing to undo"} aria-label="Undo" onClick={() => onChapterReview(undoStoryEdit(chapterReview, "en") as ChapterReviewState)}>↶ Undo</button>
              <button disabled={!canRedoStoryEdit(chapterReview, "en")} title={canRedoStoryEdit(chapterReview, "en") ? "Redo" : "Nothing to redo"} aria-label="Redo" onClick={() => onChapterReview(redoStoryEdit(chapterReview, "en") as ChapterReviewState)}>↷ Redo</button>
              <button className="finishEditing" onClick={leaveEditMode}>Finish editing</button>
            </div>
          </div>}
          <article className={`chapterArticle storyDocument ${editMode ? "editing" : "reading"}`} aria-label={editMode ? "Story Edit Mode" : "Story read mode"} ref={storyRef} onDoubleClick={handleStoryDoubleClick} onMouseUp={editMode ? undefined : captureSelection} onKeyUp={editMode ? undefined : captureSelection}>
            {source.story.blocks.map((block) => {
              const aiInsights = aiInsightsByBlock[block.id] || [];
              const humanInsightIds = humanInsightIdsByBlock[block.id] || [];
              const copy = storyWorkingBlock(block.text, source.key, block.id, "en", chapterReview);
              return <div className="storyNarrativeRow" data-insight-owner-block={block.id} key={block.id}>
                <div className="storyBlock" data-story-block={block.id} tabIndex={editMode ? -1 : 0}>
                  {editMode ? <textarea
                    className="storyDirectEditor"
                    data-story-copy
                    data-story-editor={block.id}
                    ref={(node) => { editorRefs.current[block.id] = node; }}
                    value={compositionDrafts[block.id] ?? copy}
                    rows={Math.max(2, (compositionDrafts[block.id] ?? copy).split("\n").length)}
                    aria-label={`Editing Story passage ${block.id}`}
                    onBeforeInput={(event) => captureDirectBeforeInput(block.id, event)}
                    onChange={(event) => handleDirectChange(block.id, event)}
                    onCompositionStart={(event) => handleCompositionStart(block.id, event)}
                    onCompositionEnd={(event) => handleCompositionEnd(block.id, event)}
                    onPaste={(event) => handleDirectPaste(block.id, event)}
                    onKeyDown={handleDirectKeyDown}
                  /> : <p data-story-copy>{copy}</p>}
                  {!editMode && selection?.blockId === block.id && <button className="storyAddInsight" onMouseDown={(event) => event.preventDefault()} onClick={beginHumanInsight}>+ Add Insight</button>}
                </div>
                {(aiInsights.length > 0 || humanInsightIds.length > 0) && <aside className="storyAnchoredInsights" aria-label={`Insights for Story passage ${block.id}`}>
                  {aiInsights.map((insight) => <AiInsightCard
                    key={insight.id}
                    source={source}
                    insight={insight}
                    chapterReview={chapterReview}
                    onChapterReview={onChapterReview}
                    insightRef={(node) => { insightRefs.current[insight.id] = node; }}
                    language={language}
                  />)}
                  {humanInsightIds.map((insightId) => <HumanInsightCard
                    key={insightId}
                    source={source}
                    insightId={insightId}
                    chapterReview={chapterReview}
                    onChapterReview={onChapterReview}
                    insightRef={(node) => { insightRefs.current[insightId] = node; }}
                  />)}
                </aside>}
              </div>;
            })}
            {source.story.uncertainty && <section className="storyUncertainty"><h4>Open questions</h4><p>{source.story.uncertainty}</p></section>}
          </article>
          {selectionError && <p className="completionBlocker" role="alert">{selectionError}</p>}
          {humanDraft && <section className="storyHumanComposer" aria-labelledby="human-insight-heading">
            <header><span>Human Insight</span><h4 id="human-insight-heading">Add Insight from selected Story text</h4></header>
            <InsightEditor draft={humanDraft.draft} onChange={(draft) => setHumanDraft({ ...humanDraft, draft })} onSave={saveHumanInsightDraft} onCancel={() => setHumanDraft(null)} fixedQuote={humanDraft.quote.selection.text} />
          </section>}
        </section>
        <section className="episodePrimarySection privacySection" aria-labelledby="story-privacy-heading">
          <div className="simpleSectionHead"><div><h3 id="story-privacy-heading">Privacy</h3><p>Read-only references to the one global Story Privacy authority.</p></div></div>
          <div className="privacySummary chapterPrivacySummary">
            {storyPrivacyState !== "ready" ? <p role="status">Current Story Privacy authority is {storyPrivacyState}. Apply review and All set remain blocked.</p>
              : storyPrivacyCandidates.length === 0 ? <p><b>0 / 0 for this Chapter.</b> No release Privacy candidate targets this Chapter.</p>
                : <ul>{storyPrivacyCandidates.map((candidate) => <li key={candidate.id}>
                  <b>{candidate.title}</b>
                  <span>{candidate.reviewState === "deterministic" ? "Automatically redacted"
                    : candidate.decision === "keep" ? "Kept by contributor"
                      : candidate.decision === "redact" ? "Redacted by contributor" : "Needs confirmation"}</span>
                </li>)}</ul>}
            <p>Raw Evidence and unavailable originals are never reconstructed here. Cross-Chapter findings keep one global identity and decision.</p>
            <button onClick={onOpenStoryPrivacy}>Open global Release Preview</button>
          </div>
        </section>
        <section className="chapterCompletion" data-chapter-completion ref={completionRef} tabIndex={-1} aria-labelledby="story-review-summary-heading">
          <div><span>{chapterReview.stage.replaceAll("_", " ")} · Revision {chapterReview.revision}</span><h3 id="story-review-summary-heading">Review summary</h3></div>
          <ul><li><b>{source.insights.length}</b> source AI Insights</li><li><b>{Object.keys(chapterReview.humanInsights).length}</b> human-created Insights</li><li><b>{blockers.length + (storyPrivacyReady ? 0 : 1)}</b> bounded review blockers</li></ul>
          {blockers.length > 0 && <ul className="storyBlockerList">{blockers.map((blocker, index) => <li key={`${blocker.code}:${blocker.targetKind}:${blocker.targetId || ""}:${index}`}>{storyBlockerCopy[blocker.code]}</li>)}</ul>}
          {!storyPrivacyReady && <p className="completionBlocker" role="status">Current Chapter Privacy is not complete.</p>}
          {applyError && <p className="completionBlocker" role="alert">{applyError}</p>}
          {chapterReview.stage === "reviewing" ? <button className="completionPrimary" disabled={applying || !storyPrivacyReady} onClick={applyReview}>{applying ? "Applying review…" : "Apply current review"}</button>
            : chapterReview.stage === "revision_ready" ? <div className="completionActions"><span>{blockers.length || !storyPrivacyReady ? "Resolve the bounded review items before All set." : "Inspect the latest revision, then choose All set."}</span><button className="completionPrimary" disabled={!storyPrivacyReady || !canMarkChapterReady(chapterReview, context)} onClick={() => { leaveEditMode(); onChapterReview(markChapterReady(chapterReview, context)); }}>All set</button></div>
              : <div className="readyConfirmation"><b>Final Release Memory</b><p>Human-confirmed locally. This is not publication approval.</p><button onClick={() => onChapterReview(returnChapterToReview(chapterReview) as ChapterReviewState)}>Reopen review</button></div>}
        </section>
      </div>
    </div>
  </section>;
}
