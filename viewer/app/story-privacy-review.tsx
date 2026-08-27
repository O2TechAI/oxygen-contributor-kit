"use client";

import { useEffect, useRef } from "react";
import {
  storyPrivacyCandidateResolved,
  type StoryPrivacyCandidate,
  type StoryPrivacyDecision,
  type StoryPrivacyState,
} from "./story-privacy-ui";

export type { StoryPrivacyCandidate, StoryPrivacyDecision, StoryPrivacyState } from "./story-privacy-ui";

function candidateStatus(candidate: StoryPrivacyCandidate) {
  if (candidate.reviewState === "deterministic") return "Automatically redacted";
  if (candidate.decision === "keep") return "Kept by contributor";
  if (candidate.decision === "redact") return "Redacted by contributor";
  return "Needs confirmation";
}

export function StoryPrivacyReview({
  state,
  busyId,
  onDecision,
}: {
  state: StoryPrivacyState;
  busyId: string;
  onDecision: (candidate: StoryPrivacyCandidate, decision: StoryPrivacyDecision) => void;
}) {
  const activeRef = useRef<HTMLElement | null>(null);
  const authority = state.authority;
  const active = authority?.candidates.find((candidate) => !storyPrivacyCandidateResolved(candidate)) || null;
  const resolved = authority?.candidates.filter(storyPrivacyCandidateResolved).length || 0;
  const total = authority?.candidates.length || 0;

  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => activeRef.current?.focus({ preventScroll: false }));
    return () => cancelAnimationFrame(frame);
  }, [active]);

  if (state.status !== "ready" || !authority) {
    return <section className="storyPrivacyReview" aria-labelledby="release-preview-title">
      <p className="eyebrow">Story Privacy</p>
      <h2 id="release-preview-title">Release Preview</h2>
      <p className="storyPrivacyStatus" role="status" aria-live="polite">
        {state.status === "loading" ? "Loading the current release authority…" : state.message}
      </p>
      <p className="storyPrivacyBoundary">Release actions stay blocked until the exact current authority is available.</p>
    </section>;
  }

  return <section className="storyPrivacyReview" aria-labelledby="release-preview-title">
    <header className="storyPrivacyHeader">
      <div><p className="eyebrow">Story Privacy</p><h2 id="release-preview-title">Release Preview</h2></div>
      <p className="storyPrivacyProgress" role="status" aria-live="polite">{resolved} / {total} resolved</p>
    </header>
    {state.message && <p className="storyPrivacyNotice" role="status" aria-live="polite">{state.message}</p>}
    {authority.status === "completed_empty" ? <div className="storyPrivacyEmpty">
      <b>0 / 0 complete</b>
      <p>The current Story has no release Privacy candidates. This completed-empty result is authoritative.</p>
    </div> : <>
      {active ? <article className="storyPrivacyDecision" ref={activeRef} tabIndex={-1} aria-labelledby={`story-privacy-${active.id}`}>
        <p className="storyPrivacyCounter">Candidate {resolved + 1} of {total}</p>
        <h3 id={`story-privacy-${active.id}`}>{active.title}</h3>
        <div className="storyPrivacyOriginalUnavailable"><b>Local original unavailable</b><span>This authority contains no original excerpt. Oxygen will not fetch or reconstruct one.</span></div>
        <dl className="storyPrivacyReasons">
          <div><dt>Why flagged</dt><dd>{active.whyFlagged}</dd></div>
          <div><dt>Uncertainty</dt><dd>{active.uncertaintyReason}</dd></div>
        </dl>
        <div className="storyPrivacyActions" aria-label={`Decision for ${active.title}`}>
          <button disabled={busyId === active.id} onClick={() => onDecision(active, "keep")}>Keep</button>
          <button className="primary" disabled={busyId === active.id} onClick={() => onDecision(active, "redact")}>Redact</button>
        </div>
      </article> : <div className="storyPrivacyEmpty"><b>Release Privacy complete</b><p>Every required contributor decision is durably recorded.</p></div>}
      <div className="storyPrivacyResolved" aria-label="Resolved Story Privacy candidates">
        {authority.candidates.filter(storyPrivacyCandidateResolved).map((candidate) => <div key={candidate.id}>
          <b>{candidate.title}</b><span>{candidateStatus(candidate)}</span>
        </div>)}
      </div>
    </>}
  </section>;
}
