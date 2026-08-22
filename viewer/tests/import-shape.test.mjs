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
  const ui=await read("../app/workspace.tsx"),episode=await read("../app/story-chapter-editor.tsx"),css=await read("../app/globals.css"),progress=await read("../app/organization-progress.tsx"),evidence=await read("../app/redaction-compare.tsx");
  for(const label of ["Project timelines","Source records","Timeline","Project story","meaningful milestones","Read chapter","Download HTML","Download ZIP","Local only"])assert.match(ui,new RegExp(label));
  for(const contract of ["canvasHeadInner","storyTimelineLayout","phaseDirectory","Narrative phase directory","milestoneChips","Key facts","fmtTimelineDate"])assert.match(ui,new RegExp(contract));
  assert.match(css,/\.phaseDirectory\{position:sticky;top:50%;align-self:start;transform:translateY\(-50%\)/);
  assert.doesNotMatch(ui,/className="projectStrip"/);
  assert.doesNotMatch(ui,/className="milestoneNarrative"/);
  assert.match(ui,/useState<StoryLanguage>\("en"\)/);
  assert.match(ui,/EN<\/button>/);assert.match(ui,/中文<\/button>/);
  assert.match(ui,/timelineContextRef/);assert.match(ui,/scrollTop=context\.scrollTop/);assert.match(ui,/preventScroll:true/);
  assert.match(ui,/story-chapter-editor/);assert.match(ui,/chapterRailContext/);assert.match(ui,/Back to chapter/);assert.match(ui,/focusOriginId:evidenceReturn\.originId/);
  assert.match(ui,/restoreChapterContext\(chapterScrollRestore,activeMilestone\?\.story\.key/);assert.match(ui,/inert=\{activeMilestone\?true:undefined\}/);
  assert.equal((ui.match(/key=\{phaseGroupIdentity\(/g)||[]).length,2);
  assert.match(css,/\.workspace\.episodeOpen\{grid-template-columns:var\(--rail-width\)/);assert.match(css,/\.chapterRailContext/);
  assert.match(css,/\.chapterEditor \.simpleEpisodeHero,.chapterEditor \.simpleEpisodeBody\{width:min\(900px,100%\)/);
  assert.match(ui,/chapterRailList/);assert.match(ui,/highlights\.map/);assert.match(ui,/aria-current=/);assert.match(ui,/scrollIntoView\(\{ block:"nearest" \}\)/);
  assert.match(css,/\.chapterRailList\{[^}]*max-height:[^}]*overflow-y:auto[^}]*overscroll-behavior:contain/);
  assert.match(css,/\.workspace\.episodeOpen \.rail\{visibility:visible;overflow-y:auto;overscroll-behavior:contain\}/);
  assert.equal((episode.match(/data-episode-section=/g)||[]).length,3);
  for(const section of ["people","story","privacy"])assert.match(episode,new RegExp(`data-episode-section="${section}"`));
  assert.doesNotMatch(episode,/data-episode-section="highlights"/);
  assert.doesNotMatch(episode,/simpleSectionHead"><span>[123]</);
  assert.match(css,/Chapter sections are editorial headings, not sequential steps/);
  for(const label of ["Project story","View local evidence","Exact source language","AI insight","Delete","Revise","Add","Privacy review complete","All set","Reopen review","Final Release Memory"])assert.match(episode,new RegExp(label));
  assert.match(episode,/data-inline-insight/);assert.match(episode,/data-story-block/);assert.match(episode,/captureSelection/);
  assert.match(episode,/copy\.contains\(range\.startContainer\).*copy\.contains\(range\.endContainer\)/s);
  assert.match(episode,/storyAnnotatedRange/);assert.match(episode,/data-annotation-ids/);
  assert.match(css,/\.storyAnnotatedRange\{text-decoration:underline/);
  assert.doesNotMatch(css,/\.reviewableStoryBlock\.annotated>p|li\.annotated>span\[data-story-copy\]/);
  assert.match(episode,/original\.availability/);assert.match(episode,/Original content unavailable in the reviewed artifact/);
  assert.match(episode,/privacyState\.active\.whyFlagged/);assert.doesNotMatch(episode,/Suggested release|建议发布表述|labels\.suggestedRelease/);
  assert.match(episode,/baseRevision: chapterReview\.revision/);assert.match(episode,/publication approval/);
  assert.match(episode,/role="region"/);assert.doesNotMatch(episode,/aria-modal/);
  assert.match(episode,/supportingEvidence/);assert.match(episode,/staleTranslations/);
  assert.match(episode,/disclosure && !disclosure\.open/);assert.match(episode,/querySelector<HTMLElement>\("summary"\)/);
  assert.match(evidence,/resolveEvidenceTarget/);assert.match(evidence,/target\?\.focus\(\{ preventScroll: true \}\)/);assert.match(evidence,/reference was not approximated/);
  assert.doesNotMatch(episode,/reviewPath|versionDistinction|Read release episode|Judge AI insight|data-episode-section="highlights"/);
  assert.match(ui,/payload\.documents/);
  assert.match(progress,/role="progressbar"/);assert.match(progress,/Nothing is uploaded/);
  assert.doesNotMatch(ui+episode,/password|checklist/i);
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
  assert.match(release,/state\.stage !== "human_confirmed"/);assert.match(release,/publication_approved: false/);
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
  assert.match(skill,/10–40 high-impact milestones/);
  const launcher=await read("../../skills/oxygen-organize-review-export/scripts/run_local_review.py");
  assert.match(launcher,/trajectory_id}:\{event_id/);
  const timeline=await read("../lib/timeline.ts");
  assert.match(timeline,/maximum = 40/);
  assert.match(timeline,/oxygen\.story-highlight\/2/);
  assert.match(timeline,/oxygen\.story-milestone\/1/);
  assert.match(timeline,/releaseEpisode/);
  assert.match(timeline,/ROUTINE_TERMS/);
  assert.doesNotMatch(timeline,/for\s*\(let bucket|bucket\*ordered\.length/);
});
