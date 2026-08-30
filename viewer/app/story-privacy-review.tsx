"use client";

import { useEffect, useRef, useState } from "react";
import {
  storyPrivacyCandidateResolved,
  type StoryPrivacyCandidate,
  type StoryPrivacyState,
  type StoryPrivacyTarget,
  type StoryPrivacyTargetChoice,
} from "./story-privacy-ui";

export type { StoryPrivacyCandidate, StoryPrivacyState } from "./story-privacy-ui";

function candidateStatus(candidate: StoryPrivacyCandidate) {
  if (!candidate.resolved) return "Needs confirmation";
  return candidate.reviewState === "deterministic"
    ? "Automatically anonymized" : "Contributor choice recorded";
}

function occurrenceKey(targetId: string, start: number, end: number, category: string) {
  return `${targetId}\u0000${start}:${end}:${category}`;
}

function targetHydrationKey(target: StoryPrivacyTarget) {
  return `${target.targetId}\u0000${target.targetContentDigest}\u0000${target.proposedText}\u0000${target.selectedText}\u0000${target.edited}\u0000${target.occurrences.map((occurrence) => (
    `${occurrence.originalStartOffset}:${occurrence.originalEndOffset}:${occurrence.category}:${occurrence.isPublic}`
  )).join("|")}`;
}

function TargetChoiceCard({ target, busy, onSave }: {
  target: StoryPrivacyTarget;
  busy: boolean;
  onSave: (choice: StoryPrivacyTargetChoice) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(target.selectedText ?? target.proposedText);
  const [publicSelections, setPublicSelections] = useState<Set<string>>(() => new Set(
    target.occurrences.filter((occurrence) => occurrence.isPublic).map((occurrence) => occurrenceKey(
      target.targetId, occurrence.originalStartOffset, occurrence.originalEndOffset, occurrence.category,
    )),
  ));
  const overrides = target.occurrences.filter((occurrence) => publicSelections.has(occurrenceKey(
    target.targetId, occurrence.originalStartOffset, occurrence.originalEndOffset, occurrence.category,
  ))).map(({ originalStartOffset, originalEndOffset, category }) => ({
    originalStartOffset, originalEndOffset, category,
  }));
  return <section className="storyPrivacyProjection">
    <p className="storyPrivacyTarget">{target.targetId}</p>
    <div className="storyPrivacyProjectionCompare">
      <div><b>Local original</b><pre>{target.originalText}</pre></div>
      <div><b>Agent-proposed anonymized text</b><pre>{target.proposedText}</pre></div>
      <div><b>Current HTML / ZIP text</b>{editing
        ? <textarea aria-label={`Edited anonymized text for ${target.targetId}`} value={draft}
            onChange={(event) => setDraft(event.target.value)}/>
        : <pre>{target.selectedText ?? "Pending target choice"}</pre>}</div>
    </div>
    {target.occurrences.length > 0 && <div className="storyPrivacyOccurrences">
      {target.occurrences.map((occurrence) => {
        const key = occurrenceKey(target.targetId, occurrence.originalStartOffset,
          occurrence.originalEndOffset, occurrence.category);
        const selected = publicSelections.has(key);
        return <div key={key}>
          <span><b>{occurrence.originalText}</b> → {occurrence.proposedText}</span>
          <button disabled={busy || editing || !occurrence.canPublish} aria-pressed={selected}
            onClick={() => setPublicSelections((current) => {
              const next = new Set(current);
              if (next.has(key)) next.delete(key); else next.add(key);
              return next;
            })}>{!occurrence.canPublish ? "Credential always removed"
              : selected ? "Use anonymized span" : "Publish exact original span"}</button>
        </div>;
      })}
      <p>Exact-public choices are revision-bound. Credentials can never be published.</p>
    </div>}
    <div className="storyPrivacyActions">
      {editing ? <>
        <button disabled={busy} onClick={() => {
          setDraft(target.selectedText ?? target.proposedText);
          setEditing(false);
        }}>Cancel edit</button>
        <button className="primary" disabled={busy || !draft.trim()}
          onClick={() => onSave({ editedText:draft, publicOverrides:[] })}>
          Save edited anonymization
        </button>
      </> : <>
        <button disabled={busy} onClick={() => setEditing(true)}>Edit anonymized text</button>
        <button disabled={busy} onClick={() => onSave({ editedText:null, publicOverrides:[] })}>
          Use Agent proposal
        </button>
        {target.occurrences.length > 0 && <button className="primary" disabled={busy}
          onClick={() => onSave({ editedText:null, publicOverrides:overrides })}>
          Save exact-public choices
        </button>}
      </>}
    </div>
  </section>;
}

export function StoryPrivacyReview({ state, busyId, onTargetChoice, onRefresh }: {
  state: StoryPrivacyState;
  busyId: string;
  onTargetChoice: (target: StoryPrivacyTarget, choice: StoryPrivacyTargetChoice) => void;
  onRefresh: () => void;
}) {
  const activeRef = useRef<HTMLElement | null>(null);
  const authority = state.authority;
  const active = authority?.candidates.find((candidate) => !candidate.resolved) || null;
  const activeTargets = authority?.targets.filter((target) => (
    active?.releaseTargets.includes(target.targetId)
  )) || [];
  const activeId = active?.id || null;
  const resolved = authority?.candidates.filter(storyPrivacyCandidateResolved).length || 0;
  const total = authority?.candidates.length || 0;

  useEffect(() => {
    if (!activeId) return;
    const frame = requestAnimationFrame(() => activeRef.current?.focus({ preventScroll:false }));
    return () => cancelAnimationFrame(frame);
  }, [activeId]);

  if (state.status !== "ready" || !authority) {
    return <section className="storyPrivacyReview" aria-labelledby="release-preview-title">
      <p className="eyebrow">Story Privacy</p><h2 id="release-preview-title">Release Preview</h2>
      <p className="storyPrivacyStatus" role="status" aria-live="polite">
        {state.status === "loading" ? "Loading the current release authority…" : state.message}
      </p>
      <p className="storyPrivacyBoundary">Release actions stay blocked until the exact current authority is available.</p>
    </section>;
  }

  const choiceCards = (targets: StoryPrivacyTarget[]) => <div className="storyPrivacyProjectionList">
    {targets.map((target) => <TargetChoiceCard key={targetHydrationKey(target)} target={target}
      busy={Boolean(busyId)}
      onSave={(choice) => onTargetChoice(target, choice)}/>) }
  </div>;

  return <section className="storyPrivacyReview" aria-labelledby="release-preview-title">
    <header className="storyPrivacyHeader">
      <div><p className="eyebrow">Story Privacy</p><h2 id="release-preview-title">Release Preview</h2></div>
      <p className="storyPrivacyProgress" role="status" aria-live="polite">{resolved} / {total} resolved</p>
    </header>
    {state.message && <p className="storyPrivacyNotice" role="status" aria-live="polite">{state.message}</p>}
    {authority.status === "preparation_required" ? <div className="storyPrivacyEmpty" role="alert">
      <b>Privacy preparation required</b>
      <p>The reviewed Story content changed or the Story Privacy contract was refreshed. Release stays paused until an exact current Agent proposal bundle is imported.</p>
      <ol className="storyPrivacyRefreshSteps">
        <li>Export the current snapshot with the public launcher.</li>
        <li>Prepare and finalize the reviewed target proposals.</li>
        <li>Import the bundle into this same localhost Viewer and workflow run.</li>
      </ol>
      <button className="primary" onClick={onRefresh}>Check imported result</button>
    </div> : authority.status === "completed_empty" ? <>
      <div className="storyPrivacyEmpty"><b>0 / 0 complete</b>
        <p>No target needs explanation; the exact Agent-proposed release text is shown below.</p>
      </div>
      {choiceCards(authority.targets)}
    </> : active ? <article className="storyPrivacyDecision" ref={activeRef} tabIndex={-1}
        aria-labelledby={`story-privacy-${active.id}`}>
      <p className="storyPrivacyCounter">Candidate {resolved + 1} of {total}</p>
      <h3 id={`story-privacy-${active.id}`}>{active.title}</h3>
      <p className="storyPrivacyLocalNotice">Original text stays local. Only a selected target value enters Release Preview, HTML, and ZIP.</p>
      {choiceCards(activeTargets)}
      <dl className="storyPrivacyReasons">
        <div><dt>Why flagged</dt><dd>{active.whyFlagged}</dd></div>
        {active.uncertaintyReason && <div><dt>Uncertainty</dt><dd>{active.uncertaintyReason}</dd></div>}
      </dl>
    </article> : <>
      <div className="storyPrivacyEmpty"><b>Release Privacy complete</b>
        <p>Every required target has selected bytes. Review or refine the exact HTML / ZIP text below.</p>
      </div>
      {choiceCards(authority.targets)}
    </>}
    <div className="storyPrivacyResolved" aria-label="Resolved Story Privacy candidates">
      {authority.candidates.filter(storyPrivacyCandidateResolved).map((candidate) => <div key={candidate.id}>
        <b>{candidate.title}</b><span>{candidateStatus(candidate)}</span>
      </div>)}
    </div>
  </section>;
}
