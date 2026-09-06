"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  storyPrivacyChanges, storyPrivacyNeedsDecision, storyPrivacyTargetView,
  type StoryPrivacyCandidate, type StoryPrivacyDraft, type StoryPrivacyState,
  type StoryPrivacyTarget, type StoryPrivacyTargetChoice,
} from "./story-privacy-ui";

export type { StoryPrivacyCandidate, StoryPrivacyState } from "./story-privacy-ui";

function targetLabel(targetId: string) {
  const name = targetId.split("::")[1] || "";
  if (name.startsWith("story:")) return "Story passage";
  if (name.startsWith("insight:")) return `Insight · ${({ title: "Title", background: "Background",
    quote: "Quoted passage", directlyAcquiredExperience: "Experience", principle: "Principle" } as Record<string, string>)[name.split(":").at(-1) || ""] || "Content"}`;
  if (name.startsWith("people:")) return "People";
  return ({ phase: "Chapter phase", title: "Chapter title", overview: "Chapter overview",
    uncertainty: "Open questions" } as Record<string, string>)[name] || "Chapter content";
}

function useEditedInputDigests(drafts: Record<string, StoryPrivacyDraft>) {
  const [checked, setChecked] = useState<Record<string, { text: string; digest: string }>>({});
  useEffect(() => {
    let current = true;
    void Promise.all(Object.entries(drafts).filter(([, draft]) => draft.editedText !== null).map(async ([id, draft]) => {
      const text = draft.editedText!;
      const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(text)));
      return [id, { text, digest: Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("") }] as const;
    })).then((entries) => { if (current) setChecked(Object.fromEntries(entries)); });
    return () => { current = false; };
  }, [drafts]);
  return Object.fromEntries(Object.entries(checked).filter(([id, value]) => drafts[id]?.editedText === value.text)
    .map(([id, value]) => [id, value.digest]));
}

type Range = { start: number; end: number };
function markedText(text: string, ranges: Range[]): ReactNode[] {
  const points = Array.from(text), out: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    out.push(points.slice(cursor, range.start).join(""));
    out.push(<mark className="redactionHit" key={index}>{points.slice(range.start, range.end).join("")}</mark>);
    cursor = range.end;
  });
  out.push(points.slice(cursor).join(""));
  return out;
}

// Show complete changed sentences, never cut a marked occurrence or lose a separate change.
function PrivacyExcerpt({ text, ranges }: { text: string; ranges: Range[] }) {
  const points = Array.from(text), windows: Range[] = [];
  for (const range of ranges) {
    let start = range.start, end = range.end;
    while (start > 0 && !/[.!?。！？\n]/u.test(points[start - 1])) start--;
    while (end < points.length && !/[.!?。！？\n]/u.test(points[end])) end++;
    if (end < points.length) end++;
    const previous = windows.at(-1);
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else windows.push({ start, end });
  }
  const shown = windows.length ? windows : [{ start: 0, end: points.length }];
  const full = shown.length === 1 && shown[0].start === 0 && shown[0].end === points.length;
  return <><div className="privacyExcerpt">{shown.map((window, index) => <p key={index}>
    {window.start > 0 && "… "}{markedText(points.slice(window.start, window.end).join(""), ranges
      .filter((range) => range.start >= window.start && range.end <= window.end)
      .map((range) => ({ start: range.start - window.start, end: range.end - window.start })))}{window.end < points.length && " …"}
  </p>)}</div>{!full && <details className="privacyFullText"><summary>Full passage</summary><p>{markedText(text, ranges)}</p></details>}</>;
}

export function TargetChoiceCard({ target, candidates, staged, inputDigest, chapter, busy, onSave, onAcceptEdited }: {
  target: StoryPrivacyTarget; candidates: StoryPrivacyCandidate[]; staged?: StoryPrivacyDraft; inputDigest?: string;
  chapter?: { stage: string; evidenceVerified: boolean };
  busy: boolean; onSave: (choice: StoryPrivacyTargetChoice) => void; onAcceptEdited: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const view = storyPrivacyTargetView(target, staged, chapter, inputDigest);
  const [draft, setDraft] = useState(view.text);
  const editingDraft = staged?.targetContentDigest === target.targetContentDigest && staged.editedText !== null;
  const selectedEdit = !staged && target.edited && target.selectedText !== null;
  const suggestion = view.checkedEdit ? target.editedProposal!.text : editingDraft ? staged!.editedText! : selectedEdit ? target.selectedText! : target.proposedText;
  const changes = storyPrivacyChanges(target, suggestion);
  const publicSpans = target.occurrences.filter((span) => span.canPublish);
  const credentials = target.occurrences.some((span) => !span.canPublish);
  return <article className="privacyDecisionCard">
    <h4>{targetLabel(target.targetId)}</h4>
    <div className="privacyContext">
      <section><h5>Original</h5><div><PrivacyExcerpt text={target.originalText}
        ranges={changes.map((range) => ({ start: range.originalStart, end: range.originalEnd }))}/></div></section>
      <section><h5>AI recommendation</h5><div>{candidates.length ? candidates.map((candidate) =>
        <p key={candidate.id}>{candidate.whyFlagged}{candidate.uncertaintyReason && ` ${candidate.uncertaintyReason}`}</p>)
        : <p>Review the anonymized wording for this passage.</p>}</div></section>
      <section><h5>{view.checkedEdit ? "Checked edit" : editingDraft ? "Your edit" : selectedEdit ? "Reviewed edit" : "Suggested wording"}</h5><div>{editing
        ? <textarea aria-label={`Edited anonymized text for ${targetLabel(target.targetId)}`} value={draft}
            onChange={(event) => setDraft(event.target.value)}/>
        : <PrivacyExcerpt text={suggestion} ranges={changes.map(({ start, end }) => ({ start, end }))}/>}</div></section>
    </div>
    <p className="privacyChoiceStatus" role="status">{!view.choice && !staged ? "Choose how this passage should appear." : view.status}</p>
    {credentials && <p className="privacyCredentialNote">Credentials stay hidden.</p>}
    <div className="privacyActions">{editing ? <>
      <button disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
      <button className="privacyAccept" disabled={busy || !draft.trim()} onClick={() => {
        onSave({ editedText: draft, publicOverrides: [] }); setEditing(false);
      }}>Save edit</button>
    </> : <>
      <button className="privacyAccept" aria-pressed={view.choice === "accept" || ((view.checkedEdit || selectedEdit) && view.ready)}
        disabled={busy || selectedEdit || (editingDraft && !view.checkedEdit)} onClick={() => view.checkedEdit ? onAcceptEdited() : onSave({ editedText: null, publicOverrides: [] })}>Accept</button>
      {publicSpans.length > 0 && <><button className="privacyReject" aria-pressed={view.choice === "reject"} disabled={busy || publicSpans.length === 0}
        onClick={() => onSave({ editedText: null, publicOverrides: publicSpans.map(({ originalStartOffset, originalEndOffset, category }) =>
          ({ originalStartOffset, originalEndOffset, category })) })}>Reject</button>
      <button className="privacyEdit" aria-pressed={view.choice === "edit"} disabled={busy}
        onClick={() => { setDraft(view.text); setEditing(true); }}>Edit</button></>}
    </>}</div>
  </article>;
}

export function ChapterPrivacyReview({ targets, candidates, drafts, chapter, busy, pending, onSave, onAcceptEdited }: {
  targets: StoryPrivacyTarget[]; candidates: StoryPrivacyCandidate[]; drafts: Record<string, StoryPrivacyDraft>;
  chapter?: { stage: string; evidenceVerified: boolean };
  busy: boolean; pending: boolean; onSave: (target: StoryPrivacyTarget, choice: StoryPrivacyTargetChoice) => void;
  onAcceptEdited: (target: StoryPrivacyTarget) => void;
}) {
  const digests = useEditedInputDigests(drafts);
  const required = targets.filter((target) => storyPrivacyNeedsDecision(target, candidates, drafts[target.targetId]));
  const resolved = (target: StoryPrivacyTarget) => {
    const view = storyPrivacyTargetView(target, drafts[target.targetId], undefined, digests[target.targetId]);
    return view.ready;
  };
  const firstPending = required.find((target) => !resolved(target));
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = (activeId ? required.find((target) => target.targetId === activeId) : undefined) ?? firstPending;
  const activeIndex = active ? required.indexOf(active) : -1;
  const completed = required.filter(resolved).length;
  const advance = () => setActiveId(required.slice(activeIndex + 1).find((target) => !resolved(target))?.targetId
    ?? required.slice(0, activeIndex).find((target) => !resolved(target))?.targetId ?? null);
  return <div className="chapterPrivacyReview">
    {pending && <p className="privacyChoiceStatus" role="status">Waiting for Privacy review of this Chapter’s current draft. Your choices are retained.</p>}
    {active ? <>
      <div className="privacyProgress"><span>{activeIndex + 1} / {required.length}</span><span>{completed} choices ready for Apply</span></div>
      <TargetChoiceCard key={`${active.targetId}:${active.targetContentDigest}:${active.proposedText}`}
        target={active} candidates={candidates.filter((candidate) => candidate.releaseTargets.includes(active.targetId))}
        staged={drafts[active.targetId]} inputDigest={digests[active.targetId]} chapter={chapter} busy={busy}
        onSave={(choice) => { onSave(active, choice); advance(); }}
        onAcceptEdited={() => { onAcceptEdited(active); advance(); }}/>
    </> : pending ? <p role="status">Your choices will appear here when the review returns.</p> : <p className="privacyComplete" role="status">{required.length
      ? `${completed} / ${required.length} choices ready. Apply them with your review below.`
      : "No Privacy choices needed. Prepared anonymization will be confirmed with Apply review."}</p>}
    {required.length > 0 && <nav className="privacyCardNav" aria-label="Privacy choices">
      <button disabled={busy || activeIndex === 0} onClick={() => setActiveId(required[activeIndex < 0 ? required.length - 1 : activeIndex - 1].targetId)}>Previous</button>
      <button disabled={busy || activeIndex < 0 || activeIndex === required.length - 1}
        onClick={() => setActiveId(required[activeIndex + 1].targetId)}>Next</button>
    </nav>}
    {!active && targets.some((target) => target.occurrences.some((span) => !span.canPublish)) && <p className="privacyCredentialNote">Credentials stay hidden in every choice.</p>}
    {Object.keys(drafts).some((id) => !targets.some((target) => target.targetId === id)) && <p role="status">An earlier edit is retained while its current text is checked.</p>}
  </div>;
}

function PreviewTarget({ target, draft, chapter, inputDigest, candidates }: {
  candidates: StoryPrivacyCandidate[]; target: StoryPrivacyTarget; draft?: StoryPrivacyDraft; chapter?: { stage: string; evidenceVerified: boolean }; inputDigest?: string;
}) {
  const view = storyPrivacyTargetView(target, draft, chapter, inputDigest);
  const changes = storyPrivacyChanges(target, view.text);
  return <section className="storyPrivacyProjection">
    <header><h4>{targetLabel(target.targetId)}</h4><span>{view.status}</span></header>
    <div className="storyPrivacyProjectionCompare">
      <div><b>Local original</b><p>{markedText(target.originalText, changes.map((range) => ({ start: range.originalStart, end: range.originalEnd })))}</p></div>
      <div><b>{view.label}</b><p>{markedText(view.text, changes.map(({ start, end }) => ({ start, end })))}</p></div>
    </div>
    <div className="privacyChangeNote">
      {changes.length ? <><b>{draft?.editedText !== null && draft?.editedText !== undefined && !view.ready ? "Draft wording changes · awaiting review" : "Privacy changes"}</b>
        <ul>{changes.map((range, index) => <li key={index}>
          <span>{Array.from(target.originalText).slice(range.originalStart, range.originalEnd).join("") || "(added text)"}</span>
          {" → "}<span>{Array.from(view.text).slice(range.start, range.end).join("") || "(removed)"}</span>
        </li>)}</ul></> : <p>{target.occurrences.length ? "Original wording retained where allowed." : "No wording changes."}</p>}
      {candidates.map((candidate) => <p key={candidate.id}>{candidate.whyFlagged}{candidate.uncertaintyReason && ` ${candidate.uncertaintyReason}`}</p>)}
      {target.occurrences.some((span) => !span.canPublish) && <p>Credentials stay hidden in reviewed release text.</p>}
    </div>
  </section>;
}

export function StoryPrivacyReview({ state, reviewComplete, chapters, drafts, chapterTitles }: {
  state: StoryPrivacyState; reviewComplete: boolean;
  chapters: Record<string, { stage: string; evidenceVerified: boolean }>;
  drafts: Record<string, StoryPrivacyDraft>; chapterTitles: Record<string, string>;
}) {
  const digests = useEditedInputDigests(drafts);
  const keys = [...new Set([...Object.keys(chapterTitles), ...(state.authority?.targets.map((target) => target.targetId.split("::")[0]) || [])])];
  return <section className="storyPrivacyReview" aria-labelledby="release-preview-title">
    <h2 id="release-preview-title">Release Preview</h2>
    <p>Compare local originals with the wording expected in your release. Highlighted passages show changes.</p>
    {!reviewComplete && <p className="redactionNotice" role="status">Review is incomplete. Suggestions and drafts are previews; Apply review in each Chapter to confirm them.</p>}
    {state.status !== "ready" ? <p role="status">{state.message}</p> : keys.map((key) => <section className="privacyPreviewChapter" key={key}>
      <h3>{chapterTitles[key] || "Chapter"}</h3>
      {(state.authority.pendingChapterKeys?.includes(key) || state.authority.chapterErrors?.[key]) && <p role="status">This Chapter’s current draft needs Privacy review. Some passages are not available yet.</p>}
      {state.authority.targets.filter((target) => target.targetId.startsWith(`${key}::`)).map((target) =>
        <PreviewTarget key={target.targetId} target={target} draft={drafts[target.targetId]} chapter={chapters[key]} inputDigest={digests[target.targetId]}
          candidates={state.authority.candidates.filter((candidate) => candidate.releaseTargets.includes(target.targetId))}/>)}
      {!state.authority.targets.some((target) => target.targetId.startsWith(`${key}::`)) && <p role="status">Waiting for a preview of this Chapter’s current text.</p>}
    </section>)}
  </section>;
}
