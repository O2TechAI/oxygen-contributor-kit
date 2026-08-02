"use client";

import { useCallback, useEffect, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { OrganizationProgress } from "./organization-progress";
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
  const [view,setView] = useState<"timeline"|"source">("timeline");
  const [railWidth,setRailWidth] = useState(330);
  const [railHeight,setRailHeight] = useState(280);
  const [error,setError] = useState("");

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
        </button>)}<div className="railHead evidence"><b>Source records</b><span>{docs.length}</span></div>{docs.map((doc) => <button className={`docCard ${selected===doc.id?"active":""}`} key={doc.id} onClick={() => { setSelected(doc.id); setView("source"); }}>
          <span className="docTitle">{doc.title}</span><span className="kind">{doc.kind}</span><small>{doc.item_count} events · {doc.source_system || "local"}</small>
        </button>)}</div>
      </aside>
      <div className="splitter" role="separator" aria-label="Resize project and source panel" aria-orientation="vertical" onPointerDown={startResize}><span /></div>
      <section className="canvas">
        {!ready ? <div className="empty">No organized records found.</div> : <>
          <div className="canvasHead">
            <div className="eyebrow">{isProject ? `${selectedProject === primaryProject ? "Primary project" : "Project"} · combined timeline` : `Source record · ${detail?.document.kind}`}</div>
            <h1>{summary.primary_project || detail?.document.title}</h1>
            <p>{summary.project_summary || "A local timeline assembled from the collected record."}</p>
            <div className="headMeta">{isProject ? <><span>{docs.length} source trajectories</span><span>{projectCount(selectedProject).toLocaleString()} project events</span><span>{highlights.length} timeline events</span></> : <>{detail?.document.source_user && <span>Author: {detail.document.source_user}</span>}<span>Source: {detail?.document.source_system || "unknown"}</span><span>{detail?.document.item_count} events</span><span>Started {fmt(detail?.document.source_timestamp)}</span></>}</div>
          </div>
          <nav className="toolbar" aria-label="Record view">
            <button className={view==="timeline"?"active":""} onClick={() => setView("timeline")}>Timeline</button>
            <button disabled={isProject} className={view==="source"?"active":""} onClick={() => setView("source")}>{isProject ? "Open an event for source" : "Source events"}</button>
          </nav>
          <div className="stream">
            {view === "timeline" ? <>
              <div className="projectStrip">{(summary.projects || []).map((project) => <div className={`projectCard ${project.primary?"primary":""}`} key={project.name}><small>{project.primary?"MAIN PROJECT":"RELATED PROJECT"}</small><b>{project.name}</b><span>{project.event_count} events</span></div>)}</div>
              <div className="timeline">{highlights.map((event,index) => <article className="timelineEvent" key={event.id}>
                <div className="timelineMarker">{index+1}</div><div className="timelineBody"><time>{fmt(event.timestamp)}</time><span className="projectTag">{event.project}</span><h2>{event.summary || "Project event"}</h2><p>{event.content}</p><button onClick={() => { if(event.documentId) setSelected(event.documentId); setView("source"); }}>Open source event →</button></div>
              </article>)}</div>
            </> : <div className="sourceList">{(detail?.items || []).map((item) => <article className="sourceEvent" key={item.id}><div><b>#{item.sequence}</b><span>{fmt(item.timestamp)}</span><span>{item.event_type || "record"}</span><span>{item.organization_category}</span></div><pre>{item.content}</pre></article>)}</div>}
          </div>
        </>}
      </section>
    </div>
  </main>;
}
