"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { WorkflowProgress } from "./organization-progress";
import { RedactionCompare, segments, type Redaction, type RedactionJob } from "./redaction-compare";
import {
  StoryPrivacyReview,
} from "./story-privacy-review";
import {
  chapterStoryPrivacyCandidates,
  parseStoryPrivacyAuthority,
  storyPrivacyAuthorityCurrent,
  storyPrivacyAuthorityComplete,
  storyPrivacyCandidateResolved,
  StoryPrivacyRequestGate,
  type StoryPrivacyState,
  type StoryPrivacyTarget,
  type StoryPrivacyTargetChoice,
} from "./story-privacy-ui";
import { ProbePanel, type Probe, type BulkDecision, type ProbeRun } from "./probe-panel";
import {
  PROJECT_RELEASE_AGENT_RESUME_INSTRUCTION,
  ProjectReleaseDownloadRequestGate,
  ProjectReleaseConfirmationRequestGate,
  projectReleaseActionBlocked,
  projectReleaseActionBlockers,
  projectReleaseConfirmationPreferencesComplete,
  type ProjectReleaseAction,
  type ProjectReleaseActionBlockers,
  type ProjectReleaseAuthorityBlocker,
} from "./project-release-confirmation-ui";
import {
  StoryChapterEditor,
  type ChapterReviewState,
} from "./story-chapter-editor";
import {
  chapterReviewCompletionBlockers,
  emptyChapterReview,
  storyBlocks,
  type PrivacyDecision,
} from "../lib/story-review";
import { STORY_PREFIX, compareStorySourceIdentity, storyKindLabel, timelinePresentation, type StoryLanguage, type StorySource } from "../lib/timeline";
import {
  isReservedStoryOrganizationReason,
  selectViewerChapters,
  type ViewerChapter as StoryViewerChapter,
} from "../lib/story-readiness";
import { validActivatedSourceRevision } from "../lib/authority-validation.mjs";
import {
  phaseGroupIdentity,
  groupDownloadReviewBlockers,
  readStoryNavigation,
  resolveStoryNavigation,
  storyNavigationProjects,
  writeStoryNavigation,
  type DownloadReviewBlocker,
  type DownloadReviewBlockerGroup,
  type StoryNavigation,
  type StoryReviewFocusTarget,
} from "../lib/story-navigation";
import {
  canonicalizeStoryReviewSession,
  createStoryReviewSession,
  hydrateStoryReviewSession,
  parseStoryReviewSession,
  STORY_REVIEW_SESSION_SCHEMA,
} from "../lib/story-review-session";
import {
  StoryReviewSessionPersistenceError,
  StoryReviewSessionPersistenceQueue,
  runDurableStoryReviewHandoff,
  type StoryReviewSessionSaveAcknowledgement,
  type StoryReviewSessionPersistenceStatus,
} from "../lib/story-review-session-persistence";
import {
  isStoryReviewReady,
  isStoryWorkspaceReady,
  isWorkflowRunId,
  startWorkflowPolling,
  withHumanReviewProgress,
  type WorkflowProgressState,
} from "../lib/workflow-progress";
import { startOrganizationPolling } from "../lib/organization-polling-lifecycle";
import {
  parseWorkspaceStatus,
  type WorkspaceDocument,
  type WorkspaceStatus,
  type WorkspaceSummary,
} from "../lib/workspace-types";

type Status = WorkspaceStatus;
type Doc = WorkspaceDocument;
type Summary = WorkspaceSummary;
type Item = { id:string; sequence:number; event_type?:string; actor_id?:string; actor_type?:string; timestamp?:string; content:string; organization_category?:string; organization_confidence?:number; organization_reason?:string };
type Detail = { document:Doc; items:Item[] };
type TimelineChapter = {
  key: string;
  project: string;
  phase: string;
  kind?: NonNullable<StorySource["kind"]>;
  title: string;
  overview: string;
  timestamp?: string;
  dateLabel?: string;
  evidenceCount: number;
  readingMinutes: number;
  before?: string;
  after?: string;
  chips?: string[];
  timelineMarker?: "ai_insight";
  chapter: StoryViewerChapter;
};

function completionContext(source: StorySource) {
  const blocks = storyBlocks(source);
  return {
    source,
    privacyCandidates: [],
    privacyDecisions: {},
    targetCatalog: new Map(),
    evidenceResolved: true,
    supportedAddIds: [],
    supportedEditIds: [],
    sourceBlocks: blocks,
    reviewedBlocks: blocks,
  };
}
function organizationRequestError(message: string, details: { status?: number; retryable?: boolean } = {}) {
  return Object.assign(new Error(message), details);
}

async function fetchOrganizationStatus(init?: RequestInit): Promise<Status> {
  const response = await fetch("/api/organization", { cache:"no-store", ...init });
  if (!response.ok) {
    throw organizationRequestError("Organization could not be prepared", { status: response.status });
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw organizationRequestError("Organization returned an invalid status", { retryable: false });
  }
  const payload = parseWorkspaceStatus(body);
  if (!payload) {
    throw organizationRequestError("Organization returned an invalid status", { retryable: false });
  }
  return payload;
}

const workspaceUi = {
  en: {
    title:"Storytelling Review", local:"Local only · nothing uploaded", projects:"Project Story", total:"total",
    sources:"Source records", projectStory:"Project story", evidenceReview:"Evidence review", preferencesTitle:"Contributor preferences",
    chapters:"Chapters", phases:"narrative phases", insightReviewed:"AI Insights resolved", retained:"source records retained",
    timeline:"Project Story", release:"Release preview", preferences:"Preferences", mainProject:"MAIN PROJECT", events:"events",
    introTitle:"Chapters are the Story table of contents.", intro:"Open a chapter for People, Story, and Privacy. AI insights stay inside the narrative; local evidence stays secondary.",
    before:"BEFORE", after:"AFTER", timelineAiInsight:"AI Insight", evidence:"reviewed evidence event", read:"Read chapter", workflow:"Workflow",
    nextStep:"Read a Chapter to review the full story, evidence, direct learning, and reusable rules.",
    confirmRelease:"Confirm ready for release", confirmingRelease:"Confirming release readiness…", releaseConfirmed:"Ready for release confirmed",
    downloadReviewKicker:"Review required", downloadReviewTitle:"Release action blocked", downloadReviewIntro:"Use these content-free diagnostics to return to the existing review authority.", downloadReviewCount:"unresolved review items", openReview:"Open review", close:"Close", chapter:"Chapter", agentRecovery:"Agent recovery instruction",
    downloadBlockers:{
      review_state_invalid:"Review state needs attention", privacy_incomplete:"Privacy review is incomplete", evidence_unverified:"Evidence review is incomplete",
      annotation_pending:"A Story review change still needs Apply Review", annotation_needs_evidence:"A Story review change needs Evidence",
      direct_edit_pending:"A Story edit still needs Apply Review", direct_edit_needs_evidence:"A Story edit needs Evidence",
      insight_pending:"An Insight change still needs Apply Review", privacy_decisions_stale:"Privacy decisions need to be reviewed again",
      revision_provenance_mismatch:"This Chapter review needs to be refreshed", redaction_targets_mismatch:"Privacy redactions need review",
      ai_insight_decision_missing:"An AI Insight decision is missing", ai_insight_decision_pending:"An AI Insight decision still needs Apply Review",
      ai_insight_reaccept_required:"An edited AI Insight requires a new Accept", human_insight_pending:"A human-created Insight still needs Save",
      chapter_not_confirmed:"Chapter is not marked All set",
    },
    releaseAuthorityBlockers:{
      story_privacy_unresolved:"Story Privacy has unresolved target selections",
      story_privacy_preparation_required:"Story Privacy preparation must be refreshed",
      story_privacy_unavailable:"Current Story Privacy authority is unavailable",
      preference_unanswered:"Current Preference questions are unanswered",
      preference_stale:"Preference authority is stale",
      preference_missing:"Preference authority is missing",
      review_authority_mismatch:"Story review persistence does not match current authority",
      release_confirmation_missing:"Durable release confirmation is missing",
    },
  },
  zh: {
    title:"故事审阅", local:"仅限本地 · 未上传", projects:"项目故事", total:"个项目",
    sources:"来源记录", projectStory:"项目故事", evidenceReview:"证据审阅", preferencesTitle:"贡献者偏好",
    chapters:"个章节", phases:"个叙事阶段", insightReviewed:"项 AI 洞察已解决", retained:"条来源记录保留",
    timeline:"项目故事", release:"发布预览", preferences:"偏好", mainProject:"主要项目", events:"条事件",
    introTitle:"章节构成故事目录。", intro:"打开一章，按人物、故事和隐私阅读；AI 洞察留在叙事中，本地证据保持为次要入口。",
    before:"之前", after:"之后", timelineAiInsight:"AI 洞察", evidence:"条已审阅证据", read:"阅读章节", workflow:"工作流",
    nextStep:"阅读任一章节，完整审阅故事、证据、直接经验与可复用规则。",
    confirmRelease:"确认已准备发布", confirmingRelease:"正在确认发布准备状态…", releaseConfirmed:"已确认准备发布",
    downloadReviewKicker:"需要审阅", downloadReviewTitle:"发布操作已阻止", downloadReviewIntro:"请使用以下不含内容的诊断返回现有审阅授权。", downloadReviewCount:"项待解决审阅", openReview:"打开审阅", close:"关闭", chapter:"章节", agentRecovery:"Agent 恢复指令",
    downloadBlockers:{
      review_state_invalid:"审阅状态需要处理", privacy_incomplete:"隐私审阅尚未完成", evidence_unverified:"证据审阅尚未完成",
      annotation_pending:"故事审阅改动仍需应用审阅", annotation_needs_evidence:"故事审阅改动需要证据",
      direct_edit_pending:"故事编辑仍需应用审阅", direct_edit_needs_evidence:"故事编辑需要证据",
      insight_pending:"洞察改动仍需应用审阅", privacy_decisions_stale:"需要重新审阅隐私决定",
      revision_provenance_mismatch:"本章审阅需要刷新", redaction_targets_mismatch:"隐私移除项需要审阅",
      ai_insight_decision_missing:"缺少一项 AI 洞察决定", ai_insight_decision_pending:"一项 AI 洞察决定仍需应用审阅",
      ai_insight_reaccept_required:"编辑后的 AI 洞察需要重新接受", human_insight_pending:"人工创建的洞察仍需保存",
      chapter_not_confirmed:"本章尚未确认完成",
    },
    releaseAuthorityBlockers:{
      story_privacy_unresolved:"Story Privacy 仍有未选择的目标",
      story_privacy_preparation_required:"需要刷新 Story Privacy 准备",
      story_privacy_unavailable:"当前 Story Privacy 授权不可用",
      preference_unanswered:"当前偏好问题尚未回答",
      preference_stale:"偏好授权已过期",
      preference_missing:"缺少偏好授权",
      review_authority_mismatch:"故事审阅持久化与当前授权不匹配",
      release_confirmation_missing:"缺少持久发布确认",
    },
  },
} as const;

const fmt = (value: string | undefined, language: StoryLanguage = "en") => value
  ? new Date(value).toLocaleString(language === "zh" ? "zh-CN" : "en-US", { dateStyle:"medium", timeStyle:"short" })
  : language === "zh" ? "时间不可用" : "Time unavailable";

const fmtTimelineDate = (value: string, language: StoryLanguage = "en") => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? undefined
    : date.toLocaleDateString(language === "zh" ? "zh-CN" : "en-US", { dateStyle:"medium" });
};

function updateStoryNavigationUrl(navigation: StoryNavigation, historyMode: "push"|"replace") {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const search = writeStoryNavigation(url.search, navigation);
  if (url.search === search) return;
  url.search = search;
  if (historyMode === "replace") window.history.replaceState(window.history.state, "", url);
  else window.history.pushState(window.history.state, "", url);
}

export function InlineWorkspace({
  initialWorkflow,
  initialStatus,
  initialDocuments,
  initialChapterReviews,
  initialPrivacyDecisions,
  initialStorySessionReadyRunId,
}: {
  initialWorkflow: WorkflowProgressState;
  initialStatus: WorkspaceStatus | null;
  initialDocuments: WorkspaceDocument[];
  initialChapterReviews: Record<string,ChapterReviewState>;
  initialPrivacyDecisions: Record<string,PrivacyDecision>;
  initialStorySessionReadyRunId: string;
}) {
  const [status,setStatus] = useState<Status|null>(initialStatus);
  const [workflow,setWorkflow] = useState<WorkflowProgressState>(initialWorkflow);
  const workflowRunId = workflow?.workflowRunId || "";
  const scopedWorkflowRunId = isWorkflowRunId(workflowRunId)
    ? workflowRunId
    : "";
  const storyReviewReady = isStoryReviewReady(workflow);
  const [workflowOpen,setWorkflowOpen] = useState(false);
  const [docs,setDocs] = useState<Doc[]>(initialDocuments);
  const initialProject = initialDocuments[0]?.formatted_summary?.primary_project || "Oxygen";
  const [selected,setSelected] = useState(initialDocuments.length ? `project:${initialProject}` : "");
  const [detail,setDetail] = useState<Detail|null>(null);
  const [view,setView] = useState<"timeline"|"redaction"|"probes">("timeline");
  const [sourceFocus,setSourceFocus] = useState("");
  const [activeStoryKey,setActiveStoryKey] = useState("");
  const [language,setLanguage] = useState<StoryLanguage>("en");
  void initialPrivacyDecisions;
  const [chapterReviews,setChapterReviews] = useState<Record<string,ChapterReviewState>>(initialChapterReviews);
  const [storyDataReadyRunId,setStoryDataReadyRunId] = useState(initialStorySessionReadyRunId);
  const [storySessionReadyRunId,setStorySessionReadyRunId] = useState(initialStorySessionReadyRunId);
  const [storyPersistenceReadyRunId,setStoryPersistenceReadyRunId] = useState("");
  const [storyPersistenceStatus,setStoryPersistenceStatus] = useState<StoryReviewSessionPersistenceStatus>("failed");
  const [releaseBlockers,setReleaseBlockers] = useState<ProjectReleaseActionBlockers|null>(null);
  const releaseBlockerDialogRef = useRef<HTMLElement|null>(null);
  const releaseBlockerReturnFocusRef = useRef<HTMLElement|null>(null);
  const [downloadReviewFocus,setDownloadReviewFocus] = useState<StoryReviewFocusTarget|null>(null);
  const timelineScrollRef = useRef<HTMLDivElement|null>(null);
  const phaseSectionRefs = useRef(new Map<number,HTMLElement>());
  const timelineContextRef = useRef({ key:"", scrollTop:0 });
  const releasePreviewReturnSelectionRef = useRef<string|null>(null);
  const storyDataLoadingRunRef = useRef("");
  const storySessionLoadingRunRef = useRef("");
  const storySessionHydratedRunRef = useRef(initialStorySessionReadyRunId);
  const storyPersistenceReadyRunRef = useRef("");
  const currentStoryStateRef = useRef({
    chapterReviews: initialChapterReviews,
    chapters: [] as StoryViewerChapter[],
  });
  const activeChapterButtonRef = useCallback((node:HTMLButtonElement|null) => {
    if (!node) return;
    requestAnimationFrame(() => node.scrollIntoView({ block:"nearest" }));
  }, []);
  const clearDownloadReviewFocus = useCallback(() => {
    setDownloadReviewFocus(null);
  }, []);
  const [railWidth,setRailWidth] = useState(330);
  const [railHeight,setRailHeight] = useState(280);
  const [activePhaseIndex,setActivePhaseIndex] = useState(0);
  const [error,setError] = useState("");
  const organizationErrorRef = useRef("");
  const [redactions,setRedactions] = useState<Redaction[]>([]);
  const [redactionJob,setRedactionJob] = useState<RedactionJob>(null);
  const [redactionBusy,setRedactionBusy] = useState("");
  const [storyPrivacy,setStoryPrivacy] = useState<StoryPrivacyState>({
    status:"unavailable", authority:null, message:"Story review is not ready.",
  });
  const [storyPrivacyRunId,setStoryPrivacyRunId] = useState("");
  const [storyPrivacyBusy,setStoryPrivacyBusy] = useState("");
  const [storyPrivacyRequests] = useState(() => new StoryPrivacyRequestGate());
  const [releaseConfirmationRequests] = useState(() => new ProjectReleaseConfirmationRequestGate());
  const [releaseDownloadRequests] = useState(() => new ProjectReleaseDownloadRequestGate());
  const [releaseConfirmationBusyRunId,setReleaseConfirmationBusyRunId] = useState("");
  const [releaseDownloadBusy,setReleaseDownloadBusy] = useState<ProjectReleaseAction|null>(null);
  const redactionJobStatus = redactionJob?.status;
  const loadStoryPrivacyRef = useRef<null | ((message?: string, replace?: boolean) => Promise<unknown>)>(null);
  const refreshStoryPrivacyAfterPersistenceRef = useRef(false);
  const [storyPersistence] = useState(() => new StoryReviewSessionPersistenceQueue({
      save: async (request) => {
        const response = await fetch("/api/story-review-session", {
          method:"POST",
          headers:{ "content-type":"application/json" },
          body:JSON.stringify(request),
        });
        const payload = await response.json().catch(() => ({})) as Partial<StoryReviewSessionSaveAcknowledgement>
          & { error?:string; code?:string };
        if (!response.ok) {
          throw new StoryReviewSessionPersistenceError(
            payload.code || "STORY_SESSION_SAVE_FAILED",
            payload.error || "Story review state could not be safely persisted",
          );
        }
        return payload as StoryReviewSessionSaveAcknowledgement;
      },
      onStatus: (persistence) => {
        setStoryPersistenceStatus(persistence.status);
        if (persistence.status === "conflict") {
          setStoryPersistenceReadyRunId("");
          setError("Story review changed or its source was replaced. Reload before continuing.");
        } else if (persistence.status === "failed" && persistence.errorCode) {
          setStoryPersistenceReadyRunId("");
          setError("Story review state could not be safely persisted");
        }
      },
    }));

  const loadWorkflow = useCallback(async (signal?: AbortSignal) => {
    const query = scopedWorkflowRunId
      ? `?workflowRunId=${encodeURIComponent(scopedWorkflowRunId)}`
      : "";
    let response = await fetch(`/api/workflow${query}`, { cache:"no-store", ...(signal ? { signal } : {}) });
    if (response.status === 409 && scopedWorkflowRunId && !signal?.aborted) {
      response = await fetch("/api/workflow", { cache:"no-store", ...(signal ? { signal } : {}) });
    }
    if (!response.ok) return null;
    const next = await response.json() as WorkflowProgressState;
    if (signal?.aborted) return null;
    setWorkflow(next);
    return next;
  }, [scopedWorkflowRunId]);

  const loadCurrentWorkflow = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/workflow", { cache:"no-store", ...(signal ? { signal } : {}) });
    if (!response.ok) return null;
    const next = await response.json() as WorkflowProgressState;
    if (signal?.aborted) return null;
    setWorkflow(next);
    return next;
  }, []);

  useEffect(() => {
    const polling = startWorkflowPolling(async ({ signal }) => {
      await loadWorkflow(signal);
    });
    return () => polling.retire();
  }, [loadWorkflow]);

  useEffect(() => () => {
    releaseConfirmationRequests.retire();
    releaseDownloadRequests.retire();
  }, [releaseConfirmationRequests, releaseDownloadRequests, workflowRunId]);

  useEffect(() => {
    if (releaseBlockers) releaseBlockerDialogRef.current?.focus({preventScroll:true});
  }, [releaseBlockers]);

  useEffect(() => {
    if (!workflowRunId || !storyReviewReady || storySessionReadyRunId !== workflowRunId) {
      refreshStoryPrivacyAfterPersistenceRef.current = false;
    }
  }, [storyReviewReady, storySessionReadyRunId, workflowRunId]);

  useEffect(() => {
    if (storyPersistenceStatus !== "durable"
      || !refreshStoryPrivacyAfterPersistenceRef.current) return;
    refreshStoryPrivacyAfterPersistenceRef.current = false;
    void loadStoryPrivacyRef.current?.(
      "The durable applied review was checked against the current release targets.",
      true,
    );
  }, [storyPersistenceStatus]);

  const loadRedactions = useCallback(async () => {
    const response = await fetch("/api/redactions", { cache:"no-store" });
    if (!response.ok) {
      setError("Source Privacy authority could not be loaded");
      return;
    }
    const payload = await response.json() as { redactions: Redaction[]; job: RedactionJob };
    setRedactions(payload.redactions || []);
    setRedactionJob(payload.job);
    void loadWorkflow();
  }, [loadWorkflow]);

  // Poll only while a pass is in flight, so the tab can say "还在跑" instead of
  // showing an empty comparison that looks like "nothing was found".
  useEffect(() => {
    const initial = setTimeout(() => { void loadRedactions(); }, 0);
    const polling = redactionJobStatus === "running"
      ? setInterval(() => { void loadRedactions(); }, 4000)
      : undefined;
    return () => {
      clearTimeout(initial);
      if (polling) clearInterval(polling);
    };
  }, [loadRedactions, redactionJobStatus]);

  async function decideRedaction(id: string, decision: "keep" | "redact") {
    setRedactionBusy(id);
    setError("");
    try {
      const response = await fetch(`/api/redactions/${encodeURIComponent(id)}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Source Privacy decision was not accepted");
      await loadRedactions();
    } catch (value) {
      setError(value instanceof Error ? value.message : "Source Privacy decision was not accepted");
    } finally {
      setRedactionBusy("");
    }
  }

  const [probes,setProbes] = useState<Probe[]>([]);
  const [bulkDecisions,setBulkDecisions] = useState<BulkDecision[]>([]);
  const [probeRun,setProbeRun] = useState<ProbeRun>(null);
  const [preferenceLifecycleCurrent,setPreferenceLifecycleCurrent] = useState(false);
  const [probeBusy,setProbeBusy] = useState("");
  const probeRunStatus = probeRun?.status;

  const loadProbes = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/probes", { cache:"no-store", ...(signal ? { signal } : {}) });
    if (!response.ok) return;
    const payload = await response.json() as { lifecycleCurrent:boolean; probes: Probe[]; bulkDecisions: BulkDecision[]; run: ProbeRun };
    if (signal?.aborted) return;
    setProbes(payload.probes || []);
    setPreferenceLifecycleCurrent(payload.lifecycleCurrent===true);
    setBulkDecisions(payload.bulkDecisions || []);
    setProbeRun(payload.run);
  }, []);

  useEffect(() => {
    const initial = setTimeout(() => { void loadProbes(); }, 0);
    const polling = probeRunStatus === "running"
      ? setInterval(() => { void loadProbes(); }, 4000)
      : undefined;
    return () => {
      clearTimeout(initial);
      if (polling) clearInterval(polling);
    };
  }, [loadProbes, probeRunStatus]);

  async function answerProbe(id: string, patch: { choice?: string; text?: string; clear?: boolean; bulk?: boolean }) {
    setProbeBusy(id);
    await fetch(`/api/probes/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    await loadProbes();
    await loadWorkflow();
    setProbeBusy("");
  }

  const loadDocs = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/documents", { cache:"no-store", ...(signal ? { signal } : {}) });
    if (!response.ok) throw new Error("Could not load local records");
    const payload = await response.json() as { documents: Doc[] };
    const next = payload.documents;
    if (signal?.aborted) return next;
    setDocs(next);
    const primary = next[0]?.formatted_summary?.primary_project || "Oxygen";
    setSelected((current) => {
      if (current.startsWith("project:") || next.some((doc) => doc.id === current)) return current;
      return `project:${primary}`;
    });
    return next;
  }, []);

  const setOrganizationPollingError = useCallback((message: string) => {
    organizationErrorRef.current = message;
    setError(message);
  }, []);

  const clearOrganizationPollingError = useCallback(() => {
    const organizationError = organizationErrorRef.current;
    if (!organizationError) return;
    organizationErrorRef.current = "";
    setError((current) => current === organizationError ? "" : current);
  }, []);

  useEffect(() => {
    return startOrganizationPolling({
      loadWorkflow,
      requestOrganization: fetchOrganizationStatus,
      loadDocuments: loadDocs,
      onStatus: setStatus,
      onError: setOrganizationPollingError,
      onRecovered: clearOrganizationPollingError,
    });
  }, [clearOrganizationPollingError, loadDocs, loadWorkflow, setOrganizationPollingError, workflow?.currentStageId]);

  useEffect(() => {
    if (!workflowRunId || !storyReviewReady) {
      storyDataLoadingRunRef.current = "";
      storySessionLoadingRunRef.current = "";
      storySessionHydratedRunRef.current = "";
      if (storyPersistenceReadyRunRef.current) storyPersistence.invalidate();
      storyPersistenceReadyRunRef.current = "";
      return;
    }
    if (storyDataReadyRunId === workflowRunId
      || storyDataLoadingRunRef.current === workflowRunId) return;
    storyDataLoadingRunRef.current = workflowRunId;
    let cancelled = false;
    const loadActivatedStory = async () => {
      try {
        const response = await fetch("/api/organization", { cache:"no-store" });
        if (!response.ok) throw new Error("Story organization status could not be loaded");
        const nextStatus = await response.json() as Status;
        await loadDocs();
        if (!cancelled) {
          setStatus(nextStatus);
          storySessionHydratedRunRef.current = "";
          setStorySessionReadyRunId("");
          setStoryDataReadyRunId(workflowRunId);
        }
      } catch (value) {
        if (!cancelled) setError(value instanceof Error ? value.message : "Project Story could not be loaded");
      } finally {
        if (storyDataLoadingRunRef.current === workflowRunId) storyDataLoadingRunRef.current = "";
      }
    };
    void loadActivatedStory();
    return () => { cancelled = true; };
  }, [loadDocs, storyDataReadyRunId, storyPersistence, storyReviewReady, workflowRunId]);

  useEffect(() => {
    if (!selected || selected.startsWith("project:")) return;
    let cancelled = false;
    fetch(`/api/documents/${encodeURIComponent(selected)}`, { cache:"no-store" }).then((r) => r.json()).then((value) => { if (!cancelled) setDetail(value); });
    return () => { cancelled = true; };
  }, [selected]);

  const allStoryItems = useMemo(() => docs.flatMap((doc) => (
    doc.formatted_summary?.highlights || []
  ).map((event) => ({ ...event, documentId:doc.id })))
    .sort(compareStorySourceIdentity), [docs]);
  const metadataPrimaryProject = docs[0]?.formatted_summary?.primary_project || "Oxygen";
  const storySelection = useMemo(
    () => selectViewerChapters(allStoryItems, metadataPrimaryProject),
    [allStoryItems, metadataPrimaryProject],
  );
  const reservedStoryCandidates = useMemo(() => allStoryItems.filter((event) => (
    isReservedStoryOrganizationReason(event.summary)
  )), [allStoryItems]);
  const storyPackageReady = reservedStoryCandidates.length > 0
    && reservedStoryCandidates.every((event) => String(event.summary || "").startsWith(STORY_PREFIX))
    && storySelection.chapters.length === reservedStoryCandidates.length
    && !storySelection.invalid;
  const storyContract = workflow.storySourceSchema === "oxygen.story"
    && workflow.storySessionSchema === STORY_REVIEW_SESSION_SCHEMA;
  const storyReady = storyContract && storyPackageReady;
  const loadStoryPrivacy = useCallback(async (message?: string, replace = false) => {
    if (!scopedWorkflowRunId) {
      storyPrivacyRequests.retire();
      setStoryPrivacyRunId("");
      setStoryPrivacy({ status:"unavailable", authority:null, message:"Story review is not ready." });
      return null;
    }
    const request = storyPrivacyRequests.begin(replace);
    if (!request) return null;
    setStoryPrivacyRunId(scopedWorkflowRunId);
    try {
      const response = await fetch(`/api/story-privacy?workflowRunId=${encodeURIComponent(scopedWorkflowRunId)}`, {
        cache:"no-store", signal:request.signal,
      });
      const payload = await response.json().catch(() => ({})) as unknown;
      if (!storyPrivacyRequests.isCurrent(request)) return null;
      if (!response.ok) {
        const failure = payload as { error?: string };
        throw new Error(failure.error || "Current Story Privacy authority is unavailable");
      }
      const authority = parseStoryPrivacyAuthority(payload);
      if (!authority || authority.workflowRunId !== scopedWorkflowRunId) {
        throw new Error("Current Story Privacy authority is invalid");
      }
      setStoryPrivacy((current) => ({
        status:"ready",
        authority,
        message:message ?? (current.status === "ready" ? current.message : ""),
      }));
      return authority;
    } catch (value) {
      if (!storyPrivacyRequests.isCurrent(request)) return null;
      setStoryPrivacy({
        status:"error",
        authority:null,
        message:value instanceof Error ? value.message : "Current Story Privacy authority is unavailable",
      });
      return null;
    } finally {
      storyPrivacyRequests.finish(request);
    }
  }, [scopedWorkflowRunId, storyPrivacyRequests]);
  useEffect(() => {
    loadStoryPrivacyRef.current = loadStoryPrivacy;
    return () => {
      if (loadStoryPrivacyRef.current === loadStoryPrivacy) loadStoryPrivacyRef.current = null;
    };
  }, [loadStoryPrivacy]);

  const storyPrivacyEligible = storyReviewReady && storyReady
    && storyDataReadyRunId === workflowRunId && Boolean(scopedWorkflowRunId);
  useEffect(() => {
    if (!storyPrivacyEligible) {
      storyPrivacyRequests.retire();
      return;
    }
    const start = setTimeout(() => {
      setStoryPrivacyRunId(workflowRunId);
      setStoryPrivacy({ status:"loading", authority:null, message:"" });
      void loadStoryPrivacy("", true);
    }, 0);
    return () => {
      clearTimeout(start);
      storyPrivacyRequests.retire();
    };
  }, [loadStoryPrivacy, storyPrivacyEligible, storyPrivacyRequests, workflowRunId]);

  const presentedStoryPrivacy: StoryPrivacyState = storyPrivacyEligible
    ? storyPrivacyRunId === workflowRunId
      ? storyPrivacy
      : { status:"loading", authority:null, message:"" }
    : { status:"unavailable", authority:null, message:"Story review is not ready." };

  const currentStoryPrivacyAuthority = presentedStoryPrivacy.status === "ready"
    && presentedStoryPrivacy.authority.workflowRunId === workflowRunId
    ? presentedStoryPrivacy.authority
    : null;
  const storyPrivacyAuthorityIsCurrent = storyPrivacyAuthorityCurrent(
    presentedStoryPrivacy,
    workflowRunId,
  );
  const storyPrivacyReviewApplicable = storyPrivacyAuthorityIsCurrent;
  const storyPrivacyReleaseComplete = storyPrivacyAuthorityIsCurrent
    && storyPrivacyAuthorityComplete(currentStoryPrivacyAuthority);
  const storyPrivacyResolved = currentStoryPrivacyAuthority?.candidates
    .filter(storyPrivacyCandidateResolved).length || 0;
  const storyPrivacyTotal = currentStoryPrivacyAuthority?.candidates.length || 0;

  const decideStoryPrivacyTarget = async (
    target: StoryPrivacyTarget,
    choice: StoryPrivacyTargetChoice,
  ) => {
    const authority = currentStoryPrivacyAuthority;
    if (!authority || authority.status === "preparation_required"
      || !authority.targets.some((value) => value.targetId === target.targetId
        && value.targetContentDigest === target.targetContentDigest)) return;
    setStoryPrivacyBusy(target.targetId);
    setStoryPrivacy({ status:"ready", authority, message:"" });
    try {
      const response = await fetch(`/api/story-privacy/${encodeURIComponent(target.targetId)}`, {
        method:"PATCH",
        headers:{ "content-type":"application/json" },
        body:JSON.stringify({
          workflowRunId:authority.workflowRunId,
          sourceRevision:authority.sourceRevision,
          activeStoryDigest:authority.activeStoryDigest,
          authorityDigest:authority.authorityDigest,
          targetContentDigest:target.targetContentDigest,
          editedText:choice.editedText,
          publicOverrides:choice.publicOverrides,
        }),
      });
      const payload: unknown = await response.json().catch(() => ({}));
      if (response.status === 409) {
        setStoryPrivacy({ status:"loading", authority:null, message:"" });
        await loadStoryPrivacy("The target authority changed while saving. The durable current result is shown; no mutation was retried.", true);
        return;
      }
      const next = parseStoryPrivacyAuthority(payload);
      if (!response.ok || !next || next.workflowRunId !== authority.workflowRunId) {
        const error = payload && typeof payload === "object" && "error" in payload
          ? String((payload as { error?: unknown }).error || "") : "";
        throw new Error(error || "Story Privacy target choice was not accepted");
      }
      setStoryPrivacy({
        status:"ready",
        authority:next,
        message:"Target choice saved to the exact current release authority.",
      });
    } catch (value) {
      setStoryPrivacy({ status:"error", authority:null,
        message:value instanceof Error ? value.message : "Story Privacy target choice was not accepted" });
    } finally {
      setStoryPrivacyBusy("");
    }
  };
  const effectiveError = storyReviewReady && !storyReady
    ? "The active Story contract does not match the exact reviewed source package" : error;
  const navigationCandidates = useMemo(() => storySelection.chapters.map((chapter) => ({
    project: chapter.project,
    story: { key: chapter.source.key },
  })), [storySelection.chapters]);
  const projectNames = storyNavigationProjects(navigationCandidates);
  const primaryProject = projectNames.includes(metadataPrimaryProject)
    ? metadataPrimaryProject
    : projectNames[0] || metadataPrimaryProject;
  const isProject = selected.startsWith("project:");
  const requestedProject = isProject ? selected.slice("project:".length) : "";
  const navigation = isProject
    ? resolveStoryNavigation(navigationCandidates, { project:requestedProject, storyKey:activeStoryKey }, primaryProject)
    : { project:"", storyKey:"" };
  const selectedProject = navigation.project;

  useEffect(() => {
    const documentsReady = status?.status === "empty"
      || (status?.status === "complete" && docs.length >= status.documentCount);
    if (!workflowRunId || !storyReviewReady || storyDataReadyRunId !== workflowRunId || !documentsReady || !storyReady
      || (storySessionHydratedRunRef.current === workflowRunId
        && storyPersistenceReadyRunRef.current === workflowRunId)
      || storySessionLoadingRunRef.current === workflowRunId) return;
    storySessionLoadingRunRef.current = workflowRunId;
    let cancelled = false;
    const hydrate = async () => {
      try {
        const response = await fetch(`/api/story-review-session?workflowRunId=${encodeURIComponent(workflowRunId)}`, { cache:"no-store" });
        if (!response.ok) throw new Error("Story review persistence could not be loaded");
        const payload = await response.json() as {
          session?: unknown;
          serverVersion?: unknown;
          sourceRevision?: unknown;
          persistedAt?: unknown;
          storySourceSchema?: unknown;
          storySessionSchema?: unknown;
        };
        if (!Number.isSafeInteger(payload.serverVersion) || Number(payload.serverVersion) < 0
          || !validActivatedSourceRevision(payload.sourceRevision)
          || (payload.persistedAt !== null && typeof payload.persistedAt !== "string")) {
          throw new Error("Story review persistence metadata is invalid");
        }
        if (payload.storySourceSchema !== workflow.storySourceSchema
          || payload.storySessionSchema !== workflow.storySessionSchema) {
          throw new Error("Story source and server-owned review contracts do not match");
        }
        const parsedSession = parseStoryReviewSession(payload.session);
        if (parsedSession && parsedSession.schema !== STORY_REVIEW_SESSION_SCHEMA) {
          throw new Error("Story source and persisted review session do not match");
        }
        const canonicalSession = canonicalizeStoryReviewSession(parsedSession);
        const sources = storySelection.chapters.map((chapter) => chapter.source);
        const restored = parsedSession
          ? hydrateStoryReviewSession(parsedSession, workflowRunId, sources)
          : { chapterReviews: Object.fromEntries(sources.map((source) => [
            source.key, emptyChapterReview(source),
          ])), privacyDecisions: {} };
        if (parsedSession && Object.keys(restored.chapterReviews).length !== sources.length) {
          throw new Error("Story review session does not match the exact current source");
        }
        if (!cancelled) {
          storyPersistence.initialize({
            workflowRunId,
            serverVersion: Number(payload.serverVersion),
            sourceRevision: Number(payload.sourceRevision),
            session: canonicalSession,
            persistedAt: payload.persistedAt as string|null,
          });
          setChapterReviews(restored.chapterReviews);
          storySessionHydratedRunRef.current = workflowRunId;
          storyPersistenceReadyRunRef.current = workflowRunId;
          setStoryPersistenceReadyRunId(workflowRunId);
          setStorySessionReadyRunId(workflowRunId);
        }
      } catch (value) {
        if (!cancelled) {
          setChapterReviews({});
          setError(value instanceof Error ? value.message : "Story review persistence could not be loaded");
        }
      } finally {
        if (!cancelled) storySessionLoadingRunRef.current = "";
      }
    };
    void hydrate();
    return () => {
      cancelled = true;
      if (storySessionLoadingRunRef.current === workflowRunId) storySessionLoadingRunRef.current = "";
    };
  }, [docs.length, status?.documentCount, status?.status, storyDataReadyRunId, storyPersistence, storyReady, storyReviewReady, storySelection, workflow.storySessionSchema, workflow.storySourceSchema, workflowRunId]);

  useEffect(() => {
    if (!workflowRunId || storySessionReadyRunId !== workflowRunId
      || storySessionHydratedRunRef.current !== workflowRunId
      || storyPersistenceReadyRunRef.current !== workflowRunId) return;
    const session = createStoryReviewSession(workflowRunId, chapterReviews, {});
    if (!session) {
      const errorTimer = setTimeout(() => setError("Story review state could not be safely persisted"), 0);
      return () => clearTimeout(errorTimer);
    }
    storyPersistence.schedule(session);
  }, [chapterReviews, storyPersistence, storySessionReadyRunId, workflowRunId]);

  const storyWorkspaceReady = isStoryWorkspaceReady(workflow, {
    storyDataReadyRunId,
    storySessionReadyRunId,
    documentCount: docs.length,
    organizationStatus: status?.status,
  });
  const projectCount = (name:string) => docs.reduce((sum,doc) => sum + Number((doc.formatted_summary?.projects || []).find((project) => project.name === name)?.event_count || 0), 0);
  const summary:Summary = isProject ? {
    primary_project: selectedProject,
    project_summary: selectedProject === primaryProject ? (docs[0]?.formatted_summary?.project_summary || "A chronological view across every collected local trajectory.") : `A combined timeline for ${selectedProject} across every source trajectory.`,
    projects: [{ name:selectedProject, event_count:projectCount(selectedProject), primary:selectedProject === primaryProject }],
    highlights: allStoryItems.filter((event) => event.project === selectedProject),
  } : detail?.document.formatted_summary || {};
  const projectChapters = storySelection.chapters.filter((chapter) => chapter.project === selectedProject);
  const setStoryNavigation = (
    requested: Partial<StoryNavigation>,
    historyMode: "push"|"replace" = "push",
  ) => {
    const next = resolveStoryNavigation(navigationCandidates, requested, primaryProject);
    setSelected(next.project ? `project:${next.project}` : "");
    setActiveStoryKey(next.storyKey);
    updateStoryNavigationUrl(next, historyMode);
    return next;
  };
  useEffect(() => {
    currentStoryStateRef.current = { chapterReviews, chapters:projectChapters };
  }, [chapterReviews, projectChapters]);
  useEffect(() => {
    if (!storyWorkspaceReady || storySessionReadyRunId !== workflowRunId
      || view !== "timeline" || !navigationCandidates.length) return;
    const restoreFromUrl = () => {
      const next = resolveStoryNavigation(
        navigationCandidates,
        readStoryNavigation(window.location.search),
        primaryProject,
      );
      setSelected(`project:${next.project}`);
      setActiveStoryKey(next.storyKey);
      updateStoryNavigationUrl(next, "replace");
      setSourceFocus("");
      setView("timeline");
    };
    restoreFromUrl();
    window.addEventListener("popstate", restoreFromUrl);
    return () => window.removeEventListener("popstate", restoreFromUrl);
  }, [navigationCandidates, primaryProject, storySessionReadyRunId, storyWorkspaceReady, view, workflowRunId]);
  if (!storyWorkspaceReady) {
    return <WorkflowProgress workflow={workflow} status={status} error={effectiveError} language={language} />;
  }
  if (!storyReady
    || (view === "timeline" && !projectChapters.length)
    || storySessionReadyRunId !== workflowRunId) {
    return <WorkflowProgress workflow={workflow} status={status} error={effectiveError} language={language} />;
  }
  const storyLanguage: StoryLanguage = language;
  const labels = workspaceUi[storyLanguage];
  const projectStorySummary = summary.project_summary;
  const viewerChapters:TimelineChapter[] = projectChapters.map((chapter) => {
    const timeline = timelinePresentation(chapter.source);
    const dateLabel = chapter.timestamp ? fmtTimelineDate(chapter.timestamp,storyLanguage) : undefined;
    return {
      key:chapter.source.key,
      project:chapter.project,
      phase:chapter.source.phase.label,
      kind:timeline.kind,
      title:chapter.source.title,
      overview:chapter.source.overview,
      timestamp:chapter.timestamp,
      dateLabel,
      evidenceCount:1+chapter.source.evidence.supporting.length,
      readingMinutes:Math.max(1,Math.ceil(chapter.source.story.blocks.reduce((count,block) => count+block.text.trim().split(/\s+/u).length,0)/220)),
      before:timeline.before,
      after:timeline.after,
      chips:timeline.chips,
      timelineMarker:timeline.marker,
      chapter,
    };
  });
  const phaseGroups = viewerChapters.reduce<Array<{ name:string; events:TimelineChapter[] }>>((groups,event) => {
    const phase=event.phase;
    const previous=groups.at(-1);
    if(previous?.name===phase) previous.events.push(event);
    else groups.push({name:phase,events:[event]});
    return groups;
  },[]);
  const chapterNumber = new Map(viewerChapters.map((event,index) => [event.key,index+1]));
  const activeStoryIndex = viewerChapters.findIndex((event) => event.key === navigation.storyKey);
  const activeChapter = activeStoryIndex >= 0 ? viewerChapters[activeStoryIndex] : null;
  const activeSourceChapter = activeChapter?.chapter || null;
  const activeChapterPrivacyCandidates = activeSourceChapter
    ? chapterStoryPrivacyCandidates(currentStoryPrivacyAuthority, activeSourceChapter.source.key)
    : [];
  const insightProgress = projectChapters.reduce((progress,chapter) => {
    progress.total+=chapter.source.insights.length;
    progress.resolved+=chapter.source.insights.filter((insight) => {
      const review=chapterReviews[chapter.source.key]?.sourceInsightReviews[insight.id];
      return review?.resolution==="applied" && review.appliedVersion===review.version;
    }).length;
    return progress;
  },{resolved:0,total:0});
  const reviewedInsights = insightProgress.resolved;
  const reviewedInsightTotal = insightProgress.total;
  const confirmedChapters = projectChapters.filter((chapter) => {
      const state=chapterReviews[chapter.source.key];
      return state?.stage === "human_confirmed"
        && chapterReviewCompletionBlockers(state,completionContext(chapter.source)).length === 0;
    }).length;
  const displayedWorkflow = workflow ? withHumanReviewProgress(workflow, confirmedChapters, viewerChapters.length) : null;
  const phaseSectionRef = (index:number,node:HTMLElement|null) => {
    if(node) phaseSectionRefs.current.set(index,node);
    else phaseSectionRefs.current.delete(index);
  };
  const updateActivePhase = () => {
    const stream=timelineScrollRef.current;
    if(!stream || view!=="timeline") return;
    const streamTop=stream.getBoundingClientRect().top;
    let next=0;
    for(const [index,node] of phaseSectionRefs.current) if(node.getBoundingClientRect().top<=streamTop+120) next=index;
    setActivePhaseIndex((current) => current===next?current:next);
  };
  const scrollToPhase = (index:number) => {
    const stream=timelineScrollRef.current;
    const section=phaseSectionRefs.current.get(index);
    if(!stream || !section) return;
    const top=stream.scrollTop+section.getBoundingClientRect().top-stream.getBoundingClientRect().top-16;
    setActivePhaseIndex(index);
    stream.scrollTo({top,behavior:"smooth"});
  };
  const openStory = (storyKey:string) => {
    timelineContextRef.current={key:storyKey,scrollTop:timelineScrollRef.current?.scrollTop || 0};
    setStoryNavigation({ project:selectedProject, storyKey });
  };
  const navigateStory = (storyKey:string) => {
    setStoryNavigation({ project:selectedProject, storyKey });
  };
  const openReleasePreview = () => {
    setSourceFocus("");
    setActiveStoryKey("");
    setView("redaction");
  };
  const openGlobalStoryPrivacy = () => {
    releasePreviewReturnSelectionRef.current=null;
    setSourceFocus("");
    setDetail(null);
    setStoryNavigation({ project:selectedProject, storyKey:"" });
    setView("redaction");
  };
  const restoreReleasePreviewSelection = () => {
    if(!releasePreviewReturnSelectionRef.current) return;
    setStoryNavigation({
      project:releasePreviewReturnSelectionRef.current.slice("project:".length),
      storyKey:"",
    });
    setDetail(null);
    releasePreviewReturnSelectionRef.current=null;
  };
  const closeStory = () => {
    const context=timelineContextRef.current;
    setStoryNavigation({ project:selectedProject, storyKey:"" });
    requestAnimationFrame(() => {
      if(timelineScrollRef.current) timelineScrollRef.current.scrollTop=context.scrollTop;
      document.getElementById(`story-open-${context.key}`)?.focus({preventScroll:true});
    });
  };
  const updateChapterReview = (
    storyKey:string,
    review:ChapterReviewState,
  ) => {
    const previous=currentStoryStateRef.current.chapterReviews[storyKey];
    if (previous && review.revision > previous.revision) {
      refreshStoryPrivacyAfterPersistenceRef.current = true;
      storyPrivacyRequests.retire();
      setStoryPrivacyRunId(workflowRunId);
      setStoryPrivacy({ status:"loading", authority:null, message:"" });
    }
    setChapterReviews((current) => ({...current,[storyKey]:review}));
  };
  const currentDownloadReviewBlockerGroups = () => groupDownloadReviewBlockers(storySelection.chapters.map((chapter) => {
      const state=chapterReviews[chapter.source.key] || emptyChapterReview(chapter.source);
      return {
        project:chapter.project,
        chapterKey:chapter.source.key,
        stage:state.stage,
        completionBlockers:chapterReviewCompletionBlockers(state,completionContext(chapter.source)),
      };
    }));
  const allCurrentPreferencesComplete = preferenceLifecycleCurrent && !probes.some((probe) =>
    probe.lifecycle_status !== "active" && probe.lifecycle_status !== "inactive" && probe.lifecycle_status !== "history")
    && ((probes: Probe[]) => projectReleaseConfirmationPreferencesComplete(probeRun, probes, bulkDecisions))
      (probes.filter((probe) => probe.lifecycle_status === "active"));
  const releaseConfirmed = workflow.releaseConfirmed === true;
  const releaseConfirmationBusy = releaseConfirmationBusyRunId === workflowRunId;
  const reviewAuthorityCurrent = storySessionReadyRunId === workflowRunId
    && storyPersistenceReadyRunId === workflowRunId
    && storyPersistenceStatus === "durable";
  const storyPrivacyReleaseState = storyPrivacyReleaseComplete ? "complete"
    : storyPrivacyAuthorityIsCurrent ? "unresolved"
      : currentStoryPrivacyAuthority?.status === "preparation_required"
        ? "preparation_required" : "unavailable";
  const preferenceReleaseState = !probeRun ? "missing"
    : !preferenceLifecycleCurrent ? "stale"
      : allCurrentPreferencesComplete ? "complete" : "unanswered";
  const currentProjectReleaseActionBlockers = (action:ProjectReleaseAction) => (
    projectReleaseActionBlockers({
      action,
      chapterGroups:currentDownloadReviewBlockerGroups(),
      storyPrivacy:storyPrivacyReleaseState,
      preferences:preferenceReleaseState,
      reviewAuthorityCurrent,
      releaseConfirmed,
    })
  );
  const confirmReleaseBlockers = currentProjectReleaseActionBlockers("confirm");
  const htmlReleaseBlockers = currentProjectReleaseActionBlockers("download_html");
  const zipReleaseBlockers = currentProjectReleaseActionBlockers("download_zip");
  const releaseConfirmationEligible = !projectReleaseActionBlocked(confirmReleaseBlockers)
    && !probeBusy && !storyPrivacyBusy;
  const releaseActionsBusy = releaseConfirmationBusy || releaseDownloadBusy !== null
    || Boolean(probeBusy) || Boolean(storyPrivacyBusy) || presentedStoryPrivacy.status === "loading"
    || storyPersistenceStatus === "dirty" || storyPersistenceStatus === "saving";
  const activePreferences=probes.filter((probe)=>probe.lifecycle_status==="active");
  const openReleaseBlockerDialog = (blockers:ProjectReleaseActionBlockers) => {
    const activeElement=document.activeElement;
    releaseBlockerReturnFocusRef.current=activeElement instanceof HTMLElement ? activeElement : null;
    setReleaseBlockers(blockers);
  };
  const closeReleaseBlockerDialog = (restoreFocus=true) => {
    const returnFocus=restoreFocus ? releaseBlockerReturnFocusRef.current : null;
    releaseBlockerReturnFocusRef.current=null;
    setReleaseBlockers(null);
    if (returnFocus?.isConnected) {
      setTimeout(() => returnFocus.focus({preventScroll:true}),0);
    }
  };
  const confirmProjectRelease = async () => {
    setError("");
    if (releaseConfirmed) return;
    const blockers=currentProjectReleaseActionBlockers("confirm");
    if (projectReleaseActionBlocked(blockers)) {
      openReleaseBlockerDialog(blockers);
      return;
    }
    const request=releaseConfirmationRequests.begin(workflowRunId);
    if (!request) return;
    setReleaseConfirmationBusyRunId(workflowRunId);
    const rehydrateCurrentAuthority = async () => {
      storyPrivacyRequests.retire();
      storyPersistence.invalidate();
      storyPersistenceReadyRunRef.current="";
      setStoryPersistenceReadyRunId("");
      storySessionHydratedRunRef.current="";
      setStorySessionReadyRunId("");
      setStoryPrivacy({status:"loading",authority:null,message:""});
      const current=await loadCurrentWorkflow(request.signal);
      if (!releaseConfirmationRequests.isCurrent(request) || !current) return;
      if (current.workflowRunId === request.workflowRunId) {
        await Promise.all([
          loadStoryPrivacy("Release authority changed. The durable current result is shown; confirm again when ready.",true),
          loadProbes(request.signal),
        ]);
      }
    };
    try {
      const persistence=storyPersistence;
      if (storyPersistenceReadyRunRef.current !== workflowRunId) {
        throw new Error("Story review persistence is not ready for final release confirmation");
      }
      const response=await runDurableStoryReviewHandoff({
        persistence,
        currentSession: () => {
          const current=currentStoryStateRef.current;
          return createStoryReviewSession(workflowRunId,current.chapterReviews,{});
        },
        handoff: ({workflowRunId,serverVersion,sourceRevision}) => fetch("/api/release-confirmation",{
          method:"POST",
          headers:{"content-type":"application/json"},
          body:JSON.stringify({workflowRunId,serverVersion,sourceRevision}),
          signal:request.signal,
        }),
      });
      if (!releaseConfirmationRequests.isCurrent(request)) return;
      const failure=await response.json().catch(()=>({})) as {error?:string};
      if (response.status===409) {
        await rehydrateCurrentAuthority();
        if (releaseConfirmationRequests.isCurrent(request)) {
          setError(failure.error || "Release authority changed. Review the current state and confirm again.");
        }
        return;
      }
      if (!response.ok) throw new Error(failure.error || "Release readiness could not be confirmed");
      const refreshed=await loadCurrentWorkflow(request.signal);
      if (!releaseConfirmationRequests.isCurrent(request)) return;
      if (refreshed?.workflowRunId !== request.workflowRunId) return;
      if (refreshed.releaseConfirmed !== true) {
        throw new Error("Durable final release confirmation could not be verified");
      }
    } catch (value) {
      if (releaseConfirmationRequests.isCurrent(request)) {
        setError(value instanceof Error ? value.message : "Release readiness could not be confirmed");
      }
    } finally {
      if (releaseConfirmationRequests.isCurrent(request)) {
        setReleaseConfirmationBusyRunId("");
        releaseConfirmationRequests.finish(request);
      }
    }
  };
  const openDownloadReviewBlocker = (group:DownloadReviewBlockerGroup,blocker:DownloadReviewBlocker) => {
    closeReleaseBlockerDialog(false);
    if(!navigationCandidates.some((chapter) => chapter.project===group.project && chapter.story.key===group.chapterKey)) return;
    releasePreviewReturnSelectionRef.current=null;
    setSourceFocus("");
    setView("timeline");
    setDownloadReviewFocus({
      chapterKey:group.chapterKey,
      targetKind:blocker.targetKind,
      ...(blocker.targetId ? {targetId:blocker.targetId} : {}),
      ...(blocker.itemId ? {itemId:blocker.itemId} : {}),
    });
    setStoryNavigation({project:group.project,storyKey:group.chapterKey});
  };
  const openReleaseAuthorityBlocker = (blocker:ProjectReleaseAuthorityBlocker) => {
    closeReleaseBlockerDialog(false);
    if (blocker.destination === "release_preview") {
      openGlobalStoryPrivacy();
      return;
    }
    if (blocker.destination === "preferences") {
      restoreReleasePreviewSelection();
      setView("probes");
      return;
    }
    if (blocker.destination === "story_review") {
      const first=storySelection.chapters[0];
      if (first) {
        setView("timeline");
        setStoryNavigation({project:first.project,storyKey:first.source.key});
      }
      return;
    }
    setTimeout(() => document.getElementById("confirm-project-release")?.focus({preventScroll:true}),0);
  };
  const downloadReviewed = async (action:ProjectReleaseAction,url:string,filename:string) => {
    setError("");
    const blockers=currentProjectReleaseActionBlockers(action);
    if(projectReleaseActionBlocked(blockers)) {
      openReleaseBlockerDialog(blockers);
      return;
    }
    if (!releaseDownloadRequests.begin(action)) return;
    setReleaseDownloadBusy(action);
    const persistence=storyPersistence;
    if (storyPersistenceReadyRunRef.current !== workflowRunId) {
      setError("Story review persistence is not ready for handoff");
      releaseDownloadRequests.finish(action);
      setReleaseDownloadBusy(null);
      return;
    }
    try {
      const response=await runDurableStoryReviewHandoff({
        persistence,
        currentSession: () => {
          const current=currentStoryStateRef.current;
          return createStoryReviewSession(workflowRunId,current.chapterReviews,{});
        },
        handoff: ({workflowRunId,serverVersion,sourceRevision}) => fetch(url,{
          method:"POST",
          headers:{"content-type":"application/json"},
          body:JSON.stringify({workflowRunId,serverVersion,sourceRevision}),
        }),
      });
      if(!response.ok) {
        const failure=await response.json().catch(()=>({error:"Download failed"})) as {error?:string};
        setError(failure.error || "Download failed");
        return;
      }
      const href=URL.createObjectURL(await response.blob());
      const anchor=document.createElement("a");
      anchor.href=href;anchor.download=filename;anchor.click();
      URL.revokeObjectURL(href);
    } catch (value) {
      setError(value instanceof Error ? value.message : "Story review state could not be safely persisted");
    } finally {
      releaseDownloadRequests.finish(action);
      setReleaseDownloadBusy(null);
    }
  };
  const ready = isProject || Boolean(detail);
  const startResize = (event:ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const mobile=window.matchMedia("(max-width: 760px)").matches;
    const start=mobile?event.clientY:event.clientX;
    const initial=mobile?railHeight:railWidth;
    const move=(next:PointerEvent) => {
      const value=initial+(mobile?next.clientY:next.clientX)-start;
      if(mobile) setRailHeight(Math.max(140,Math.min(window.innerHeight*.65,value)));
      else setRailWidth(Math.max(240,Math.min(560,value)));
    };
    const stop=()=>{window.removeEventListener("pointermove",move);window.removeEventListener("pointerup",stop)};
    window.addEventListener("pointermove",move);window.addEventListener("pointerup",stop);
  };
  const workspaceStyle={"--rail-width":`${railWidth}px`,"--rail-height":`${railHeight}px`} as CSSProperties;
  const releaseBlockerCount=(releaseBlockers?.chapterGroups.reduce(
    (count,group) => count+group.blockers.length,
    0,
  ) || 0)+(releaseBlockers?.authority.length || 0);

  return <main className="shell storytellingShell">
    <header className="topbar">
      <div className="brand"><span className="brandMark">O₂</span> Oxygen</div>
      <span className="topTitle">{labels.title}</span>
      <span className="localState"><i /> {labels.local}</span>
      <button className="workflowButton" onClick={() => { void loadWorkflow(); setWorkflowOpen(true); }}>{labels.workflow}</button>
      <div className="languageToggle" aria-label="Story language">
        <button className={storyLanguage==="en"?"active":""} onClick={() => setLanguage("en")} aria-pressed={storyLanguage==="en"}>EN</button>
        <span>|</span>
        <button className={storyLanguage==="zh"?"active":""} onClick={() => setLanguage("zh")} aria-pressed={storyLanguage==="zh"}>中文</button>
      </div>
      <button id="confirm-project-release" className="download" disabled={releaseActionsBusy || releaseConfirmed} aria-disabled={!releaseConfirmed && !releaseConfirmationEligible} onClick={() => { void confirmProjectRelease(); }}>
        {releaseConfirmationBusy?labels.confirmingRelease:releaseConfirmed?labels.releaseConfirmed:labels.confirmRelease}
      </button>
      <button className="download" disabled={releaseActionsBusy} aria-disabled={projectReleaseActionBlocked(htmlReleaseBlockers)} onClick={() => { void downloadReviewed("download_html","/api/organization/export","oxygen-reviewed-story.html"); }}>Download HTML</button>
      <button className="download primary" disabled={releaseActionsBusy} aria-disabled={projectReleaseActionBlocked(zipReleaseBlockers)} onClick={() => { void downloadReviewed("download_zip","/api/package","oxygen-contribution.zip"); }}>Download ZIP</button>
    </header>
    <div className={`workspace storytellingWorkspace ${activeChapter?"episodeOpen":""}`} style={workspaceStyle}>
      <aside className="rail storyRail">
        <div className="railHead"><b>{labels.projects}</b><span>{selectedProject?viewerChapters.length:projectNames.length}</span></div>
        <div className="docList storyRailContents">{projectNames.map((project) => <button className={`docCard overview ${selectedProject===project?"active":""}`} key={project} onClick={() => { releasePreviewReturnSelectionRef.current=null; setStoryNavigation({ project, storyKey:"" }); setSourceFocus(""); setView("timeline"); }}>
          <span className="docTitle">{project}</span><span className="kind">STORY</span><small>{project===selectedProject?`${phaseGroups.length} ${labels.phases}`:`${projectCount(project).toLocaleString()} ${labels.events}`}</small>
        </button>)}{activeChapter && <div className="chapterRailContext" aria-label={storyLanguage==="zh"?"章节选择器":"Chapter selector"}>
          <span>{storyLanguage==="zh"?`章节 ${activeStoryIndex+1} / ${viewerChapters.length}`:`Chapters ${activeStoryIndex+1} / ${viewerChapters.length}`}</span>
          <nav className="chapterRailList" aria-label={storyLanguage==="zh"?"章节":"Chapters"}>
            {viewerChapters.map((event) => { const active=event.key===navigation.storyKey; return <button className={active?"active":""} aria-current={active?"page":undefined} ref={active?activeChapterButtonRef:undefined} key={event.key} onClick={() => navigateStory(event.key)}>
              <i>{chapterNumber.get(event.key)}</i><b>{event.title}</b>
            </button>})}
          </nav>
        </div>}<div className="sourceRecords"><div className="railHead evidence"><b>{labels.sources}</b><span>{docs.length}</span></div>{docs.map((doc) => <button className={`docCard ${selected===doc.id?"active":""}`} key={doc.id} onClick={() => { setSelected(doc.id); setSourceFocus(""); setActiveStoryKey(""); setView("redaction"); }}>
          <span className="docTitle">{doc.title}</span><span className="kind">{doc.kind}</span><small>{doc.item_count} events · {doc.source_system || "local"}</small>
        </button>)}</div></div>
      </aside>
      <div className="splitter" role="separator" aria-label="Resize project and source panel" aria-orientation="vertical" onPointerDown={startResize}><span /></div>
      <section className="canvas storyCanvas">
        {!ready ? <div className="empty">No organized records found.</div> : <>
          {effectiveError && <div className="workspaceError" role="alert">{effectiveError}</div>}
          <nav className="toolbar storyToolbar" aria-label="Record view" aria-hidden={activeChapter?true:undefined} inert={activeChapter?true:undefined}>
            <div className="toolbarInner"><button className={view==="timeline"?"active":""} onClick={() => { restoreReleasePreviewSelection(); setActiveStoryKey(""); setView("timeline"); }}>{labels.timeline}</button>
            <button className={view==="redaction"?"active":""} onClick={openReleasePreview}>
              {labels.release}{isProject
                ? presentedStoryPrivacy.status === "loading" ? " · loading"
                  : currentStoryPrivacyAuthority ? ` · ${currentStoryPrivacyAuthority.candidates.filter(storyPrivacyCandidateResolved).length}/${currentStoryPrivacyAuthority.candidates.length}`
                    : " · blocked"
                : redactionJob?.status === "running" ? " · running"
                  : redactions.filter((span) => span.review_state === "needs_confirmation").length
                    ? ` · ${redactions.filter((span) => span.review_state === "needs_confirmation").length} pending` : ""}
            </button>
            <button className={view==="probes"?"active":""} onClick={() => { restoreReleasePreviewSelection(); setView("probes"); }}>
              {labels.preferences}{probeRun?.status==="running"?" · running"
                :activePreferences.length?` · ${activePreferences.filter((probe)=>probe.answered_at).length}/${activePreferences.length}`:""}
            </button></div>
          </nav>
          {view!=="timeline" && <div className="canvasHead" aria-hidden={activeChapter?true:undefined} inert={activeChapter?true:undefined}><div className="canvasHeadInner">
            <span className="eyebrow">{view==="redaction"?(isProject?labels.release:labels.evidenceReview):labels.preferencesTitle}</span>
            <h1>{summary.primary_project || detail?.document.title}</h1>
          </div></div>}
          <div className={`stream ${view==="timeline" ? "storyStream" : view==="redaction" ? "reviewStream releasePreviewStream" : "reviewStream preferencesStream"}`} ref={timelineScrollRef} onScroll={updateActivePhase} aria-hidden={activeChapter?true:undefined} inert={activeChapter?true:undefined}>
            {view === "timeline" ? <>
              <div className="storyCanvasGrid"><div className="storyTimelineColumn">
                <header className="storyOrientation"><p className="eyebrow">{labels.projectStory}</p><h1>{summary.primary_project || detail?.document.title}</h1>
                  <p>{projectStorySummary}</p>
                  <div className="storyStats"><span><b>{viewerChapters.length}</b> {labels.chapters}</span><span><b>{phaseGroups.length}</b> {labels.phases}</span>{reviewedInsightTotal===0?<span><b>{storyLanguage==="zh"?"无需 AI 洞察":"No AI Insights required"}</b></span>:<span><b>{reviewedInsights}/{reviewedInsightTotal}</b> {labels.insightReviewed}</span>}<span><b>{docs.length}</b> {labels.retained}</span></div>
                  <small>{docs.length} {storyLanguage==="zh"?"条已审阅来源记录": "reviewed source records"} · {projectCount(selectedProject || primaryProject).toLocaleString()} {labels.events} · {storyLanguage==="zh"?"精确证据仅限本地":"exact evidence remains local"}</small>
                </header>
                <p className="storyNextStep" data-story-stream-instruction>↘ {labels.nextStep}</p>
                {phaseGroups.map((group,phaseIndex) => <section className="storyPhase" id={`story-phase-${phaseIndex}`} ref={(node) => phaseSectionRef(phaseIndex,node)} key={phaseGroupIdentity(group.name,phaseIndex)}>
                  <header className="phaseHeading"><span>{String(phaseIndex+1).padStart(2,"0")}</span><div><h2>{group.name}</h2><p>{group.events.length} {storyLanguage==="zh"?"个章节":`chapter${group.events.length===1?"":"s"}`}</p></div></header>
                  <div className="storyChapterList">{group.events.map((event) => <article className="storyChapter" data-kind={event.kind} data-story-key={event.key} key={event.key} aria-labelledby={`story-chapter-${event.key}`}>
                    <div className="storyChapterMeta">{event.dateLabel && <time dateTime={event.timestamp}>{event.dateLabel}</time>}{event.kind && <span>{storyKindLabel(event.kind,storyLanguage)}</span>}{event.timelineMarker === "ai_insight" && <strong>{labels.timelineAiInsight}</strong>}</div>
                    <h3 id={`story-chapter-${event.key}`}>{event.title}</h3>
                    {event.before && event.after && <div className="transition" aria-label={`${labels.before} to ${labels.after}`}>
                      <div><small>{labels.before}</small><p>{event.before}</p></div><b aria-hidden="true">→</b><div><small>{labels.after}</small><p>{event.after}</p></div>
                    </div>}
                    {event.chips && event.chips.length > 0 && <div className="storyChapterChips" aria-label={storyLanguage==="zh"?"关键事实":"Key facts"}>{event.chips.map((chip) => <span key={chip}>{chip}</span>)}</div>}
                    <footer><span>{event.evidenceCount} {labels.evidence}{storyLanguage==="en" && event.evidenceCount!==1?"s":""}</span><button id={`story-open-${event.key}`} onClick={() => openStory(event.key)}>{labels.read} · ≈ {event.readingMinutes} {storyLanguage==="zh"?"分钟":"min"} →</button></footer>
                  </article>)}</div>
                </section>)}
              </div><nav className="phaseDirectory" aria-label={storyLanguage==="zh"?"叙事阶段目录":"Narrative phase directory"}><b>{storyLanguage==="zh"?"故事阶段":"STORY PHASES"}</b>{phaseGroups.map((group,index) => <button className={activePhaseIndex===index?"active":""} aria-current={activePhaseIndex===index?"location":undefined} onClick={() => scrollToPhase(index)} key={phaseGroupIdentity(group.name,index)}>{group.name}</button>)}</nav></div>
            </> : view === "redaction" ? (isProject ? <StoryPrivacyReview
              state={presentedStoryPrivacy}
              busyId={storyPrivacyBusy}
              onTargetChoice={(target,choice) => {
                void decideStoryPrivacyTarget(target,choice);
              }}
              onRefresh={() => { void loadStoryPrivacy("Checking the exact current imported result…", true); }}
            /> : <RedactionCompare
              job={redactionJob}
              redactions={redactions}
              detail={detail}
              isProject={false}
              focusItemId={sourceFocus}
              busyId={redactionBusy}
              onDecision={(id,decision) => { void decideRedaction(id,decision); }}
            />) : view === "probes" ? <ProbePanel
              language={storyLanguage}
              run={probeRun}
              lifecycleCurrent={preferenceLifecycleCurrent}
              probes={probes}
              bulkDecisions={bulkDecisions}
              busyId={probeBusy}
              onAnswer={answerProbe}
              onReviewInsight={(storyKey,insightId) => {
                setView("timeline");setDownloadReviewFocus({chapterKey:storyKey,targetKind:"insight",targetId:insightId});openStory(storyKey);
              }}
            /> : <div className="sourceList">
              <p className="redactionNotice">
                Showing the release version. Redacted spans are replaced here — open
                <b> Redaction review</b> to see the original beside it and change a decision.
                {(() => { const n = (detail?.items || []).filter((i) => i.event_type === "action_label").length;
                  return n ? ` ${n} non-conversational event(s) ship as bare action labels and are not listed.` : ""; })()}
              </p>
              {(detail?.items || []).filter((item) => item.event_type !== "action_label").map((item) => {
                const spans = redactions.filter((span) => span.item_id === item.id);
                return <article className="sourceEvent" key={item.id}>
                  <div><b>#{item.sequence}</b><span>{fmt(item.timestamp)}</span><span>{item.event_type || "record"}</span><span>{item.organization_category}</span>{spans.length ? <span>{spans.length} redacted</span> : null}</div>
                  <pre>{spans.length ? segments(item.content, spans, true) : item.content}</pre>
                </article>;
              })}
            </div>}
          </div>
          {activeSourceChapter && <StoryChapterEditor
            key={activeSourceChapter.source.key}
            source={activeSourceChapter.source}
            position={activeStoryIndex+1}
            total={viewerChapters.length}
            language={storyLanguage}
            chapterReview={chapterReviews[activeSourceChapter.source.key] || emptyChapterReview(activeSourceChapter.source)}
            reviewFocus={downloadReviewFocus?.chapterKey===activeSourceChapter.source.key ? downloadReviewFocus : undefined}
            onReviewFocusHandled={clearDownloadReviewFocus}
            storyPrivacyStatus={currentStoryPrivacyAuthority?.status === "preparation_required"
              ? "preparation_required" : presentedStoryPrivacy.status}
            storyPrivacyCandidates={activeChapterPrivacyCandidates}
            storyPrivacyCurrent={storyPrivacyReviewApplicable}
            storyPrivacyComplete={storyPrivacyReleaseComplete}
            storyPrivacyResolved={storyPrivacyResolved}
            storyPrivacyTotal={storyPrivacyTotal}
            onOpenStoryPrivacy={openGlobalStoryPrivacy}
            onChapterReview={(review) => updateChapterReview(activeSourceChapter.source.key,review)}
            onClose={closeStory}
            onPrevious={() => navigateStory(viewerChapters[activeStoryIndex-1]?.key || activeSourceChapter.source.key)}
            onNext={() => navigateStory(viewerChapters[activeStoryIndex+1]?.key || activeSourceChapter.source.key)}
          />}
        </>}
      </section>
    </div>
    {releaseBlockers && <div className="workflowOverlay" onMouseDown={(event) => {
      if(event.target===event.currentTarget) closeReleaseBlockerDialog();
    }}>
      <section ref={releaseBlockerDialogRef} className="organizationCard workflowCard" role="dialog" aria-modal="true" aria-labelledby="download-review-title" tabIndex={-1}>
        <button className="workflowClose" onClick={() => closeReleaseBlockerDialog()} aria-label={labels.close}>×</button>
        <div className="organizationBrand"><span className="brandMark">O₂</span> Oxygen</div>
        <div className="organizationKicker">{labels.downloadReviewKicker}</div>
        <h1 id="download-review-title">{labels.downloadReviewTitle}</h1>
        <p className="organizationIntro">{labels.downloadReviewIntro}</p>
        <p className="workflowStatus">{releaseBlockerCount} {labels.downloadReviewCount}</p>
        <div>{releaseBlockers.chapterGroups.map((group,groupIndex) => <section key={`${group.project}:${group.chapterKey}`}>
          <h2>{labels.chapter} {groupIndex+1}</h2>
          {group.blockers.map((blocker,index) => <button className="docCard" key={`${blocker.code}:${blocker.targetKind}:${blocker.targetId || ""}:${blocker.itemId || ""}:${index}`} onClick={() => openDownloadReviewBlocker(group,blocker)}>
            <span className="docTitle">{labels.downloadBlockers[blocker.code]}</span><span className="kind">{labels.openReview}</span><small>{labels.openReview} →</small>
          </button>)}
        </section>)}{releaseBlockers.authority.map((blocker) => <button className="docCard releaseAuthorityBlocker" key={blocker.code} onClick={() => openReleaseAuthorityBlocker(blocker)}>
          <span className="docTitle">{labels.releaseAuthorityBlockers[blocker.code]}</span><span className="kind">{labels.openReview}</span><small>{labels.openReview} →</small>
        </button>)}</div>
        {releaseBlockers.requiresAgentRecovery && <section className="releaseAgentRecovery">
          <h2>{labels.agentRecovery}</h2>
          <textarea readOnly value={PROJECT_RELEASE_AGENT_RESUME_INSTRUCTION} aria-label={labels.agentRecovery} />
        </section>}
      </section>
    </div>}
    {workflowOpen && <WorkflowProgress workflow={displayedWorkflow} status={status} error={effectiveError} language={storyLanguage} onClose={() => setWorkflowOpen(false)} />}
  </main>;
}
