"use client";

import { useCallback, useEffect, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { OrganizationProgress } from "./organization-progress";
import { RedactionCompare, segments, type Redaction, type RedactionJob } from "./redaction-compare";
import { ProbePanel, type Probe, type BulkDecision, type ProbeRun } from "./probe-panel";
import { selectProjectTimeline } from "../lib/timeline";

type Status = { status:string; stage:string; completed:number; total:number; percent:number; documentCount:number; warnings:string[] };
type Doc = { id:string; kind:string; title:string; source_user?:string; source_system?:string; source_timestamp?:string; item_count:number; organization_status:string; formatted_summary?: Summary };
type Highlight = { id:string;sequence:number;timestamp?:string;project?:string;summary?:string;content?:string;documentId?:string };
type Summary = { primary_project?:string; project_summary?:string; projects?:Array<{name:string;event_count:number;primary:boolean}>; highlights?:Highlight[] };
type Item = { id:string; sequence:number; event_type?:string; actor_id?:string; actor_type?:string; timestamp?:string; content:string; organization_category?:string; organization_confidence?:number; organization_reason?:string };
type Detail = { document:Doc; items:Item[] };

const fmt = (value?: string) => value ? new Date(value).toLocaleString(undefined, { dateStyle:"medium", timeStyle:"short" }) : "Time unavailable";

export function InlineWorkspace() {
  const [status,setStatus] = useState<Status|null>(null);
  const [docs,setDocs] = useState<Doc[]>([]);
  const [selected,setSelected] = useState("");
  const [detail,setDetail] = useState<Detail|null>(null);
  const [view,setView] = useState<"timeline"|"redaction"|"probes">("timeline");
  const [railWidth,setRailWidth] = useState(330);
  const [railHeight,setRailHeight] = useState(280);
  const [error,setError] = useState("");
  const [redactions,setRedactions] = useState<Redaction[]>([]);
  const [redactionJob,setRedactionJob] = useState<RedactionJob>(null);
  const [redactionBusy,setRedactionBusy] = useState("");

  const loadRedactions = useCallback(async () => {
    const response = await fetch("/api/redactions", { cache:"no-store" });
    if (!response.ok) return;
    const payload = await response.json() as { redactions: Redaction[]; job: RedactionJob };
    setRedactions(payload.redactions || []);
    setRedactionJob(payload.job);
  }, []);

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
        let current = await fetch("/api/organization", { cache:"no-store" }).then((r) => r.json()) as Status;
        while (!cancelled && current.status !== "complete" && current.status !== "empty") {
          current = await fetch("/api/organization", { method:"POST" }).then((r) => r.json()) as Status;
          setStatus(current);
        }
        if (!cancelled) { setStatus(current); await loadDocs(); }
      } catch (value) { if (!cancelled) setError(value instanceof Error ? value.message : "Organization failed"); }
    }
    organize(); return () => { cancelled = true; };
  }, [loadDocs]);

  useEffect(() => {
    if (!selected || selected.startsWith("project:")) return;
    let cancelled = false;
    fetch(`/api/documents/${encodeURIComponent(selected)}`, { cache:"no-store" }).then((r) => r.json()).then((value) => { if (!cancelled) setDetail(value); });
    return () => { cancelled = true; };
  }, [selected]);

  if (!status || (status.status !== "complete" && status.status !== "empty")) return <OrganizationProgress status={status} error={error} />;
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
    highlights: selectProjectTimeline(allHighlights.filter((event) => event.project === selectedProject)),
  } : detail?.document.formatted_summary || {};
  const highlights = summary.highlights || [];
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

  return <main className="shell">
    <header className="topbar">
      <div className="brand"><span className="brandMark">O₂</span> Oxygen</div>
      <span className="topTitle">Local project history review</span>
      <span className="localState"><i /> Local only · nothing uploaded</span>
      <a className="download" href="/api/organization/export">Download HTML</a>
      <a className="download primary" href="/api/package">Download ZIP</a>
    </header>
    <div className="workspace" style={workspaceStyle}>
      <aside className="rail">
        <div className="railHead"><b>Project timelines</b><span>{projectNames.length} total</span></div>
        <div className="docList">{projectNames.map((project) => <button className={`docCard overview ${selected===`project:${project}`?"active":""}`} key={project} onClick={() => { setSelected(`project:${project}`); setView("timeline"); }}>
          <span className="docTitle">{project}</span><span className="kind">PROJECT</span><small>{projectCount(project).toLocaleString()} events · combined timeline</small>
        </button>)}<div className="railHead evidence"><b>Source records</b><span>{docs.length}</span></div>{docs.map((doc) => <button className={`docCard ${selected===doc.id?"active":""}`} key={doc.id} onClick={() => { setSelected(doc.id); setView("redaction"); }}>
          <span className="docTitle">{doc.title}</span><span className="kind">{doc.kind}</span><small>{doc.item_count} events · {doc.source_system || "local"}</small>
        </button>)}</div>
      </aside>
      <div className="splitter" role="separator" aria-label="Resize project and source panel" aria-orientation="vertical" onPointerDown={startResize}><span /></div>
      <section className="canvas">
        {!ready ? <div className="empty">No organized records found.</div> : <>
          <div className="canvasHead">
            <h1>{summary.primary_project || detail?.document.title}</h1>
          </div>
          <nav className="toolbar" aria-label="Record view">
            <button className={view==="timeline"?"active":""} onClick={() => setView("timeline")}>Timeline</button>
            <button className={view==="redaction"?"active":""} onClick={() => setView("redaction")}>
              Release preview{redactionJob?.status === "running" ? " · running"
                : redactionJob && redactionJob.status !== "complete" ? ` · ${redactionJob.status}`
                : redactions.length ? ` · ${redactions.length} redacted` : ""}
            </button>
            <button className={view==="probes"?"active":""} onClick={() => setView("probes")}>
              Preferences{probeRun?.status === "running" ? " · running" : probes.length ? ` · ${probes.filter((p) => p.answered_at).length}/${probes.length}` : ""}
            </button>
          </nav>
          <div className="stream">
            {view === "timeline" ? <>
              <div className="projectStrip">{(summary.projects || []).map((project) => <div className={`projectCard ${project.primary?"primary":""}`} key={project.name}><small>{project.primary?"MAIN PROJECT":"RELATED PROJECT"}</small><b>{project.name}</b><span>{project.event_count} events</span></div>)}</div>
              <div className="timeline">{highlights.map((event,index) => <article className="timelineEvent" key={event.id}>
                <div className="timelineMarker">{index+1}</div><div className="timelineBody"><time>{fmt(event.timestamp)}</time><span className="projectTag">{event.project}</span><h2>{event.summary || "Project event"}</h2><p>{event.content}</p><button onClick={() => { if(event.documentId) setSelected(event.documentId); setView("redaction"); }}>Open source event →</button></div>
              </article>)}</div>
            </> : view === "redaction" ? <RedactionCompare
              job={redactionJob}
              redactions={redactions}
              detail={detail}
              isProject={isProject}
              busyId={redactionBusy}
              onUpdate={updateRedaction}
              onDelete={deleteRedaction}
            /> : view === "probes" ? <ProbePanel
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
        </>}
      </section>
    </div>
  </main>;
}
