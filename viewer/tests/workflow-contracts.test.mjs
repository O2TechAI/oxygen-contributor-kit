import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { WORKFLOW_STAGE_IDS } from "../lib/workflow-progress.ts";

const repositoryFile = (path) => new URL(`../../${path}`, import.meta.url);
const read = (path) => readFile(repositoryFile(path), "utf8");

const assertOrdered = (document, labels) => {
  let cursor = -1;
  for (const label of labels) {
    const next = document.indexOf(label, cursor + 1);
    assert.ok(next > cursor, `${label} must appear after the preceding stage`);
    cursor = next;
  }
};

test("root routing is progressive and preserves the canonical stage owners", async () => {
  const [agents, readme, sop, storyDiscovery] = await Promise.all([
    read("AGENTS.md"),
    read("README.md"),
    read("SOP.md"),
    read("skills/oxygen-storytelling-review/agents/openai.yaml"),
  ]);

  assert.deepEqual(WORKFLOW_STAGE_IDS, ["collect", "organize", "privacy", "story", "review", "handoff"]);
  assertOrdered(agents, [
    "Collect",
    "Organize",
    "Privacy",
    "Build Project Story",
    "Review Story",
    "Release handoff",
  ]);
  assert.match(agents, /tools\/llm_redact\/REDACTION_PROMPT\.md/);
  assert.doesNotMatch(agents, /(?<!tools\/llm_redact\/)`REDACTION_PROMPT\.md`/);
  await access(repositoryFile("tools/llm_redact/REDACTION_PROMPT.md"));

  assert.match(agents, /initial routing contract/i);
  assert.match(agents, /when that stage begins/i);
  assert.match(agents, /README\.md[^\n]+public or user-documentation questions/i);
  assert.match(agents, /SOP\.md[\s\S]{0,100}complete process/i);
  assert.doesNotMatch(agents, /read `README\.md` and `SOP\.md`/i);
  assert.doesNotMatch(agents, /prepare_ai_review_run|verify_coverage|merge_and_apply|direct-edit|clean-room/i);

  for (const owner of [
    "skills/oxygen-ingest-project-history/SKILL.md",
    "skills/oxygen-organize-review-export/SKILL.md",
    "skills/oxygen-storytelling-review/SKILL.md",
    "skills/oxygen-elicit-contributor-preferences/SKILL.md",
  ]) assert.match(agents, new RegExp(owner.replaceAll("/", "\\/")));

  assert.match(readme, /## The one-line version[\s\S]*Use the Oxygen Contributor Kit/);
  assert.match(readme, /Do not upload or publish anything/);
  assert.match(readme, /\[SOP\.md\]\(SOP\.md\)[\s\S]*complete human and maintainer reference/);
  assert.doesNotMatch(readme, /agent reads[^\n]+SOP\.md[^\n]+before it touches anything/i);

  for (const heading of [
    /Stage 1: Collect project history/i,
    /Stage 2: Organize project/i,
    /Stage 3: Check privacy/i,
    /Stage 4: Build Project Story/i,
    /Stage 5: Review Story/i,
    /Stage 6: Release handoff/i,
  ]) assert.match(sop, heading);

  assert.match(storyDiscovery, /after privacy preparation/i);
  assert.match(storyDiscovery, /Project Story for human review/i);
  assert.match(storyDiscovery, /do not collect raw history or approve publication/i);
  const discoveryAndRoot = [agents, readme, sop, storyDiscovery].join("\n");
  assert.doesNotMatch(discoveryAndRoot, /(?:must|required|mandatory)[^\n]{0,60}bilingual|bilingual[^\n]{0,60}(?:must|required|mandatory)/i);

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

  const agents = await read("AGENTS.md");
  assert.match(agents, /Pause for the contributor at Review Story/);
  assert.match(agents, /same reviewed input without reopening raw history or rerunning Privacy/);
  assert.match(agents, /publication_approved=false/);
  assert.match(agents, /Never[\s\S]{0,180}upload automatically[\s\S]{0,80}publish automatically/);
});
