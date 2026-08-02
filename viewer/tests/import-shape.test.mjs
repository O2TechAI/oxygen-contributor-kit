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
test("minimal UI exposes progress, timeline, source and downloads", async () => {
  const ui=await read("../app/workspace.tsx"),progress=await read("../app/organization-progress.tsx");
  for(const label of ["Project timelines","Source records","Timeline","Source events","Download HTML","Download ZIP","Local only"])assert.match(ui,new RegExp(label));
  assert.match(ui,/payload\.documents/);
  assert.match(progress,/role="progressbar"/);assert.match(progress,/Nothing is uploaded/);
  assert.doesNotMatch(ui,/password|annotation|checklist|rewrite|Edit /i);
});
test("final package is explicitly unapproved and excludes runtime database", async () => {
  const route=await read("../app/api/package/route.ts");
  for(const name of ["manifest.json","data/documents.json","data/events.json","project-map.json","review/oxygen-local-viewer.html"])assert.match(route,new RegExp(name.replace(/[/.]/g,"\\$&")));
  assert.match(route,/publication_approved:false/);assert.match(route,/oxygen-contribution\.zip/);assert.doesNotMatch(route,/\.sqlite|\.wrangler/);
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
  assert.match(timeline,/maximum=40/);assert.match(timeline,/bucket/);
});
