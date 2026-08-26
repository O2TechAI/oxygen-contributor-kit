"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { WorkflowProgress } from "./organization-progress";
import { RedactionCompare, segments, type Redaction, type RedactionJob } from "./redaction-compare";
import { ProbePanel, type Probe, type BulkDecision, type ProbeRun } from "./probe-panel";
import {
  StoryChapterEditor,
  type ChapterEvidenceContext,
  type ChapterReviewState,
  type PrivacyDecision,
} from "./story-chapter-editor";
import {
  applyStoryReviewToBlock,
  chapterReviewCompletionBlockers,
  emptyChapterReview,
  privacyDecisionKey,
  type ChapterReviewBlocker,
} from "../lib/story-review";
import { milestoneKindLabel, storyReleaseTargetCatalog, type EvidenceReference, type StoryLanguage, type TimelineMilestone } from "../lib/timeline";
import { selectReviewableStoryTimeline } from "../lib/story-readiness";
import { buildReviewedStoryRelease } from "../lib/story-release";
import {
  phaseGroupIdentity,
  groupDownloadReviewBlockers,
  readStoryNavigation,
  resolveStoryNavigation,
  restoreChapterContext,
  storyNavigationProjects,
  writeStoryNavigation,
  type ChapterRestoreContext,
  type DownloadReviewBlocker,
  type DownloadReviewBlockerGroup,
  type StoryNavigation,
  type StoryReviewFocusTarget,
} from "../lib/story-navigation";
import {
  canonicalizeStoryReviewSession,
  createStoryReviewSession,
  hydrateStoryReviewSession,
} from "../lib/story-review-session";
import {
  StoryReviewSessionPersistenceError,
  StoryReviewSessionPersistenceQueue,
  runDurableStoryReviewHandoff,
  type StoryReviewSessionSaveAcknowledgement,
} from "../lib/story-review-session-persistence";
import {
  isStoryReviewReady,
  isStoryWorkspaceReady,
  isWorkflowRunId,
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
    milestones:"meaningful milestones", phases:"narrative phases", reviewed:"highlights reviewed", retained:"source records retained",
    timeline:"Project Story", release:"Release preview", preferences:"Preferences", mainProject:"MAIN PROJECT", events:"events",
    introTitle:"AI-selected highlights are the table of contents.", intro:"Open a chapter for People, Story, and Privacy. AI insights stay inside the narrative; local evidence stays secondary.",
    before:"BEFORE", after:"AFTER", selected:"AI-selected highlight", evidence:"reviewed evidence event", read:"Read chapter", workflow:"Workflow",
    nextStep:"Read a Chapter to review the full story, evidence, direct learning, and reusable rules.",
    downloadReviewKicker:"Review required", downloadReviewTitle:"Review before download", downloadReviewIntro:"Complete these Chapter review items, then try the download again.", downloadReviewCount:"unresolved review items", openReview:"Open review", close:"Close",
    downloadBlockers:{
      review_state_invalid:"Review state needs attention", privacy_incomplete:"Privacy review is incomplete", evidence_unverified:"Evidence review is incomplete",
      annotation_pending:"A Story review change still needs Apply Review", annotation_needs_evidence:"A Story review change needs Evidence",
      direct_edit_pending:"A Story edit still needs Apply Review", direct_edit_needs_evidence:"A Story edit needs Evidence",
      insight_pending:"An Insight change still needs Apply Review", privacy_decisions_stale:"Privacy decisions need to be reviewed again",
      revision_provenance_mismatch:"This Chapter review needs to be refreshed", redaction_targets_mismatch:"Privacy redactions need review",
      chapter_not_confirmed:"Chapter is not marked All set",
    },
  },
  zh: {
    title:"故事审阅", local:"仅限本地 · 未上传", projects:"项目故事", total:"个项目",
    sources:"来源记录", projectStory:"项目故事", evidenceReview:"证据审阅", preferencesTitle:"贡献者偏好",
    milestones:"个重要章节", phases:"个叙事阶段", reviewed:"个高光已审阅", retained:"条来源记录保留",
    timeline:"项目故事", release:"发布预览", preferences:"偏好", mainProject:"主要项目", events:"条事件",
    introTitle:"AI 选择的高光就是故事目录。", intro:"打开一章，按人物、故事和隐私阅读；AI 洞察留在叙事中，本地证据保持为次要入口。",
    before:"之前", after:"之后", selected:"AI 选择的高光", evidence:"条已审阅证据", read:"阅读章节", workflow:"工作流",
    nextStep:"阅读任一章节，完整审阅故事、证据、直接经验与可复用规则。",
    downloadReviewKicker:"需要审阅", downloadReviewTitle:"下载前请完成审阅", downloadReviewIntro:"请完成以下章节审阅项，然后再次尝试下载。", downloadReviewCount:"项待解决审阅", openReview:"打开审阅", close:"关闭",
    downloadBlockers:{
      review_state_invalid:"审阅状态需要处理", privacy_incomplete:"隐私审阅尚未完成", evidence_unverified:"证据审阅尚未完成",
      annotation_pending:"故事审阅改动仍需应用审阅", annotation_needs_evidence:"故事审阅改动需要证据",
      direct_edit_pending:"故事编辑仍需应用审阅", direct_edit_needs_evidence:"故事编辑需要证据",
      insight_pending:"洞察改动仍需应用审阅", privacy_decisions_stale:"需要重新审阅隐私决定",
      revision_provenance_mismatch:"本章审阅需要刷新", redaction_targets_mismatch:"隐私移除项需要审阅",
      chapter_not_confirmed:"本章尚未确认完成",
    },
  },
} as const;

const fmt = (value: string | undefined, language: StoryLanguage = "en") => value
  ? new Date(value).toLocaleString(language === "zh" ? "zh-CN" : "en-US", { dateStyle:"medium", timeStyle:"short" })
  : language === "zh" ? "时间不可用" : "Time unavailable";

const fmtTimelineDate = (value: string | undefined, language: StoryLanguage = "en") => value
  ? new Date(value).toLocaleDateString(language === "zh" ? "zh-CN" : "en-US", { dateStyle:"medium" })
  : language === "zh" ? "日期不可用" : "Date unavailable";

function updateStoryNavigationUrl(navigation: StoryNavigation, historyMode: "push"|"replace") {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const search = writeStoryNavigation(url.search, navigation);
  if (url.search === search) return;
  url.search = search;
  if (historyMode === "replace") window.history.replaceState(window.history.state, "", url);
  else window.history.pushState(window.history.state, "", url);
}

function storySourceBlocks(milestone: TimelineMilestone) {
  return (["en", "zh"] as const).reduce<Record<StoryLanguage, Record<string, string>>>((result, language) => {
    const presentation = milestone.story.reviewPresentation?.[language];
    if (!presentation) return result;
    result[language] = {
      scene: presentation.story.scene,
      ...Object.fromEntries(presentation.story.reconstruction.map((copy, index) => [`reconstruction-${index}`, copy])),
      ...Object.fromEntries(presentation.story.importantDetails.map((copy, index) => [`detail-${index}`, copy])),
      outcome: presentation.story.decisionOutcome,
      ...(presentation.story.uncertainty ? { uncertainty: presentation.story.uncertainty } : {}),
    };
    return result;
  }, { en:{}, zh:{} });
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
  const [privacyDecisions,setPrivacyDecisions] = useState<Record<string,PrivacyDecision>>(initialPrivacyDecisions);
  const [chapterReviews,setChapterReviews] = useState<Record<string,ChapterReviewState>>(initialChapterReviews);
  const [storyDataReadyRunId,setStoryDataReadyRunId] = useState(initialStorySessionReadyRunId);
  const [storySessionReadyRunId,setStorySessionReadyRunId] = useState(initialStorySessionReadyRunId);
  const [evidenceReturn,setEvidenceReturn] = useState<(ChapterEvidenceContext & { projectName:string })|null>(null);
  const [chapterScrollRestore,setChapterScrollRestore] = useState<ChapterRestoreContext|null>(null);
  const [downloadBlockerGroups,setDownloadBlockerGroups] = useState<DownloadReviewBlockerGroup[]>([]);
  const [downloadReviewFocus,setDownloadReviewFocus] = useState<StoryReviewFocusTarget|null>(null);
  const [evidenceNavigationError,setEvidenceNavigationError] = useState("");
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
    privacyDecisions: initialPrivacyDecisions,
    highlights: [] as ReturnType<typeof selectReviewableStoryTimeline>,
  });
  const activeChapterButtonRef = useCallback((node:HTMLButtonElement|null) => {
    if (!node) return;
    requestAnimationFrame(() => node.scrollIntoView({ block:"nearest" }));
  }, []);
  const clearChapterRestore = useCallback(() => {
    setChapterScrollRestore(null);
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
  const redactionJobStatus = redactionJob?.status;
  const storyPersistenceRef = useRef<StoryReviewSessionPersistenceQueue|null>(null);
  if (storyPersistenceRef.current == null) {
    storyPersistenceRef.current = new StoryReviewSessionPersistenceQueue({
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
        if (persistence.status === "conflict") {
          setError("Story review changed or its source was replaced. Reload before continuing.");
        } else if (persistence.status === "failed" && persistence.errorCode) {
          setError("Story review state could not be safely persisted");
        }
      },
    });
  }

  const loadWorkflow = useCallback(async (signal?: AbortSignal) => {
    const query = scopedWorkflowRunId
      ? `?workflowRunId=${encodeURIComponent(scopedWorkflowRunId)}`
      : "";
    const response = await fetch(`/api/workflow${query}`, { cache:"no-store", ...(signal ? { signal } : {}) });
    if (!response.ok) return null;
    const next = await response.json() as WorkflowProgressState;
    if (signal?.aborted) return null;
    setWorkflow(next);
    return next;
  }, [scopedWorkflowRunId]);

  useEffect(() => {
    const polling = setInterval(() => { void loadWorkflow(); }, 2000);
    return () => clearInterval(polling);
  }, [loadWorkflow]);

  const loadRedactions = useCallback(async () => {
    const response = await fetch("/api/redactions", { cache:"no-store" });
    if (!response.ok) return;
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

  async function updateRedaction(id: string, patch: { category?: string; status?: string }) {
    setRedactionBusy(id);
    await fetch(`/api/redactions/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    await loadRedactions();
    setRedactionBusy("");
  }

  async function deleteRedaction(id: string) {
    setRedactionBusy(id);
    await fetch(`/api/redactions/${id}`, { method: "DELETE" });
    await loadRedactions();
    setRedactionBusy("");
  }

  const [probes,setProbes] = useState<Probe[]>([]);
  const [bulkDecisions,setBulkDecisions] = useState<BulkDecision[]>([]);
  const [probeRun,setProbeRun] = useState<ProbeRun>(null);
  const [probeBusy,setProbeBusy] = useState("");
  const probeRunStatus = probeRun?.status;

  const loadProbes = useCallback(async () => {
    const response = await fetch("/api/probes", { cache:"no-store" });
    if (!response.ok) return;
    const payload = await response.json() as { probes: Probe[]; bulkDecisions: BulkDecision[]; run: ProbeRun };
    setProbes(payload.probes || []);
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
      if (storyPersistenceReadyRunRef.current) storyPersistenceRef.current?.invalidate();
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
  }, [loadDocs, storyDataReadyRunId, storyReviewReady, workflowRunId]);

  useEffect(() => {
    if (!selected || selected.startsWith("project:")) return;
    let cancelled = false;
    fetch(`/api/documents/${encodeURIComponent(selected)}`, { cache:"no-store" }).then((r) => r.json()).then((value) => { if (!cancelled) setDetail(value); });
    return () => { cancelled = true; };
  }, [selected]);

  const allHighlights = useMemo(() => docs.flatMap((doc) => (
    doc.formatted_summary?.highlights || []
  ).map((event) => ({ ...event, documentId:doc.id })))
    .sort((a,b) => String(a.timestamp || "").localeCompare(String(b.timestamp || ""))), [docs]);
  const activatedStoryHighlights = useMemo(
    () => selectReviewableStoryTimeline(allHighlights),
    [allHighlights],
  );
  const projectNames = storyNavigationProjects(activatedStoryHighlights);
  const metadataPrimaryProject = docs[0]?.formatted_summary?.primary_project || "Oxygen";
  const primaryProject = projectNames.includes(metadataPrimaryProject)
    ? metadataPrimaryProject
    : projectNames[0] || metadataPrimaryProject;
  const isProject = selected.startsWith("project:");
  const requestedProject = isProject ? selected.slice("project:".length) : "";
  const navigation = isProject
    ? resolveStoryNavigation(activatedStoryHighlights, { project:requestedProject, storyKey:activeStoryKey }, primaryProject)
    : { project:"", storyKey:"" };
  const selectedProject = navigation.project;

  useEffect(() => {
    const documentsReady = status?.status === "empty"
      || (status?.status === "complete" && docs.length >= status.documentCount);
    if (!workflowRunId || !storyReviewReady || storyDataReadyRunId !== workflowRunId || !documentsReady
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
        };
        if (!Number.isSafeInteger(payload.serverVersion) || Number(payload.serverVersion) < 0
          || !Number.isSafeInteger(payload.sourceRevision) || Number(payload.sourceRevision) < 0
          || (payload.persistedAt !== null && typeof payload.persistedAt !== "string")) {
          throw new Error("Story review persistence metadata is invalid");
        }
        const canonicalSession = canonicalizeStoryReviewSession(payload.session);
        const restored = hydrateStoryReviewSession(canonicalSession, workflowRunId, activatedStoryHighlights);
        if (!cancelled) {
          storyPersistenceRef.current?.initialize({
            workflowRunId,
            serverVersion: Number(payload.serverVersion),
            sourceRevision: Number(payload.sourceRevision),
            session: canonicalSession,
            persistedAt: payload.persistedAt as string|null,
          });
          setChapterReviews(restored.chapterReviews);
          setPrivacyDecisions(restored.privacyDecisions);
          storySessionHydratedRunRef.current = workflowRunId;
          storyPersistenceReadyRunRef.current = workflowRunId;
          setStorySessionReadyRunId(workflowRunId);
        }
      } catch (value) {
        if (!cancelled) {
          setChapterReviews({});
          setPrivacyDecisions({});
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
  }, [activatedStoryHighlights, docs.length, status?.documentCount, status?.status, storyDataReadyRunId, storyReviewReady, workflowRunId]);

  useEffect(() => {
    if (!workflowRunId || storySessionReadyRunId !== workflowRunId
      || storySessionHydratedRunRef.current !== workflowRunId
      || storyPersistenceReadyRunRef.current !== workflowRunId) return;
    const session = createStoryReviewSession(workflowRunId, chapterReviews, privacyDecisions);
    if (!session) {
      const errorTimer = setTimeout(() => setError("Story review state could not be safely persisted"), 0);
      return () => clearTimeout(errorTimer);
    }
    storyPersistenceRef.current?.schedule(session);
  }, [chapterReviews, privacyDecisions, storySessionReadyRunId, workflowRunId]);

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
    highlights: allHighlights.filter((event) => event.project === selectedProject),
  } : detail?.document.formatted_summary || {};
  const highlights = selectReviewableStoryTimeline(summary.highlights || []);
  const setStoryNavigation = (
    requested: Partial<StoryNavigation>,
    historyMode: "push"|"replace" = "push",
  ) => {
    const next = resolveStoryNavigation(activatedStoryHighlights, requested, primaryProject);
    setSelected(next.project ? `project:${next.project}` : "");
    setActiveStoryKey(next.storyKey);
    updateStoryNavigationUrl(next, historyMode);
    return next;
  };
  useEffect(() => {
    currentStoryStateRef.current = { chapterReviews, privacyDecisions, highlights };
  }, [chapterReviews, highlights, privacyDecisions]);
  useEffect(() => {
    if (!storyWorkspaceReady || storySessionReadyRunId !== workflowRunId
      || view !== "timeline" || !activatedStoryHighlights.length) return;
    const restoreFromUrl = () => {
      const next = resolveStoryNavigation(
        activatedStoryHighlights,
        readStoryNavigation(window.location.search),
        primaryProject,
      );
      setSelected(`project:${next.project}`);
      setActiveStoryKey(next.storyKey);
      updateStoryNavigationUrl(next, "replace");
      setSourceFocus("");
      setEvidenceReturn(null);
      setView("timeline");
    };
    restoreFromUrl();
    window.addEventListener("popstate", restoreFromUrl);
    return () => window.removeEventListener("popstate", restoreFromUrl);
  }, [activatedStoryHighlights, primaryProject, storySessionReadyRunId, storyWorkspaceReady, view, workflowRunId]);
  if (!storyWorkspaceReady) {
    return <WorkflowProgress workflow={workflow} status={status} error={error} language={language} />;
  }
  if (!activatedStoryHighlights.length
    || (view === "timeline" && !highlights.length)
    || storySessionReadyRunId !== workflowRunId) {
    return <WorkflowProgress workflow={workflow} status={status} error={error} language={language} />;
  }
  const chineseStoryAvailable = highlights.every((event) => Boolean(event.story.reviewPresentation?.zh));
  const storyLanguage: StoryLanguage = language === "zh" && chineseStoryAvailable ? "zh" : "en";
  const labels = workspaceUi[storyLanguage];
  const localized = (event:typeof highlights[number]) => event.story.reviewPresentation?.[storyLanguage]
    || event.story.reviewPresentation?.en;
  const projectStorySummary = highlights[0]?.story.reviewPresentation?.projectSummary?.[storyLanguage]
    || (storyLanguage === "zh"
      ? "这是一段由已审阅证据重建的项目故事：它保留关键转折、失败、决定与当前边界。"
      : summary.project_summary);
  const phaseGroups = highlights.reduce<Array<{ name:string; events:typeof highlights }>>((groups,event) => {
    const phase=localized(event)?.phase || event.story.phase;
    const previous=groups.at(-1);
    if(previous?.name===phase) previous.events.push(event);
    else groups.push({name:phase,events:[event]});
    return groups;
  },[]);
  const milestoneNumber = new Map(highlights.map((event,index) => [event.story.key,index+1]));
  const activeStoryIndex = highlights.findIndex((event) => event.story.key === navigation.storyKey);
  const activeMilestone = activeStoryIndex >= 0 ? highlights[activeStoryIndex] : null;
  const reviewedInsights = highlights.filter((event) => Object.keys(chapterReviews[event.story.key]?.insightReviews || {}).length > 0).length;
  const confirmedChapters = buildReviewedStoryRelease(highlights,chapterReviews).chapters.length;
  const displayedWorkflow = workflow ? withHumanReviewProgress(workflow, confirmedChapters, highlights.length) : null;
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
  const activePrivacyReview = (activeMilestone?.story.reviewPresentation?.[storyLanguage]
    || activeMilestone?.story.reviewPresentation?.en)?.privacy.candidates.reduce<Record<string,PrivacyDecision>>((current,candidate) => {
    const decision=privacyDecisions[privacyDecisionKey(activeMilestone.story.key,candidate.id)];
    if(decision) current[candidate.id]=decision;
    return current;
  },{}) || {};
  const openStory = (storyKey:string) => {
    timelineContextRef.current={key:storyKey,scrollTop:timelineScrollRef.current?.scrollTop || 0};
    clearChapterRestore();
    setEvidenceNavigationError("");
    setEvidenceReturn(null);
    setStoryNavigation({ project:selectedProject, storyKey });
  };
  const navigateStory = (storyKey:string) => {
    clearChapterRestore();
    setEvidenceNavigationError("");
    setStoryNavigation({ project:selectedProject, storyKey });
  };
  const openReleasePreview = () => {
    setSourceFocus("");
    setEvidenceReturn(null);
    if (isProject && redactionJob?.status === "complete" && docs[0]) {
      releasePreviewReturnSelectionRef.current=`project:${selectedProject}`;
      setStoryNavigation({ project:selectedProject, storyKey:"" });
      setDetail(null);
      setSelected(docs[0].id);
    } else {
      setActiveStoryKey("");
    }
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
  const openEvidence = (evidence:EvidenceReference,context:ChapterEvidenceContext) => {
    if(!docs.some((document) => document.id===evidence.documentId)) {
      setEvidenceNavigationError(storyLanguage==="zh"?"精确证据无法打开：引用的来源记录不存在。":"Exact evidence cannot open because the referenced source record is missing.");
      return;
    }
    setEvidenceNavigationError("");
    setEvidenceReturn({...context,projectName:selectedProject || primaryProject});
    setActiveStoryKey("");
    setSelected(evidence.documentId);
    setSourceFocus(evidence.eventId);
    setView("redaction");
  };
  const backToChapter = () => {
    if(!evidenceReturn) return;
    setLanguage(evidenceReturn.language);
    setView("timeline");
    setChapterScrollRestore({storyKey:evidenceReturn.storyKey,scrollTop:evidenceReturn.scrollTop,focusOriginId:evidenceReturn.originId});
    setStoryNavigation({ project:evidenceReturn.projectName, storyKey:evidenceReturn.storyKey }, "replace");
    setEvidenceReturn(null);
  };
  const updatePrivacyDecision = (storyKey:string,candidateId:string,decision?:PrivacyDecision) => setPrivacyDecisions((current) => {
    const next={...current};
    const key=privacyDecisionKey(storyKey,candidateId);
    if(decision) next[key]=decision;
    else delete next[key];
    return next;
  });
  const updateChapterReview = (storyKey:string,review:ChapterReviewState) => setChapterReviews((current) => ({...current,[storyKey]:review}));
  const currentDownloadReviewBlockerGroups = () => groupDownloadReviewBlockers(activatedStoryHighlights.map((milestone) => {
    const chapterKey=milestone.story.key;
    const state=chapterReviews[chapterKey] || emptyChapterReview();
    const presentation=milestone.story.reviewPresentation?.en;
    const targetCatalog=presentation ? storyReleaseTargetCatalog(presentation) : null;
    const invalidBlocker:ChapterReviewBlocker={code:"review_state_invalid",chapterKey,targetKind:"chapter"};
    let completionBlockers:ChapterReviewBlocker[]=[invalidBlocker];
    if(presentation && targetCatalog) try {
      const currentPrivacyDecisions=presentation.privacy.candidates.reduce<Record<string,PrivacyDecision>>((result,candidate) => {
        const decision=privacyDecisions[privacyDecisionKey(chapterKey,candidate.id)];
        if(decision) result[candidate.id]=decision;
        return result;
      },{});
      const sourceBlocks=storySourceBlocks(milestone);
      const reviewedBlocks=(["en","zh"] as const).reduce<Record<StoryLanguage,Record<string,string>>>((result,locale) => {
        result[locale]=Object.fromEntries(Object.entries(sourceBlocks[locale]).map(([blockId,source]) => [
          blockId,
          state.redactedBlocks.includes(blockId) ? "" : applyStoryReviewToBlock(source,blockId,locale,state),
        ]));
        return result;
      },{en:{},zh:{}});
      completionBlockers=chapterReviewCompletionBlockers(state,{
        storyKey:chapterKey,
        privacyCandidates:presentation.privacy.candidates,
        privacyDecisions:currentPrivacyDecisions,
        targetCatalog,
        reviewableInsightIds:presentation.highlights.map((highlight) => highlight.id),
        sourceBlocks,
        reviewedBlocks,
      });
    } catch {
      completionBlockers=[invalidBlocker];
    }
    return {
      project:milestone.project || "",
      chapterKey,
      title:presentation?.title || milestone.story.title,
      stage:state.stage,
      completionBlockers,
    };
  }));
  const openDownloadReviewBlocker = (group:DownloadReviewBlockerGroup,blocker:DownloadReviewBlocker) => {
    setDownloadBlockerGroups([]);
    if(!activatedStoryHighlights.some((milestone) => milestone.project===group.project && milestone.story.key===group.chapterKey)) return;
    releasePreviewReturnSelectionRef.current=null;
    clearChapterRestore();
    setEvidenceNavigationError("");
    setEvidenceReturn(null);
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
  const downloadReviewed = async (url:string,filename:string) => {
    setError("");
    const blockerGroups=currentDownloadReviewBlockerGroups();
    if(blockerGroups.length) {
      setDownloadBlockerGroups(blockerGroups);
      return;
    }
    const persistence=storyPersistenceRef.current;
    if (!persistence || storyPersistenceReadyRunRef.current !== workflowRunId) {
      setError("Story review persistence is not ready for handoff");
      return;
    }
    let response:Response;
    try {
      response=await runDurableStoryReviewHandoff({
        persistence,
        currentSession: () => {
          const current=currentStoryStateRef.current;
          return createStoryReviewSession(workflowRunId,current.chapterReviews,current.privacyDecisions);
        },
        handoff: ({workflowRunId,serverVersion,sourceRevision}) => fetch(url,{
          method:"POST",
          headers:{"content-type":"application/json"},
          body:JSON.stringify({workflowRunId,serverVersion,sourceRevision}),
        }),
      });
    } catch (value) {
      setError(value instanceof Error ? value.message : "Story review state could not be safely persisted");
      return;
    }
    if(!response.ok) {
      const failure=await response.json().catch(()=>({error:"Download failed"})) as {error?:string};
      setError(failure.error || "Download failed");
      return;
    }
    const href=URL.createObjectURL(await response.blob());
    const anchor=document.createElement("a");
    anchor.href=href;anchor.download=filename;anchor.click();
    URL.revokeObjectURL(href);
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
  const activeChapterRestore=restoreChapterContext(chapterScrollRestore,activeMilestone?.story.key || "");
  const downloadBlockerCount=downloadBlockerGroups.reduce((count,group) => count+group.blockers.length,0);

  return <main className="shell storytellingShell">
    <header className="topbar">
      <div className="brand"><span className="brandMark">O₂</span> Oxygen</div>
      <span className="topTitle">{labels.title}</span>
      <span className="localState"><i /> {labels.local}</span>
      <button className="workflowButton" onClick={() => { void loadWorkflow(); setWorkflowOpen(true); }}>{labels.workflow}</button>
      <div className="languageToggle" aria-label="Story language">
        <button className={storyLanguage==="en"?"active":""} onClick={() => setLanguage("en")} aria-pressed={storyLanguage==="en"}>EN</button>
        {chineseStoryAvailable && <><span>|</span>
        <button className={storyLanguage==="zh"?"active":""} onClick={() => setLanguage("zh")} aria-pressed={storyLanguage==="zh"}>中文</button></>}
      </div>
      <button className="download" onClick={() => downloadReviewed("/api/organization/export","oxygen-reviewed-story.html")}>Download HTML</button>
      <button className="download primary" onClick={() => downloadReviewed("/api/package","oxygen-contribution.zip")}>Download ZIP</button>
    </header>
    <div className={`workspace storytellingWorkspace ${activeMilestone?"episodeOpen":""}`} style={workspaceStyle}>
      <aside className="rail storyRail">
        <div className="railHead"><b>{labels.projects}</b><span>{selectedProject?highlights.length:projectNames.length}</span></div>
        <div className="docList storyRailContents">{projectNames.map((project) => <button className={`docCard overview ${selectedProject===project?"active":""}`} key={project} onClick={() => { releasePreviewReturnSelectionRef.current=null; setStoryNavigation({ project, storyKey:"" }); setSourceFocus(""); setEvidenceReturn(null); setView("timeline"); }}>
          <span className="docTitle">{project}</span><span className="kind">STORY</span><small>{project===selectedProject?`${phaseGroups.length} ${labels.phases}`:`${projectCount(project).toLocaleString()} ${labels.events}`}</small>
        </button>)}{activeMilestone && <div className="chapterRailContext" aria-label={storyLanguage==="zh"?"章节选择器":"Chapter selector"}>
          <span>{storyLanguage==="zh"?`章节 ${activeStoryIndex+1} / ${highlights.length}`:`Chapters ${activeStoryIndex+1} / ${highlights.length}`}</span>
          <nav className="chapterRailList" aria-label={storyLanguage==="zh"?"章节":"Chapters"}>
            {highlights.map((event) => { const active=event.story.key===navigation.storyKey; return <button className={active?"active":""} aria-current={active?"page":undefined} ref={active?activeChapterButtonRef:undefined} key={event.story.key} onClick={() => navigateStory(event.story.key)}>
              <i>{milestoneNumber.get(event.story.key)}</i><b>{localized(event)?.title || event.story.title}</b>
            </button>})}
          </nav>
        </div>}<div className="sourceRecords"><div className="railHead evidence"><b>{labels.sources}</b><span>{docs.length}</span></div>{docs.map((doc) => <button className={`docCard ${selected===doc.id?"active":""}`} key={doc.id} onClick={() => { setSelected(doc.id); setSourceFocus(""); setActiveStoryKey(""); setEvidenceReturn(null); setView("redaction"); }}>
          <span className="docTitle">{doc.title}</span><span className="kind">{doc.kind}</span><small>{doc.item_count} events · {doc.source_system || "local"}</small>
        </button>)}</div></div>
      </aside>
      <div className="splitter" role="separator" aria-label="Resize project and source panel" aria-orientation="vertical" onPointerDown={startResize}><span /></div>
      <section className="canvas storyCanvas">
        {!ready ? <div className="empty">No organized records found.</div> : <>
          {error && <div className="workspaceError" role="alert">{error}</div>}
          <nav className="toolbar storyToolbar" aria-label="Record view" aria-hidden={activeMilestone?true:undefined} inert={activeMilestone?true:undefined}>
            <div className="toolbarInner"><button className={view==="timeline"?"active":""} onClick={() => { restoreReleasePreviewSelection(); setActiveStoryKey(""); setView("timeline"); }}>{labels.timeline}</button>
            <button className={view==="redaction"?"active":""} onClick={openReleasePreview}>
              {labels.release}{redactionJob?.status === "running" ? " · running"
                : redactionJob && redactionJob.status !== "complete" ? ` · ${redactionJob.status}`
                : redactions.length ? ` · ${redactions.length} redacted` : ""}
            </button>
            <button className={view==="probes"?"active":""} onClick={() => { restoreReleasePreviewSelection(); setView("probes"); }}>
              {labels.preferences}{probeRun?.status === "running" ? " · running" : probes.length ? ` · ${probes.filter((p) => p.answered_at).length}/${probes.length}` : ""}
            </button></div>
          </nav>
          {view!=="timeline" && <div className="canvasHead" aria-hidden={activeMilestone?true:undefined} inert={activeMilestone?true:undefined}><div className="canvasHeadInner">
            <span className="eyebrow">{view==="redaction"?labels.evidenceReview:labels.preferencesTitle}</span>
            <h1>{summary.primary_project || detail?.document.title}</h1>
          </div></div>}
          <div className={`stream ${view==="timeline" ? "storyStream" : view==="redaction" ? "reviewStream releasePreviewStream" : "reviewStream preferencesStream"}`} ref={timelineScrollRef} onScroll={updateActivePhase} aria-hidden={activeMilestone?true:undefined} inert={activeMilestone?true:undefined}>
            {view === "timeline" ? <>
              <div className="storyCanvasGrid"><div className="storyTimelineColumn">
                <header className="storyOrientation"><p className="eyebrow">{labels.projectStory}</p><h1>{summary.primary_project || detail?.document.title}</h1>
                  <p>{projectStorySummary}</p>
                  <div className="storyStats"><span><b>{highlights.length}</b> {labels.milestones}</span><span><b>{phaseGroups.length}</b> {labels.phases}</span><span><b>{reviewedInsights}/{highlights.length}</b> {labels.reviewed}</span><span><b>{docs.length}</b> {labels.retained}</span></div>
                  <small>{docs.length} {storyLanguage==="zh"?"条已审阅来源记录": "reviewed source records"} · {projectCount(selectedProject || primaryProject).toLocaleString()} {labels.events} · {storyLanguage==="zh"?"精确证据仅限本地":"exact evidence remains local"}</small>
                </header>
                <p className="storyNextStep" data-story-stream-instruction>↘ {labels.nextStep}</p>
                {phaseGroups.map((group,phaseIndex) => <section className="storyPhase" id={`story-phase-${phaseIndex}`} ref={(node) => phaseSectionRef(phaseIndex,node)} key={phaseGroupIdentity(group.name,phaseIndex)}>
                  <header className="phaseHeading"><span>{String(phaseIndex+1).padStart(2,"0")}</span><div><h2>{group.name}</h2><p>{group.events.length} {storyLanguage==="zh"?"个章节":`milestone${group.events.length===1?"":"s"}`}</p></div></header>
                  <div className="milestoneList">{group.events.map((event) => { const copy=localized(event); return <article className="milestone" data-kind={event.story.kind} data-story-key={event.story.key} key={event.story.key} aria-labelledby={`milestone-${event.id}`}>
                    <div className="milestoneMeta"><time dateTime={event.timestamp}>{fmtTimelineDate(event.timestamp,storyLanguage)}</time><span>{milestoneKindLabel(event.story.kind,storyLanguage)}</span><strong>{labels.selected}</strong></div>
                    <h3 id={`milestone-${event.id}`}>{copy?.title || event.story.title}</h3>
                    {(copy?.before || event.story.before) && (copy?.after || event.story.after) && <div className="transition" aria-label={`${labels.before} to ${labels.after}`}>
                      <div><small>{labels.before}</small><p>{copy?.before || event.story.before}</p></div><b aria-hidden="true">→</b><div><small>{labels.after}</small><p>{copy?.after || event.story.after}</p></div>
                    </div>}
                    {(copy?.timelineChips?.length || event.story.metric) && <div className="milestoneChips" aria-label={storyLanguage==="zh"?"关键事实":"Key facts"}>{(copy?.timelineChips?.length?copy.timelineChips:event.story.metric?.split(/\s*·\s*/).filter(Boolean) || []).map((chip) => <span key={chip}>{chip}</span>)}</div>}
                    <footer><span>{event.story.evidence ? `${1+event.story.evidence.supporting.length} ${labels.evidence}${storyLanguage==="en" && event.story.evidence.supporting.length ? "s" : ""}` : `Evidence · ${event.documentId} / ${event.id}`}</span>{event.story.releaseEpisode
                      ? <button id={`story-open-${event.story.key}`} onClick={() => openStory(event.story.key)}>{labels.read} · ≈ {event.story.releaseEpisode.readingTimeMinutes} {storyLanguage==="zh"?"分钟":"min"} →</button>
                      : <button onClick={() => { if(event.documentId) setSelected(event.documentId); setSourceFocus(event.id); setView("redaction"); }}>Open exact source event →</button>}</footer>
                  </article>})}</div>
                </section>)}
              </div><nav className="phaseDirectory" aria-label={storyLanguage==="zh"?"叙事阶段目录":"Narrative phase directory"}><b>{storyLanguage==="zh"?"故事阶段":"STORY PHASES"}</b>{phaseGroups.map((group,index) => <button className={activePhaseIndex===index?"active":""} aria-current={activePhaseIndex===index?"location":undefined} onClick={() => scrollToPhase(index)} key={phaseGroupIdentity(group.name,index)}>{group.name}</button>)}</nav></div>
            </> : view === "redaction" ? <>{evidenceReturn && <div className="evidenceReturnBar"><button onClick={backToChapter}>← {storyLanguage==="zh"?"返回章节":"Back to chapter"}</button><span>{storyLanguage==="zh"?"保持章节与证据来源位置":"Chapter and evidence origin preserved"}</span></div>}<RedactionCompare
              job={redactionJob}
              redactions={redactions}
              detail={detail}
              isProject={isProject}
              focusItemId={sourceFocus}
              busyId={redactionBusy}
              onUpdate={updateRedaction}
              onDelete={deleteRedaction}
            /></> : view === "probes" ? <ProbePanel
              language={storyLanguage}
              run={probeRun}
              probes={probes}
              bulkDecisions={bulkDecisions}
              busyId={probeBusy}
              onAnswer={answerProbe}
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
          {activeMilestone && <StoryChapterEditor
            key={`${activeMilestone.story.key}:${storyLanguage}`}
            milestone={activeMilestone}
            position={activeStoryIndex+1}
            total={highlights.length}
            language={storyLanguage}
            privacyDecisions={activePrivacyReview}
            chapterReview={chapterReviews[activeMilestone.story.key] || emptyChapterReview()}
            initialScrollTop={activeChapterRestore.scrollTop}
            focusOriginId={activeChapterRestore.focusOriginId}
            onContextRestored={clearChapterRestore}
            reviewFocus={downloadReviewFocus?.chapterKey===activeMilestone.story.key ? downloadReviewFocus : undefined}
            onReviewFocusHandled={clearDownloadReviewFocus}
            onPrivacyDecision={(candidateId,decision) => updatePrivacyDecision(activeMilestone.story.key,candidateId,decision)}
            onChapterReview={(review) => updateChapterReview(activeMilestone.story.key,review)}
            evidenceError={evidenceNavigationError}
            onOpenEvidence={openEvidence}
            onClose={closeStory}
            onPrevious={() => navigateStory(highlights[activeStoryIndex-1]?.story.key || activeMilestone.story.key)}
            onNext={() => navigateStory(highlights[activeStoryIndex+1]?.story.key || activeMilestone.story.key)}
          />}
        </>}
      </section>
    </div>
    {downloadBlockerGroups.length > 0 && <div className="workflowOverlay" onMouseDown={(event) => {
      if(event.target===event.currentTarget) setDownloadBlockerGroups([]);
    }}>
      <section className="organizationCard workflowCard" role="dialog" aria-modal="true" aria-labelledby="download-review-title">
        <button className="workflowClose" onClick={() => setDownloadBlockerGroups([])} aria-label={labels.close}>×</button>
        <div className="organizationBrand"><span className="brandMark">O₂</span> Oxygen</div>
        <div className="organizationKicker">{labels.downloadReviewKicker}</div>
        <h1 id="download-review-title">{labels.downloadReviewTitle}</h1>
        <p className="organizationIntro">{labels.downloadReviewIntro}</p>
        <p className="workflowStatus">{downloadBlockerCount} {labels.downloadReviewCount}</p>
        <div>{downloadBlockerGroups.map((group) => <section key={`${group.project}:${group.chapterKey}`}>
          <h2>{group.title}</h2>
          {group.blockers.map((blocker,index) => <button className="docCard" key={`${blocker.code}:${blocker.targetKind}:${blocker.targetId || ""}:${blocker.itemId || ""}:${index}`} onClick={() => openDownloadReviewBlocker(group,blocker)}>
            <span className="docTitle">{labels.downloadBlockers[blocker.code]}</span><span className="kind">{labels.openReview}</span><small>{labels.openReview} →</small>
          </button>)}
        </section>)}</div>
      </section>
    </div>}
    {workflowOpen && <WorkflowProgress workflow={displayedWorkflow} status={status} error={error} language={storyLanguage} onClose={() => setWorkflowOpen(false)} />}
  </main>;
}
