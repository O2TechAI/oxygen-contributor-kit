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
  const [agents, readme, sop, storySkill, storyDiscovery] = await Promise.all([
    read("AGENTS.md"),
    read("README.md"),
    read("SOP.md"),
    read("skills/oxygen-storytelling-review/SKILL.md"),
    read("skills/oxygen-storytelling-review/agents/openai.yaml"),
  ]);

  assert.deepEqual(WORKFLOW_STAGE_IDS, ["collect", "organize", "privacy", "story", "review", "handoff"]);
  assertOrdered(agents, [
    "Collect",
    "Organize",
    "upstream source Privacy",
    "Build Project Story with bounded semantic workers",
    "independent global sparse",
    "Story/Release Privacy candidate preparation",
    "Preference-question generation",
    "Project Story human review",
    "Privacy Keep/Redact decisions",
    "Preference answers",
    "All set",
    "local reviewed release",
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
    /Stage 3: Prepare upstream source Privacy/i,
    /Stage 4: Build Project Story and candidate review artifacts/i,
    /Stage 5: Human Story, Privacy, and Preference review/i,
    /Stage 6: All set and release handoff/i,
  ]) assert.match(sop, heading);

  for (const document of [sop, storySkill]) {
    assertOrdered(document, [
      "Collect",
      "Organize",
      "upstream source Privacy preparation",
      "build Project Story using bounded semantic workers",
      "independent global sparse Insight pass",
      "Story/Release Privacy candidate preparation",
      "Preference-question generation",
      "Project Story human review",
      "Privacy Keep/Redact decisions",
      "Preference answers",
      "All set",
      "local reviewed release",
    ]);
  }
  assert.match(storySkill, /REQUIRED\/NOT YET IMPLEMENTED[\s\S]{0,120}Wave B runtime dependenc/);
  assert.match(storySkill, /activation is blocked here/i);
  assert.match(storySkill, /completed-zero[\s\S]{0,120}Preference-question generation/);
  assert.doesNotMatch([sop, storySkill].join("\n"), /when possible|when appropriate/i);

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
  assert.match(agents, /Pause for the contributor at Project Story human review/);
  assert.match(agents, /same reviewed input without reopening raw history[\s\S]{0,40}rerunning Privacy/);
  assert.match(agents, /publication_approved=false/);
  assert.match(agents, /Never[\s\S]{0,180}upload automatically[\s\S]{0,80}publish automatically/);
});

test("Story public contracts preserve coverage, Insight, and Privacy release semantics", async () => {
  const [
    storySkill,
    productContract,
    storyDataContract,
    uiContract,
    privacyContract,
    validationChecklist,
    sop,
  ] = await Promise.all([
    read("skills/oxygen-storytelling-review/SKILL.md"),
    read("skills/oxygen-storytelling-review/references/product-contract.md"),
    read("skills/oxygen-storytelling-review/references/story-data-contract.md"),
    read("skills/oxygen-storytelling-review/references/ui-interaction-contract.md"),
    read("skills/oxygen-storytelling-review/references/privacy-evidence-boundary.md"),
    read("skills/oxygen-storytelling-review/references/validation-checklist.md"),
    read("SOP.md"),
  ]);
  const documents = [
    storySkill,
    productContract,
    storyDataContract,
    uiContract,
    privacyContract,
    validationChecklist,
    sop,
  ].join("\n");

  assert.match(productContract, /deterministic input/i);
  assert.match(productContract, /immutable input digest/i);
  assert.match(productContract, /byte\/content-balanced shard manifests/i);
  assert.match(productContract, /separate bounded workers for Story writing, Insight reasoning, Privacy reasoning, and Preference-question reasoning/i);
  assert.match(productContract, /worker returns a receipt[\s\S]{0,160}input digest[\s\S]{0,80}unit IDs covered/);
  assert.match(productContract, /validator and activation binding are \*\*REQUIRED\/NOT YET IMPLEMENTED\*\*/);
  assert.match(productContract, /Do not claim exact union\/no-overlap has been executably validated/);
  assert.match(productContract, /No worker may silently expand scope[\s\S]{0,80}repair another lane/i);
  assert.doesNotMatch(productContract, /The owning Agent validates exact union coverage/);

  assert.match(storyDataContract, /type CoverageDraftRow/);
  assert.match(storyDataContract, /disposition: "represented"; ownerId/);
  assert.match(storyDataContract, /disposition: "excluded"; exclusionReason/);
  assert.match(storyDataContract, /exact submitted `story-coverage-manifest\.json` becomes the prior accepted coverage authority/);
  assert.doesNotMatch(documents, new RegExp("server-accepted-story-" + "coverage\\.json"));

  assert.match(uiContract, /Insight is not Story prose/);
  assert.match(uiContract, /left narrative column/);
  assert.match(uiContract, /right-side companion column/);
  assert.match(uiContract, /Multiple Insights[\s\S]{0,80}stack/);
  assert.match(uiContract, /Do not insert Insights inline[\s\S]{0,120}generic Chapter-end list/i);

  assert.match(privacyContract, /Only `needs_confirmation` rows are decision-editable/);
  assert.match(privacyContract, /NOT YET IMPLEMENTED[\s\S]{0,120}obsolete category\/delete controls/);
  assert.match(privacyContract, /clean-room product completion is[\s\S]{0,80}blocked/);
  assert.match(privacyContract, /Keep[\s\S]{0,20}Redact/);
  assert.match(privacyContract, /Pending confirmation blocks Story\/package release/);
  assert.match(privacyContract, /Raw Evidence and suppressed content are not exposed through Insight review/);
  assert.doesNotMatch(sop, /controls to change the category|delete the decision|soft delete/i);
  assert.match(sop, /\$Kit = \(Get-Location\)\.Path/);
  assert.doesNotMatch(sop, /O2-Intern\\oxygen-contributor-kit/);
  assert.match(sop, /Stop here on the current base[\s\S]{0,200}receipt validator/);
  assert.match(sop, /After Wave B authority is implemented/);
  assert.match(sop, /--story-event ready/);
});
