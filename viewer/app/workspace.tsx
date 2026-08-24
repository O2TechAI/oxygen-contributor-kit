"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { WorkflowProgress } from "./organization-progress";
import { RedactionCompare, segments, type Redaction, type RedactionJob } from "./redaction-compare";
import { ProbePanel, type Probe, type BulkDecision, type ProbeRun } from "./probe-panel";
import {
  StoryChapterEditor,
  type ChapterEvidenceContext,
  type ChapterReviewState,
  type PrivacyDecision,
} from "./story-chapter-editor";
import { emptyChapterReview, privacyDecisionKey } from "../lib/story-review";
import { milestoneKindLabel, selectProjectTimeline, type EvidenceReference, type StoryLanguage } from "../lib/timeline";
import { buildReviewedStoryRelease } from "../lib/story-release";
import { phaseGroupIdentity, restoreChapterContext, type ChapterRestoreContext } from "../lib/story-navigation";
import { withHumanReviewProgress, type WorkflowProgressState } from "../lib/workflow-progress";

type Status = { status:string; stage:string; completed:number; total:number; percent:number; documentCount:number; warnings:string[] };
type Doc = { id:string; kind:string; title:string; source_user?:string; source_system?:string; source_timestamp?:string; item_count:number; organization_status:string; formatted_summary?: Summary };
type Highlight = { id:string;sequence:number;timestamp?:string;project?:string;summary?:string;content?:string;documentId?:string };
type Summary = { primary_project?:string; project_summary?:string; projects?:Array<{name:string;event_count:number;primary:boolean}>; highlights?:Highlight[] };
type Item = { id:string; sequence:number; event_type?:string; actor_id?:string; actor_type?:string; timestamp?:string; content:string; organization_category?:string; organization_confidence?:number; organization_reason?:string };
type Detail = { document:Doc; items:Item[] };

const workspaceUi = {
  en: {
    title:"Storytelling Review", local:"Local only · nothing uploaded", projects:"Project Story", total:"total",
    sources:"Source records", projectStory:"Project story", evidenceReview:"Evidence review", preferencesTitle:"Contributor preferences",
    milestones:"meaningful milestones", phases:"narrative phases", reviewed:"highlights reviewed", retained:"source records retained",
    timeline:"Project Story", release:"Release preview", preferences:"Preferences", mainProject:"MAIN PROJECT", events:"events",
    introTitle:"AI-selected highlights are the table of contents.", intro:"Open a chapter for People, Story, and Privacy. AI insights stay inside the narrative; local evidence stays secondary.",
    before:"BEFORE", after:"AFTER", selected:"AI-selected highlight", evidence:"reviewed evidence event", read:"Read chapter", workflow:"Workflow",
    nextStep:"Read a Chapter to review the full story, evidence, and lessons.",
  },
  zh: {
    title:"故事审阅", local:"仅限本地 · 未上传", projects:"项目故事", total:"个项目",
    sources:"来源记录", projectStory:"项目故事", evidenceReview:"证据审阅", preferencesTitle:"贡献者偏好",
    milestones:"个重要章节", phases:"个叙事阶段", reviewed:"个高光已审阅", retained:"条来源记录保留",
    timeline:"项目故事", release:"发布预览", preferences:"偏好", mainProject:"主要项目", events:"条事件",
    introTitle:"AI 选择的高光就是故事目录。", intro:"打开一章，按人物、故事和隐私阅读；AI 洞察留在叙事中，本地证据保持为次要入口。",
    before:"之前", after:"之后", selected:"AI 选择的高光", evidence:"条已审阅证据", read:"阅读章节", workflow:"工作流",
    nextStep:"阅读任一章节，完整审阅故事、证据与可复用经验。",
  },
} as const;

const fmt = (value: string | undefined, language: StoryLanguage = "en") => value
  ? new Date(value).toLocaleString(language === "zh" ? "zh-CN" : "en-US", { dateStyle:"medium", timeStyle:"short" })
  : language === "zh" ? "时间不可用" : "Time unavailable";

const fmtTimelineDate = (value: string | undefined, language: StoryLanguage = "en") => value
  ? new Date(value).toLocaleDateString(language === "zh" ? "zh-CN" : "en-US", { dateStyle:"medium" })
  : language === "zh" ? "日期不可用" : "Date unavailable";

export function InlineWorkspace() {
  const [status,setStatus] = useState<Status|null>(null);
  const [workflow,setWorkflow] = useState<WorkflowProgressState|null>(null);
  const [workflowOpen,setWorkflowOpen] = useState(false);
  const [docs,setDocs] = useState<Doc[]>([]);
  const [selected,setSelected] = useState("");
  const [detail,setDetail] = useState<Detail|null>(null);
  const [view,setView] = useState<"timeline"|"redaction"|"probes">("timeline");
  const [sourceFocus,setSourceFocus] = useState("");
  const [activeStoryKey,setActiveStoryKey] = useState("");
  const [language,setLanguage] = useState<StoryLanguage>("en");
  const [privacyDecisions,setPrivacyDecisions] = useState<Record<string,PrivacyDecision>>({});
  const [chapterReviews,setChapterReviews] = useState<Record<string,ChapterReviewState>>({});
  const [evidenceReturn,setEvidenceReturn] = useState<(ChapterEvidenceContext & { projectName:string })|null>(null);
  const [chapterScrollRestore,setChapterScrollRestore] = useState<ChapterRestoreContext|null>(null);
  const [evidenceNavigationError,setEvidenceNavigationError] = useState("");
  const timelineScrollRef = useRef<HTMLDivElement|null>(null);
  const phaseSectionRefs = useRef(new Map<number,HTMLElement>());
  const timelineContextRef = useRef({ key:"", scrollTop:0 });
  const releasePreviewReturnSelectionRef = useRef<string|null>(null);
  const activeChapterButtonRef = useCallback((node:HTMLButtonElement|null) => {
    if (!node) return;
    requestAnimationFrame(() => node.scrollIntoView({ block:"nearest" }));
  }, []);
  const clearChapterRestore = useCallback(() => {
    setChapterScrollRestore(null);
  }, []);
  const [railWidth,setRailWidth] = useState(330);
  const [railHeight,setRailHeight] = useState(280);
  const [activePhaseIndex,setActivePhaseIndex] = useState(0);
  const [error,setError] = useState("");
  const [redactions,setRedactions] = useState<Redaction[]>([]);
  const [redactionJob,setRedactionJob] = useState<RedactionJob>(null);
  const [redactionBusy,setRedactionBusy] = useState("");

  const loadWorkflow = useCallback(async () => {
    const response = await fetch("/api/workflow", { cache:"no-store" });
    if (!response.ok) return;
    setWorkflow(await response.json() as WorkflowProgressState);
  }, []);

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
    loadRedactions();
    if (redactionJob && redactionJob.status === "running") {
      const timer = setInterval(loadRedactions, 4000);
      return () => clearInterval(timer);
    }
  }, [loadRedactions, redactionJob?.status]);

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

  const loadProbes = useCallback(async () => {
    const response = await fetch("/api/probes", { cache:"no-store" });
    if (!response.ok) return;
    const payload = await response.json() as { probes: Probe[]; bulkDecisions: BulkDecision[]; run: ProbeRun };
    setProbes(payload.probes || []);
    setBulkDecisions(payload.bulkDecisions || []);
    setProbeRun(payload.run);
  }, []);

  useEffect(() => {
    loadProbes();
    if (probeRun && probeRun.status === "running") {
      const timer = setInterval(loadProbes, 4000);
      return () => clearInterval(timer);
    }
  }, [loadProbes, probeRun?.status]);

  async function answerProbe(id: string, patch: { choice?: string; text?: string; clear?: boolean; bulk?: boolean }) {
    setProbeBusy(id);
    await fetch(`/api/probes/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    await loadProbes();
    setProbeBusy("");
  }

  const loadDocs = useCallback(async () => {
    const response = await fetch("/api/documents", { cache:"no-store" });
    if (!response.ok) throw new Error("Could not load local records");
    const payload = await response.json() as { documents: Doc[] };
    const next = payload.documents;
    setDocs(next);
    const primary = next[0]?.formatted_summary?.primary_project || "Oxygen";
    setSelected((current) => current.startsWith("project:") || next.some((d) => d.id === current) ? (current || `project:${primary}`) : `project:${primary}`);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function organize() {
      try {
        await loadWorkflow();
        let current = await fetch("/api/organization", { cache:"no-store" }).then((r) => r.json()) as Status;
        let passes = 0;
        while (!cancelled && current.status !== "complete" && current.status !== "empty") {
          current = await fetch("/api/organization", { method:"POST" }).then((r) => r.json()) as Status;
          setStatus(current);
          passes += 1;
          if (passes % 4 === 0) await loadWorkflow();
        }
        if (!cancelled) { setStatus(current); await loadDocs(); await loadWorkflow(); }
      } catch (value) { if (!cancelled) setError(value instanceof Error ? value.message : "Organization failed"); }
    }
    organize(); return () => { cancelled = true; };
  }, [loadDocs, loadWorkflow]);

  useEffect(() => {
    if (!selected || selected.startsWith("project:")) return;
    let cancelled = false;
    fetch(`/api/documents/${encodeURIComponent(selected)}`, { cache:"no-store" }).then((r) => r.json()).then((value) => { if (!cancelled) setDetail(value); });
    return () => { cancelled = true; };
  }, [selected]);

  if (!status || (status.status !== "complete" && status.status !== "empty")) return <WorkflowProgress workflow={workflow} status={status} error={error} language={language} />;
  const isProject = selected.startsWith("project:");
  const selectedProject = isProject ? selected.slice("project:".length) : "";
  const allHighlights = docs.flatMap((doc) => (doc.formatted_summary?.highlights || []).map((event) => ({ ...event, documentId:doc.id })))
    .sort((a,b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")));
  const projectNames = Array.from(new Set(docs.flatMap((doc) => (doc.formatted_summary?.projects || []).map((project) => project.name))));
  const primaryProject = docs[0]?.formatted_summary?.primary_project || projectNames[0] || "Oxygen";
  const projectCount = (name:string) => docs.reduce((sum,doc) => sum + Number((doc.formatted_summary?.projects || []).find((project) => project.name === name)?.event_count || 0), 0);
  const summary:Summary = isProject ? {
    primary_project: selectedProject,
    project_summary: selectedProject === primaryProject ? (docs[0]?.formatted_summary?.project_summary || "A chronological view across every collected local trajectory.") : `A combined timeline for ${selectedProject} across every source trajectory.`,
    projects: [{ name:selectedProject, event_count:projectCount(selectedProject), primary:selectedProject === primaryProject }],
    highlights: allHighlights.filter((event) => event.project === selectedProject),
  } : detail?.document.formatted_summary || {};
  const highlights = selectProjectTimeline(summary.highlights || []);
  const labels = workspaceUi[language];
  const localized = (event:typeof highlights[number]) => event.story.reviewPresentation?.[language];
  const projectStorySummary = highlights[0]?.story.reviewPresentation?.projectSummary?.[language]
    || (language === "zh"
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
  const activeStoryIndex = highlights.findIndex((event) => event.story.key === activeStoryKey);
  const activeMilestone = activeStoryIndex >= 0 ? highlights[activeStoryIndex] : null;
  const reviewedInsights = highlights.filter((event) => Object.keys(chapterReviews[event.story.key]?.insightReviews || {}).length > 0).length;
  const confirmedChapters = highlights.filter((event) => chapterReviews[event.story.key]?.stage === "human_confirmed").length;
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
  const activePrivacyReview = activeMilestone?.story.reviewPresentation?.[language].privacy.candidates.reduce<Record<string,PrivacyDecision>>((current,candidate) => {
    const decision=privacyDecisions[privacyDecisionKey(activeMilestone.story.key,candidate.id)];
    if(decision) current[candidate.id]=decision;
    return current;
  },{}) || {};
  const openStory = (storyKey:string) => {
    timelineContextRef.current={key:storyKey,scrollTop:timelineScrollRef.current?.scrollTop || 0};
    clearChapterRestore();
    setEvidenceNavigationError("");
    setEvidenceReturn(null);
    setActiveStoryKey(storyKey);
  };
  const navigateStory = (storyKey:string) => {
    clearChapterRestore();
    setEvidenceNavigationError("");
    setActiveStoryKey(storyKey);
  };
  const openReleasePreview = () => {
    setSourceFocus("");
    setActiveStoryKey("");
    setEvidenceReturn(null);
    if (isProject && redactionJob?.status === "complete" && docs[0]) {
      releasePreviewReturnSelectionRef.current=selected;
      setDetail(null);
      setSelected(docs[0].id);
    }
    setView("redaction");
  };
  const restoreReleasePreviewSelection = () => {
    if(!releasePreviewReturnSelectionRef.current) return;
    setSelected(releasePreviewReturnSelectionRef.current);
    setDetail(null);
    releasePreviewReturnSelectionRef.current=null;
  };
  const closeStory = () => {
    const context=timelineContextRef.current;
    setActiveStoryKey("");
    requestAnimationFrame(() => {
      if(timelineScrollRef.current) timelineScrollRef.current.scrollTop=context.scrollTop;
      document.getElementById(`story-open-${context.key}`)?.focus({preventScroll:true});
    });
  };
  const openEvidence = (evidence:EvidenceReference,context:ChapterEvidenceContext) => {
    if(!docs.some((document) => document.id===evidence.documentId)) {
      setEvidenceNavigationError(language==="zh"?"精确证据无法打开：引用的来源记录不存在。":"Exact evidence cannot open because the referenced source record is missing.");
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
    setSelected(`project:${evidenceReturn.projectName}`);
    setView("timeline");
    setChapterScrollRestore({storyKey:evidenceReturn.storyKey,scrollTop:evidenceReturn.scrollTop,focusOriginId:evidenceReturn.originId});
    setActiveStoryKey(evidenceReturn.storyKey);
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
  const downloadReviewed = async (url:string,filename:string) => {
    setError("");
    const reviewedStory=buildReviewedStoryRelease(highlights,chapterReviews);
    const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({reviewedStory})});
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

  return <main className="shell storytellingShell">
    <header className="topbar">
      <div className="brand"><span className="brandMark">O₂</span> Oxygen</div>
      <span className="topTitle">{labels.title}</span>
      <span className="localState"><i /> {labels.local}</span>
      <button className="workflowButton" onClick={() => { void loadWorkflow(); setWorkflowOpen(true); }}>{labels.workflow}</button>
      <div className="languageToggle" aria-label="Story language">
        <button className={language==="en"?"active":""} onClick={() => setLanguage("en")} aria-pressed={language==="en"}>EN</button>
        <span>|</span>
        <button className={language==="zh"?"active":""} onClick={() => setLanguage("zh")} aria-pressed={language==="zh"}>中文</button>
      </div>
      <button className="download" onClick={() => downloadReviewed("/api/organization/export","oxygen-reviewed-story.html")}>Download HTML</button>
      <button className="download primary" onClick={() => downloadReviewed("/api/package","oxygen-contribution.zip")}>Download ZIP</button>
    </header>
    <div className={`workspace storytellingWorkspace ${activeMilestone?"episodeOpen":""}`} style={workspaceStyle}>
      <aside className="rail storyRail">
        <div className="railHead"><b>{labels.projects}</b><span>{selectedProject?highlights.length:projectNames.length}</span></div>
        <div className="docList storyRailContents">{projectNames.map((project) => <button className={`docCard overview ${selected===`project:${project}`?"active":""}`} key={project} onClick={() => { releasePreviewReturnSelectionRef.current=null; setSelected(`project:${project}`); setSourceFocus(""); setActiveStoryKey(""); setEvidenceReturn(null); setView("timeline"); }}>
          <span className="docTitle">{project}</span><span className="kind">STORY</span><small>{project===selectedProject?`${phaseGroups.length} ${labels.phases}`:`${projectCount(project).toLocaleString()} ${labels.events}`}</small>
        </button>)}{activeMilestone && <div className="chapterRailContext" aria-label={language==="zh"?"章节选择器":"Chapter selector"}>
          <span>{language==="zh"?`章节 ${activeStoryIndex+1} / ${highlights.length}`:`Chapters ${activeStoryIndex+1} / ${highlights.length}`}</span>
          <nav className="chapterRailList" aria-label={language==="zh"?"章节":"Chapters"}>
            {highlights.map((event) => { const active=event.story.key===activeStoryKey; return <button className={active?"active":""} aria-current={active?"page":undefined} ref={active?activeChapterButtonRef:undefined} key={event.story.key} onClick={() => navigateStory(event.story.key)}>
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
                  <small>{docs.length} {language==="zh"?"条已审阅来源记录": "reviewed source records"} · {projectCount(selectedProject || primaryProject).toLocaleString()} {labels.events} · {language==="zh"?"精确证据仅限本地":"exact evidence remains local"}</small>
                  <p className="storyNextStep">{labels.nextStep}</p>
                </header>
                {phaseGroups.map((group,phaseIndex) => <section className="storyPhase" id={`story-phase-${phaseIndex}`} ref={(node) => phaseSectionRef(phaseIndex,node)} key={phaseGroupIdentity(group.name,phaseIndex)}>
                  <header className="phaseHeading"><span>{String(phaseIndex+1).padStart(2,"0")}</span><div><h2>{group.name}</h2><p>{group.events.length} {language==="zh"?"个章节":`milestone${group.events.length===1?"":"s"}`}</p></div></header>
                  <div className="milestoneList">{group.events.map((event) => { const copy=localized(event); return <article className="milestone" data-kind={event.story.kind} data-story-key={event.story.key} key={event.story.key} aria-labelledby={`milestone-${event.id}`}>
                    <div className="milestoneMeta"><time dateTime={event.timestamp}>{fmtTimelineDate(event.timestamp,language)}</time><span>{milestoneKindLabel(event.story.kind,language)}</span><strong>{labels.selected}</strong></div>
                    <h3 id={`milestone-${event.id}`}>{copy?.title || event.story.title}</h3>
                    {(copy?.before || event.story.before) && (copy?.after || event.story.after) && <div className="transition" aria-label={`${labels.before} to ${labels.after}`}>
                      <div><small>{labels.before}</small><p>{copy?.before || event.story.before}</p></div><b aria-hidden="true">→</b><div><small>{labels.after}</small><p>{copy?.after || event.story.after}</p></div>
                    </div>}
                    {(copy?.timelineChips?.length || event.story.metric) && <div className="milestoneChips" aria-label={language==="zh"?"关键事实":"Key facts"}>{(copy?.timelineChips?.length?copy.timelineChips:event.story.metric?.split(/\s*·\s*/).filter(Boolean) || []).map((chip) => <span key={chip}>{chip}</span>)}</div>}
                    <footer><span>{event.story.evidence ? `${1+event.story.evidence.supporting.length} ${labels.evidence}${language==="en" && event.story.evidence.supporting.length ? "s" : ""}` : `Evidence · ${event.documentId} / ${event.id}`}</span>{event.story.releaseEpisode
                      ? <button id={`story-open-${event.story.key}`} onClick={() => openStory(event.story.key)}>{labels.read} · ≈ {event.story.releaseEpisode.readingTimeMinutes} {language==="zh"?"分钟":"min"} →</button>
                      : <button onClick={() => { if(event.documentId) setSelected(event.documentId); setSourceFocus(event.id); setView("redaction"); }}>Open exact source event →</button>}</footer>
                  </article>})}</div>
                </section>)}
              </div><nav className="phaseDirectory" aria-label={language==="zh"?"叙事阶段目录":"Narrative phase directory"}><b>{language==="zh"?"故事阶段":"STORY PHASES"}</b>{phaseGroups.map((group,index) => <button className={activePhaseIndex===index?"active":""} aria-current={activePhaseIndex===index?"location":undefined} onClick={() => scrollToPhase(index)} key={phaseGroupIdentity(group.name,index)}>{group.name}</button>)}</nav></div>
            </> : view === "redaction" ? <>{evidenceReturn && <div className="evidenceReturnBar"><button onClick={backToChapter}>← {language==="zh"?"返回章节":"Back to chapter"}</button><span>{language==="zh"?"保持章节与证据来源位置":"Chapter and evidence origin preserved"}</span></div>}<RedactionCompare
              job={redactionJob}
              redactions={redactions}
              detail={detail}
              isProject={isProject}
              focusItemId={sourceFocus}
              busyId={redactionBusy}
              onUpdate={updateRedaction}
              onDelete={deleteRedaction}
            /></> : view === "probes" ? <ProbePanel
              language={language}
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
            key={`${activeMilestone.story.key}:${language}`}
            milestone={activeMilestone}
            position={activeStoryIndex+1}
            total={highlights.length}
            language={language}
            privacyDecisions={activePrivacyReview}
            chapterReview={chapterReviews[activeMilestone.story.key] || emptyChapterReview()}
            initialScrollTop={activeChapterRestore.scrollTop}
            focusOriginId={activeChapterRestore.focusOriginId}
            onContextRestored={clearChapterRestore}
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
    {workflowOpen && <WorkflowProgress workflow={displayedWorkflow} status={status} error={error} language={language} onClose={() => setWorkflowOpen(false)} />}
  </main>;
}
