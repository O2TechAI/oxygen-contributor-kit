"use client";
import { appliedStoryPrivacyTargets } from "./story-privacy-ui";

import { useState } from "react";
import { applyStoryPrivacyPublicOverrides } from "../lib/story-privacy-projection";
import {
  type StoryPrivacyState,
  type StoryPrivacyTarget,
  type StoryPrivacyTargetChoice,
} from "./story-privacy-ui";

export type { StoryPrivacyCandidate, StoryPrivacyState } from "./story-privacy-ui";

function targetLabel(targetId: string) {
  const name = targetId.split("::")[1] || "";
  if (name.startsWith("story:")) return "Story passage";
  if (name.startsWith("insight:")) return `Insight · ${name.split(":").at(-1)}`;
  if (name.startsWith("people:")) return "People";
  return ({ phase: "Chapter phase", title: "Chapter title", overview: "Chapter overview",
    uncertainty: "Open questions" } as Record<string, string>)[name] || "Chapter content";
}

function occurrenceKey(targetId: string, start: number, end: number, category: string) {
  return `${targetId}\u0000${start}:${end}:${category}`;
}

export function TargetChoiceCard({ target, staged, busy, onSave, onAcceptEdited }: {
  target: StoryPrivacyTarget;
  busy: boolean;
  onSave: (choice: StoryPrivacyTargetChoice) => void;
  staged?: StoryPrivacyTargetChoice & { reviewedEditText?: string };
  onAcceptEdited?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const stagedText = staged ? staged.reviewedEditText ?? staged.editedText ?? applyStoryPrivacyPublicOverrides(
    target.originalText, target.proposedText, target.occurrences, staged.publicOverrides) : null;
  const [draft, setDraft] = useState(stagedText ?? target.selectedText ?? target.proposedText);
  const publicSelections = new Set(
    target.occurrences.filter((occurrence) => staged ? staged.publicOverrides.some((span) =>
      span.originalStartOffset === occurrence.originalStartOffset && span.originalEndOffset === occurrence.originalEndOffset
      && span.category === occurrence.category) : occurrence.isPublic).map((occurrence) => occurrenceKey(
      target.targetId, occurrence.originalStartOffset, occurrence.originalEndOffset, occurrence.category,
    )),
  );
  return <section className="storyPrivacyProjection">
    <p className="storyPrivacyTarget">{targetLabel(target.targetId)}</p>
    <div className="storyPrivacyProjectionCompare">
      <div><b>Local original</b><pre>{target.originalText}</pre></div>
      <div><b>Agent-proposed anonymized text</b><pre>{target.proposedText}</pre></div>
      <div><b>Choice pending Apply review</b>{editing
        ? <textarea aria-label={`Edited anonymized text for ${targetLabel(target.targetId)}`} value={draft}
            onChange={(event) => setDraft(event.target.value)}/>
        : <pre>{stagedText ?? target.selectedText ?? "Pending target choice"}</pre>}</div>
    </div>
    {target.editedProposal && staged && staged.editedText !== null && <div>
      <b>Checked edit suggestion</b><pre>{target.editedProposal.text}</pre>
      <button disabled={busy} onClick={onAcceptEdited}>Accept checked edit for Apply review</button>
    </div>}
    {target.occurrences.length > 0 && <div className="storyPrivacyOccurrences">
      {target.occurrences.map((occurrence) => {
        const key = occurrenceKey(target.targetId, occurrence.originalStartOffset,
          occurrence.originalEndOffset, occurrence.category);
        const selected = publicSelections.has(key);
        return <div key={key}>
          <span><b>{occurrence.originalText}</b> → {occurrence.proposedText}</span>
          <button disabled={busy || editing || !occurrence.canPublish} aria-pressed={selected}
            onClick={() => {
              const next = new Set(publicSelections);
              if (next.has(key)) next.delete(key); else next.add(key);
              onSave({ editedText: null, publicOverrides: target.occurrences.filter((span) => next.has(
                occurrenceKey(target.targetId, span.originalStartOffset, span.originalEndOffset, span.category)))
                .map(({ originalStartOffset, originalEndOffset, category }) => ({ originalStartOffset, originalEndOffset, category })) });
            }}>{!occurrence.canPublish ? "Credential always removed"
              : selected ? "Use anonymized span" : "Publish exact original span"}</button>
        </div>;
      })}
      <p>Exact-public choices are revision-bound. Credentials can never be published.</p>
    </div>}
    <div className="storyPrivacyActions">
      {editing ? <>
        <button disabled={busy} onClick={() => {
          setDraft(stagedText ?? target.selectedText ?? target.proposedText);
          setEditing(false);
        }}>Cancel edit</button>
        <button className="primary" disabled={busy || !draft.trim()}
          onClick={() => { onSave({ editedText:draft, publicOverrides:[] }); setEditing(false); }}>
          Stage edited anonymization
        </button>
      </> : <>
        <button disabled={busy} onClick={() => { setDraft(stagedText ?? target.selectedText ?? target.proposedText); setEditing(true); }}>Edit anonymized text</button>
        <button disabled={busy} onClick={() => onSave({ editedText:null, publicOverrides:[] })}>
          Accept proposal
        </button>
      </>}
    </div>
  </section>;
}

export function StoryPrivacyReview({ state, reviewComplete, chapters }: { state: StoryPrivacyState; reviewComplete: boolean; chapters: Record<string, { stage: string; evidenceVerified: boolean }> }) {
  return <section className="storyPrivacyReview" aria-labelledby="release-preview-title">
    <h2 id="release-preview-title">Release Preview</h2>
    <p>Selected release content. Edit and choose Privacy within each Chapter.</p>
    {state.status === "ready" && (!reviewComplete || state.authority.status === "preparation_required"
      || state.authority.targets.some((target) => target.selectedText === null)
      || Object.keys(state.authority.chapterErrors || {}).length > 0) && <p role="status">
      Review is incomplete. This preview shows only choices already applied in Chapters.
    </p>}
    {state.status !== "ready" ? <p role="status">{state.message}</p>
      : appliedStoryPrivacyTargets(state.authority.targets, chapters).map((target) =>
        <section className="storyPrivacyProjection" key={target.targetId}>
          <p>{targetLabel(target.targetId)}</p><pre>{target.selectedText}</pre>
        </section>)}
  </section>;
}
