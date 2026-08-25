import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
test("viewer uses local D1 with only organization tables", async () => {
  const hosting=JSON.parse(await read("../.openai/hosting.json"));
  const db=await read("../db/index.ts");
  assert.equal(hosting.d1,"DB");
  assert.match(db,/documents/);assert.match(db,/items/);assert.match(db,/organization_jobs/);
  assert.doesNotMatch(db,/annotations|checklists|audit_log/);
});
test("chapter editor retains the application rail and exposes three bilingual sections", async () => {
  const ui=await read("../app/workspace.tsx"),episode=await read("../app/story-chapter-editor.tsx"),css=await read("../app/globals.css"),progress=await read("../app/organization-progress.tsx"),evidence=await read("../app/redaction-compare.tsx"),evidenceReview=await read("../app/api/evidence/route.ts");
  for(const label of ["Storytelling Review","Project Story","Source records","meaningful milestones","Read chapter","Download HTML","Download ZIP","Local only"])assert.match(ui,new RegExp(label));
  for(const contract of ["storyCanvasGrid","storyOrientation","phaseHeading","milestoneList","phaseDirectory","Narrative phase directory","milestoneChips","Key facts","fmtTimelineDate"])assert.match(ui,new RegExp(contract));
  assert.match(css,/\.storyCanvasGrid>\.phaseDirectory\{position:sticky;top:34px;display:flex/);
  assert.match(css,/@media\(max-width:1080px\)\{\.storyCanvasGrid\{grid-template-columns:minmax\(0,900px\)\}\.storyCanvasGrid>\.phaseDirectory\{display:none\}\}/);
  assert.doesNotMatch(ui,/className="projectStrip"/);
  assert.doesNotMatch(ui,/className="milestoneNarrative"/);
  assert.match(ui,/useState<StoryLanguage>\("en"\)/);
  assert.match(ui,/EN<\/button>/);assert.match(ui,/中文<\/button>/);
  assert.match(ui,/timelineContextRef/);assert.match(ui,/scrollTop=context\.scrollTop/);assert.match(ui,/preventScroll:true/);
  assert.match(ui,/story-chapter-editor/);assert.match(ui,/chapterRailContext/);assert.match(ui,/Back to chapter/);assert.match(ui,/focusOriginId:evidenceReturn\.originId/);
  assert.match(ui,/restoreChapterContext\(chapterScrollRestore,activeMilestone\?\.story\.key/);assert.match(ui,/inert=\{activeMilestone\?true:undefined\}/);
  assert.equal((ui.match(/key=\{phaseGroupIdentity\(/g)||[]).length,2);
  assert.match(css,/\.workspace\.episodeOpen\{grid-template-columns:var\(--rail-width\)/);assert.match(css,/\.chapterRailContext/);
  assert.match(css,/\.chapterEditor\{--chapter-canvas-width:1180px/);
  assert.match(css,/\.chapterCanvas,.chapterEditor \.simpleEpisodeHero,.chapterEditor \.simpleEpisodeBody\{width:min\(var\(--chapter-canvas-width\),100%\)/);
  assert.match(css,/\.chapterEditor \.simpleEpisodeHero h2,.chapterEditor \.episodeOverview,.chapterEditor \.chapterReviewGuide\{width:100%;max-width:none\}/);
  assert.match(episode,/className="chapterCanvas chapterChromeCanvas"/);
  assert.match(ui,/chapterRailList/);assert.match(ui,/highlights\.map/);assert.match(ui,/aria-current=/);assert.match(ui,/scrollIntoView\(\{ block:"nearest" \}\)/);
  assert.match(css,/\.chapterRailList\{[^}]*max-height:[^}]*overflow-y:auto[^}]*overscroll-behavior:contain/);
  assert.match(css,/\.workspace\.episodeOpen \.rail\{visibility:visible;overflow-y:auto;overscroll-behavior:contain\}/);
  assert.equal((episode.match(/data-episode-section=/g)||[]).length,3);
  for(const section of ["people","story","privacy"])assert.match(episode,new RegExp(`data-episode-section="${section}"`));
  assert.doesNotMatch(episode,/data-episode-section="highlights"/);
  assert.doesNotMatch(episode,/simpleSectionHead"><span>[123]</);
  assert.match(css,/Chapter sections are editorial headings, not sequential steps/);
  for(const label of ["Project story","View local evidence","Exact source language","AI insight","Privacy review complete","All set","Reopen review","Final Release Memory"])assert.match(episode,new RegExp(label));
  assert.match(episode,/data-inline-insight/);assert.match(episode,/data-story-block/);
  assert.doesNotMatch(episode,/selectionToolbar|selectionPrompt|captureSelection|createAnnotation\(/);
  assert.doesNotMatch(css,/\.selectionToolbar|\.selectionPrompt/);
  assert.match(episode,/storyAnnotatedRange/);assert.match(episode,/data-annotation-ids/);
  assert.match(css,/\.storyAnnotatedRange\{text-decoration:underline/);
  assert.match(css,/\.storyEditedRange\{[^}]*text-decoration-style:wavy/);
  assert.doesNotMatch(css,/\.reviewableStoryBlock\.annotated>p|li\.annotated>span\[data-story-copy\]/);
  assert.match(episode,/original\.availability/);assert.match(episode,/Original content unavailable in the reviewed artifact/);
  assert.match(episode,/privacyState\.active\.whyFlagged/);assert.doesNotMatch(episode,/Suggested release|建议发布表述|labels\.suggestedRelease/);
  assert.match(episode,/publication approval/);
  assert.match(episode,/const insightSuppressed = chapterReview\.redactedBlocks\.includes\(`insight:\$\{visibleHighlight\.id\}`\);/);
  assert.match(episode,/role="region"/);assert.doesNotMatch(episode,/aria-modal/);
  assert.match(episode,/supportingEvidence/);assert.match(episode,/staleTranslations/);
  assert.match(episode,/fetch\("\/api\/evidence"/);assert.match(episode,/supportedAddIds/);assert.match(episode,/evidenceResolved/);
  assert.match(evidenceReview,/reviewStoryEvidence/);assert.match(evidenceReview,/SELECT id FROM items WHERE document_id=\?/);assert.match(evidenceReview,/SELECT id,content FROM items WHERE document_id=\? AND id=\?/);assert.doesNotMatch(evidenceReview,/SELECT id,content FROM items WHERE document_id=\? ORDER BY|original_json/);
  assert.match(episode,/restoreEvidenceOrigin\(origin, backRef\.current\)/);
  assert.match(evidence,/resolveEvidenceTarget/);assert.match(evidence,/target\?\.focus\(\{ preventScroll: true \}\)/);assert.match(evidence,/reference was not approximated/);
  assert.doesNotMatch(episode,/reviewPath|versionDistinction|Read release episode|Judge AI insight|data-episode-section="highlights"/);
  assert.match(ui,/payload\.documents/);
  assert.match(progress,/role="progressbar"/);assert.match(progress,/Nothing is uploaded/);
  assert.doesNotMatch(ui+episode,/password|checklist/i);
  const orientation=ui.indexOf('<header className="storyOrientation"');
  const instruction=ui.indexOf('data-story-stream-instruction');
  const firstPhase=ui.indexOf('className="storyPhase"');
  assert.ok(orientation >= 0 && orientation < instruction && instruction < firstPhase);
});
test("Chapter Story defaults to read mode and uses controlled direct editing plus sequenced passage context", async () => {
  const [episode,css,timeline,release,workspace,progress,workflowRoute] = await Promise.all([
    read("../app/story-chapter-editor.tsx"), read("../app/globals.css"), read("../lib/timeline.ts"),
    read("../lib/story-release.ts"), read("../app/workspace.tsx"),
    read("../app/organization-progress.tsx"), read("../app/api/workflow/route.ts"),
  ]);
  assert.match(episode,/const \[editMode, setEditMode\] = useState\(false\)/);
  assert.match(episode,/data-story-mode=\{editMode \? "edit" : "read"\}/);
  assert.match(episode,/className="storyEditingBar" role="toolbar"/);
  assert.match(episode,/labels\.editingStory/);assert.match(episode,/labels\.finishEditing/);
  assert.match(episode,/canUndoStoryEdit/);assert.match(episode,/canRedoStoryEdit/);
  assert.match(episode,/undoStoryEdit/);assert.match(episode,/redoStoryEdit/);
  assert.match(episode,/onBeforeInput/);assert.match(episode,/onPaste/);assert.match(episode,/sanitizeStoryPaste/);
  assert.match(episode,/data-story-editor=\{blockId\}/);assert.match(episode,/recordStoryEdit/);
  assert.doesNotMatch(episode,/selectionToolbar|selectionPrompt|createAnnotation\(/);
  assert.match(episode,/const leaveEditMode = \(\) => \{[\s\S]*setEditMode\(false\)/);
  assert.match(episode,/onFocus=\{\(\) => activatePassage\(blockId\)\}/);
  assert.match(episode,/const handleStoryDoubleClick = \(event: ReactMouseEvent<HTMLElement>\)/);
  assert.match(episode,/closest<HTMLElement>\("\[data-story-copy\]"\)/);
  assert.match(episode,/copy\.contains\(range\.startContainer\) && copy\.contains\(range\.endContainer\)/);
  assert.match(episode,/enterStoryEditMode\(blockId, Math\.min\(start, end\), Math\.max\(start, end\)\)/);
  assert.match(episode,/className="chapterArticle storyDocument"[^>]*onDoubleClick=\{handleStoryDoubleClick\}/);
  assert.match(episode,/if \(editMode \|\| chapterReview\.stage === "human_confirmed"\) return/);
  assert.equal((episode.match(/onDoubleClick=/g) || []).length, 1);
  const doubleClickHandler = episode.slice(
    episode.indexOf("const handleStoryDoubleClick"),
    episode.indexOf("const commitDirectMutation"),
  );
  assert.doesNotMatch(doubleClickHandler,/recordStoryEdit|onChapterReview/);
  assert.match(episode,/type SyntheticEvent/);
  assert.doesNotMatch(episode,/captureDirectSelection|onSelect=/);
  assert.doesNotMatch(episode,/setSelection\(/);
  assert.match(episode,/data-annotation-note=\{annotation\.id\}/);
  assert.match(episode,/data-edit-note=\{transaction\.id\}/);
  assert.match(episode,/const noteAnnotationsByBlock/);assert.match(episode,/const noteEditsByBlock/);
  assert.match(episode,/transaction\.sourceLanguage\.toUpperCase\(\)/);
  assert.match(episode,/discardStoryEdit/);assert.match(episode,/revertAppliedStoryEdit/);
  assert.match(episode,/focusAnnotation\(annotation\)/);
  assert.match(episode,/data-context-block=\{activePassageId/);
  assert.match(episode,/presentation\.passageContext\[activePassageId\]/);
  assert.match(episode,/aria-label=\{labels\.previousInsight\}/);assert.match(episode,/aria-label=\{labels\.nextInsight\}/);
  assert.match(episode,/scrollToPassage/);assert.match(episode,/orderedPassageIds/);
  assert.match(episode,/data-story-editor=\{blockId\}/);
  assert.equal((episode.match(/data-inline-insight=/g) || []).length, 1);
  assert.match(episode,/<details className=\{`canonicalInsightDisclosure/);
  assert.doesNotMatch(episode, /const insightSuppressed =[^;]*insightReview\?\.status === "rejected"/);
  assert.match(episode, /rejected_applied[\s\S]*labels\.rejectedApplied[\s\S]*aria-live="polite"/);
  assert.match(css,/\.storyReviewWorkspace\.editing \.storyDocument\{border:/);
  assert.match(css,/\.storyBlockRow\{display:grid;grid-template-columns:160px minmax\(0,1fr\)/);
  assert.match(css,/\.passageInsightPanel\{position:sticky/);
  assert.match(css,/\.passageInsightNav\{display:grid/);
  assert.match(css,/@media\(max-width:1300px\)[\s\S]*\.passageInsightPanel\{position:relative/);
  assert.match(css,/@media\(max-width:760px\)[\s\S]*\.storyMarginNotes\{display:flex;overflow-x:auto/);
  assert.match(timeline,/passageContext: Record<string, StoryPassageContext>/);
  assert.doesNotMatch(release,/passageContext/);
  assert.match(workspace,/Read a Chapter to review the full story, evidence, direct learning, and reusable rules\./);
  assert.match(workspace,/阅读任一章节，完整审阅故事、证据、直接经验与可复用规则/);
  assert.match(workspace,/setWorkflowOpen\(true\)/);
  assert.match(progress,/private Agent reasoning is never shown here/);
  assert.doesNotMatch(workflowRoute,/original_json|SELECT\s+content|reasoning|prompt/i);
});
test("Release Preview and Preferences use centered, gate-aware, locale-consistent surfaces", async () => {
  const [ui,css,probes,probeApi,db,preferenceModel,release] = await Promise.all([
    read("../app/workspace.tsx"), read("../app/globals.css"), read("../app/probe-panel.tsx"),
    read("../app/api/probes/route.ts"), read("../db/index.ts"),
    read("../lib/preference-presentation.ts"), read("../app/redaction-compare.tsx"),
  ]);
  assert.match(ui,/const openReleasePreview/);
  assert.match(ui,/redactionJob\?\.status === "complete" && docs\[0\]/);
  assert.match(ui,/setSelected\(docs\[0\]\.id\)/);
  assert.match(ui,/releasePreviewReturnSelectionRef\.current=selected/);
  assert.match(ui,/const restoreReleasePreviewSelection/);
  assert.match(ui,/setSelected\(releasePreviewReturnSelectionRef\.current\)/);
  assert.match(ui,/reviewStream releasePreviewStream/);
  assert.match(ui,/reviewStream preferencesStream/);
  assert.match(css,/\.reviewStream>\.redactionPanel\{width:min\(960px,100%\);margin-left:auto;margin-right:auto\}/);
  assert.match(release,/const items = allItems/);
  assert.doesNotMatch(release,/local original fallback|private evidence fallback/i);

  assert.match(ui,/language=\{language\}/);
  assert.match(probes,/resolveProbePresentation\(probe, language\)/);
  assert.match(probes,/role="alert">\{labels\.localeMissing\}/);
  assert.match(probes,/data-preference-id=\{probe\.id\}/);
  assert.match(probeApi,/presentations_json/);
  assert.match(probeApi,/normalizeProbePresentations/);
  assert.match(db,/ALTER TABLE probes ADD COLUMN presentations_json/);
  assert.match(db,/let initialization: Promise<void> \| null/);
  assert.match(db,/initialization \?\?= \(async \(\) =>/);
  assert.match(preferenceModel,/return presentation \? \{ \.\.\.probe, \.\.\.presentation \} : null/);
});
test("Chapter completion renders unsupported-Add copy only for a needs-evidence Add", async () => {
  const episode=await read("../app/story-chapter-editor.tsx");
  assert.match(episode,/summary\.needsEvidenceAdd > 0 && <p className="completionBlocker">\{labels\.addBlocked\}/);
  assert.match(episode,/summary\.pendingInsights > 0 \? labels\.insightBlocked/);
  assert.match(episode,/chapterReview\.staleTranslations\.length > 0 && <p className="completionNotice">\{labels\.translationBlocked\}/);
  assert.doesNotMatch(episode,/staleTranslations\.length > 0 \? labels\.translationBlocked/);
  assert.doesNotMatch(episode,/summary\.unresolved[^\n]*labels\.addBlocked/);
});
test("final package is explicitly unapproved and excludes runtime database", async () => {
  const route=await read("../app/api/package/route.ts");
  for(const name of ["manifest.json","data/documents.json","data/events.json","project-map.json","privacy/redaction-summary.json","review/oxygen-local-viewer.html"])assert.match(route,new RegExp(name.replace(/[/.]/g,"\\$&")));
  assert.match(route,/publication_approved: false/);assert.match(route,/oxygen-contribution\.zip/);assert.doesNotMatch(route,/\.sqlite|\.wrangler/);
  assert.match(route,/releaseOrganizationReason/);assert.match(route,/reviewedStoryPackageEntry/);assert.match(route,/export async function POST/);
});
test("HTML and ZIP downloads accept only the reviewed Story release projection", async () => {
  const html=await read("../app/api/organization/export/route.ts"),release=await read("../lib/story-release.ts"),ui=await read("../app/workspace.tsx");
  assert.match(html,/sanitizeReviewedStoryRelease/);assert.match(html,/human-confirmed Final Release Memory/i);
  assert.doesNotMatch(html,/formatted_summary_json|SELECT .*content|organization_reason/);
  for(const forbidden of ["exact evidence","Privacy originals","local identities","annotations","instructions"])assert.match(release,new RegExp(forbidden,"i"));
  assert.match(release,/story\/reviewed-project-story\.json/);
  assert.match(release,/state\.stage !== "human_confirmed"/);assert.match(release,/validateChapterReviewCompletion/);assert.match(release,/publication_approved: false/);
  assert.match(ui,/buildReviewedStoryRelease/);assert.match(ui,/method:"POST"/);
});
test("removed features and login routes stay deleted", async () => {
  for(const path of ["../app/login/page.tsx","../lib/auth.ts","../app/api/annotations/route.ts","../app/api/checklists/route.ts","../app/api/rewrite/[id]/route.ts"]){await assert.rejects(access(new URL(path,import.meta.url)));}
});
test("organizer labels projects and preserves concise summaries", async () => {
  const organizer=await read("../app/api/organization/route.ts"),skill=await read("../../skills/oxygen-organize-review-export/SKILL.md");
  assert.match(organizer,/primary_project/);assert.match(organizer,/organization_category/);assert.match(organizer,/highlights/);
  assert.match(skill,/at most 18 English words or 32 Chinese characters/);assert.match(skill,/proactively open/);assert.match(skill,/Download ZIP/);
  assert.match(skill,/Never create one timeline per trajectory/);
  assert.match(skill,/evidence-supported meaningful milestones without using a numeric quota/);
  assert.match(skill,/durable\s+progress, substantive iterations/);
  const launcher=await read("../../skills/oxygen-organize-review-export/scripts/run_local_review.py");
  assert.match(launcher,/trajectory_id}:\{event_id/);
  const timeline=await read("../lib/timeline.ts");
  assert.match(timeline,/maximum\?: number/);
  assert.match(timeline,/maximum \?\? Number\.POSITIVE_INFINITY/);
  assert.match(timeline,/slice\(0, maximum \?\? 40\)/);
  assert.match(timeline,/oxygen\.story-highlight\/2/);
  assert.match(timeline,/oxygen\.story-milestone\/1/);
  assert.match(timeline,/releaseEpisode/);
  assert.match(timeline,/ROUTINE_TERMS/);
  assert.doesNotMatch(timeline,/for\s*\(let bucket|bucket\*ordered\.length/);
});
