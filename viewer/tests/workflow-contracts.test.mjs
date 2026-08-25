import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { WORKFLOW_STAGE_IDS } from "../lib/workflow-progress.ts";

const repositoryFile = (path) => new URL(`../../${path}`, import.meta.url);
const read = (path) => readFile(repositoryFile(path), "utf8");

test("root routing uses the canonical Privacy prompt and executable six-stage order", async () => {
  const [agents, readme, sop] = await Promise.all([
    read("AGENTS.md"),
    read("README.md"),
    read("SOP.md"),
  ]);

  assert.deepEqual(WORKFLOW_STAGE_IDS, ["collect", "organize", "privacy", "story", "review", "handoff"]);
  assert.match(agents, /tools\/llm_redact\/REDACTION_PROMPT\.md/);
  assert.doesNotMatch(agents, /(?<!tools\/llm_redact\/)`REDACTION_PROMPT\.md`/);
  await access(repositoryFile("tools/llm_redact/REDACTION_PROMPT.md"));

  for (const document of [readme, sop]) {
    const normalized = document.toLowerCase();
    const build = normalized.indexOf("build project story");
    const review = normalized.indexOf("review story");
    const preferences = normalized.indexOf("preferences", review);
    const releasePreview = normalized.indexOf("release preview", review);
    assert.ok(build >= 0 && review > build && preferences > review && releasePreview > review);
    assert.match(document, /pause/i);
    assert.match(document, /All set/);
    assert.match(document, /publication_approved/);
  }
});

test("reviewed Story has no numeric quota and Preferences stays inside the reviewed boundary", async () => {
  const paths = [
    "README.md",
    "SOP.md",
    "viewer/README.md",
    "skills/oxygen-organize-review-export/SKILL.md",
    "skills/oxygen-elicit-contributor-preferences/SKILL.md",
  ];
  const documents = await Promise.all(paths.map(read));
  for (const document of documents) assert.doesNotMatch(document, /10\s*[-–—]\s*40/);

  const preferenceSkill = documents.at(-1);
  assert.match(preferenceSkill, /privacy-prepared reviewed run/);
  assert.match(preferenceSkill, /Do not reopen the raw organized run/);
  assert.match(preferenceSkill, /do not independently apply or rerun redaction/);
  assert.doesNotMatch(preferenceSkill, /Apply the redaction pass/);
});
