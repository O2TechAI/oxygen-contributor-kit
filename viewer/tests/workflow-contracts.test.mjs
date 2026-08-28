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
  assert.match(storySkill, /requires four files: coverage manifest, Story candidates, deterministic[\s\S]{0,80}Preference bundle/i);
  assert.match(storySkill, /imports the exact Preference bundle\s+before it requests Review Story activation/i);
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

test("fresh parent Story-worker assignments convey both writing contracts before bounded input", async () => {
  const assignmentMarker = "Every `story`-lane subagent assignment must convey this ordered contract before dispatch:";
  const narrativePath = "skills/oxygen-storytelling-review/references/narrative-writing-contract.md";
  const dataPath = "skills/oxygen-storytelling-review/references/story-data-contract.md";
  const documents = await Promise.all([
    read("AGENTS.md"),
    read("SOP.md"),
    read("skills/oxygen-storytelling-review/SKILL.md"),
    read("skills/oxygen-storytelling-review/references/story-preparation-transport.md"),
  ]);

  for (const document of documents) {
    const start = document.indexOf(assignmentMarker);
    assert.ok(start >= 0, "parent-facing Story dispatch instructions must carry the assignment gate");
    const assignment = document.slice(start, start + 1_600);
    assertOrdered(assignment, [
      assignmentMarker,
      `\`${narrativePath}\` completely`,
      `\`${dataPath}\` completely`,
      "Then read exactly",
      "`inputPath`",
      "Write only",
      "proposal",
    ]);
    assert.match(assignment, /(?:Do not|must not) dispatch a Story worker (?:unless|until)/);
    assert.match(assignment, /actual generated[\s\S]{0,80}`inputPath`/);
    assert.match(assignment, /proposal-only write boundary/);
  }

  await Promise.all([access(repositoryFile(narrativePath)), access(repositoryFile(dataPath))]);
});

test("Narrative contract asks for evidence-backed engagement without fabrication", async () => {
  const [narrativeContract, storyDataContract] = await Promise.all([
    read("skills/oxygen-storytelling-review/references/narrative-writing-contract.md"),
    read("skills/oxygen-storytelling-review/references/story-data-contract.md"),
  ]);

  assert.match(narrativeContract, /Write for a technically curious reader\./);
  assert.match(narrativeContract, /quickly establishing the real purpose, constraint, or starting state/);
  assert.match(narrativeContract, /using concrete actors and actions/);
  assert.match(narrativeContract, /Let interest come from what actually changed, became understood, or was established\./);
  assert.match(narrativeContract, /Do not invent stakes, drama, emotion, dialogue, motive, conflict, causality, or closure\./);
  assert.match(narrativeContract, /ordinary[\s\S]{0,80}clear and specific rather than theatrical/);
  assert.doesNotMatch(storyDataContract, /engagement/i);
});

test("Story preparation bounds proposal correction and keeps Preference global", async () => {
  const [
    agents,
    sop,
    storySkill,
    storyTransport,
    productContract,
    preferenceSkill,
    organizerSkill,
  ] = await Promise.all([
    read("AGENTS.md"),
    read("SOP.md"),
    read("skills/oxygen-storytelling-review/SKILL.md"),
    read("skills/oxygen-storytelling-review/references/story-preparation-transport.md"),
    read("skills/oxygen-storytelling-review/references/product-contract.md"),
    read("skills/oxygen-elicit-contributor-preferences/SKILL.md"),
    read("skills/oxygen-organize-review-export/SKILL.md"),
  ]);

  for (const document of [
    agents, sop, storySkill, storyTransport, productContract, preferenceSkill, organizerSkill,
  ]) {
    assert.match(document, /one\s+initial\s+proposal\s+plus\s+at\s+most\s+two\s+automatic[\s\S]{0,60}proposal-only\s+correction\s+attempts/i);
    assert.match(document, /`correctionAttemptCount`[\s\S]{0,120}counts corrections only[\s\S]{0,120}`0\.\.2`/i);
    assert.match(document, /byte-identical immutable(?: shard)? input/i);
    assert.match(document, /invalid\s+initial\s+or\s+correction\s+attempt[\s\S]{0,100}(?:leaves\s+both|creates\s+neither)[\s\S]{0,60}output[\s\S]{0,40}receipt/i);
    assert.match(document, /second correction fails[\s\S]{0,140}correction exhaustion[\s\S]{0,100}last\s+safe\s+validation\s+code[\s\S]{0,120}(?:do not|does not)\s+continue\s+downstream/i);
    assert.match(document, /Authority,\s+immutability,\s+containment,\s+path,\s+I\/O,\s+infrastructure,\s+and\s+corrupt-state\s+failures\s+stop\s+immediately[\s\S]{0,80}never\s+correctable/i);
  }

  for (const document of [agents, sop, storySkill, storyTransport, productContract]) {
    assert.match(document, /Story, Insight, and Story Privacy[\s\S]{0,140}multi-shard/i);
  }
  for (const document of [agents, sop, storySkill, storyTransport, productContract, preferenceSkill]) {
    assert.match(document, /Preference[\s\S]{0,120}exactly one global bounded worker/i);
    assert.match(document, /one\s+deduplicated\s+questionnaire\s+authority/i);
    assert.match(document, /12\s+probes\s+by\s+default[\s\S]{0,50}20\s+maximum/i);
  }

  const allContracts = [agents, sop, storySkill, storyTransport, productContract, preferenceSkill].join("\n");
  assert.doesNotMatch(allContracts, /every Preference manifest shard/i);
  for (const document of [agents, sop, storySkill, storyTransport, organizerSkill]) {
    assert.match(document, /(?:at\s+most|no\s+more\s+than)\s+three\s+live/i);
  }
});

test("public Story preparation binds current source revision from Organization before receipts", async () => {
  const [sop, storyTransport, preferenceSkill, preferenceContract] = await Promise.all([
    read("SOP.md"),
    read("skills/oxygen-storytelling-review/references/story-preparation-transport.md"),
    read("skills/oxygen-elicit-contributor-preferences/SKILL.md"),
    read("skills/oxygen-elicit-contributor-preferences/references/preference-probe-contract.md"),
  ]);
  for (const document of [sop, storyTransport]) {
    assert.match(document, /Invoke-RestMethod -Method Get -Uri "\$Viewer\/api\/organization"/u);
    assert.match(document, /\$Organization\.status -cne "complete"/u);
    assert.match(document, /\$null -eq \$Organization\.semanticManifest/u);
    assert.match(document,
      /\$SourceRevision = \$Organization\.semanticManifest\.sourceRevision/u);
    assert.match(document, /\$SourceRevisionDecimal -lt 1/u);
    assert.match(document, /\$SourceRevisionDecimal -gt 9007199254740991/u);
    assert.match(document, /CURRENT_SOURCE_REVISION_UNAVAILABLE/u);
    assert.ok(document.indexOf("$Viewer/api/organization")
      < document.indexOf("record_story_preparation.mjs"));
    assert.match(document,
      /validate_probes\.py[\s\S]{0,500}--source-revision \$SourceRevision/u);
    assert.match(document,
      /finalize_story_preparation\.mjs[\s\S]{0,500}--source-revision \$SourceRevision/u);
  }
  const publicAuthorityContracts = [sop, storyTransport, preferenceSkill, preferenceContract].join("\n");
  assert.doesNotMatch(publicAuthorityContracts,
    /\$SourceRevision\s*=\s*0\b|--source-revision\s+0\b/u);
  assert.doesNotMatch(publicAuthorityContracts,
    /--source-revision\s+<[^>\r\n]*>/u);
  assert.doesNotMatch(publicAuthorityContracts,
    /Invoke-RestMethod[^\n]+\/api\/workflow|\$SourceRevision\s*=[^\n]*\/api\/workflow/u);
  assert.match(preferenceSkill, /positive JavaScript-safe integer/u);
  assert.match(preferenceSkill, /never comes from `\/api\/workflow`/u);
  assert.match(preferenceContract, /Completed-zero[\s\S]{0,120}never permits a zero/u);
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

  assert.match(productContract, /public deterministic (?:owner-atomic )?Story input preparation/i);
  assert.match(productContract, /immutable input digests/i);
  assert.match(productContract, /bounded[\s\S]{0,40}worker input/i);
  assert.match(productContract, /dependent passes for Story writing and Insight reasoning[\s\S]{0,100}sibling Story Privacy and Preference-question passes/i);
  assert.match(productContract, /recorder validates[\s\S]{0,160}input digest/);
  assert.match(productContract, /one Story batch[\s\S]{0,160}unchanged Viewer `validateStorySourcePackage`[\s\S]{0,180}atomic records-directory rename/i);
  assert.match(productContract, /composed launcher requires coverage, Story candidates, a deterministic Preference bundle/i);
  assert.match(productContract, /Exact union,[\s\S]{0,80}no foreign identities[\s\S]{0,100}executable checks/);
  assert.match(productContract, /No worker may silently expand scope[\s\S]{0,80}repair another lane/i);
  assert.doesNotMatch(productContract, /The owning Agent validates exact union coverage/);

  assert.match(storyDataContract, /type CoverageDraftRow/);
  assert.match(storyDataContract, /disposition: "represented"; ownerId/);
  assert.match(storyDataContract, /disposition: "excluded"; exclusionReason/);
  assert.match(storyDataContract, /exact submitted `story-coverage-manifest\.json` becomes the prior accepted coverage authority/);
  for (const contract of [storySkill, storyDataContract]) {
    assert.match(contract, /--source-privacy/);
    assert.match(contract, /completed-zero/i);
    assert.match(contract, /`deterministic`[\s\S]{0,80}`confirmed_redact`/);
    assert.match(contract, /`needs_confirmation`[\s\S]{0,80}`confirmed_keep`/);
    assert.match(contract, /(no Source Privacy rows|must not contain Source Privacy rows)/i);
  }
  assert.match(storyDataContract, /Activation independently rederives the same set from current local\s+SQLite/i);
  assert.match(storyDataContract, /Persisted coverage readback[\s\S]{0,100}stale or changed authority/i);
  assert.doesNotMatch(storyDataContract, /source Privacy[^\n]{0,80}(fallback|compatibility|legacy)/i);
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
  assert.match(sop, /Composition sequence \(implemented transport\)/);
  assert.match(sop, /--preference-bundle/);
  assert.match(sop, /--preparation-manifest/);
  assert.doesNotMatch(sop, /tools[\\/]llm_redact[\\/]push_probes\.py/);
});

test("Story public transport is owner-atomic, phase-free, and globally recorded", async () => {
  const [
    agents,
    sop,
    storySkill,
    storyDataContract,
    storyTransport,
    productContract,
    checklist,
    preparer,
    recorder,
  ] = await Promise.all([
    read("AGENTS.md"),
    read("SOP.md"),
    read("skills/oxygen-storytelling-review/SKILL.md"),
    read("skills/oxygen-storytelling-review/references/story-data-contract.md"),
    read("skills/oxygen-storytelling-review/references/story-preparation-transport.md"),
    read("skills/oxygen-storytelling-review/references/product-contract.md"),
    read("skills/oxygen-storytelling-review/references/validation-checklist.md"),
    read("skills/oxygen-storytelling-review/scripts/prepare_story_preparation.mjs"),
    read("skills/oxygen-storytelling-review/scripts/record_story_preparation.mjs"),
  ]);
  const publicContracts = [
    agents,
    sop,
    storySkill,
    storyDataContract,
    storyTransport,
    productContract,
    checklist,
  ].join("\n");

  assert.match(publicContracts, /finalized Coverage `ownerId`[^\n]{0,100}(?:sole|only)[^\n]{0,80}(?:owner|ownership)/i);
  assert.match(publicContracts, /complete owner[- ]atomic Story bundles/i);
  assert.match(publicContracts, /one owner never spans (?:workers|shards)/i);
  assert.match(publicContracts, /shard may contain multiple owners/i);
  assert.match(publicContracts, /phase-free Story proposal/i);
  assert.match(publicContracts, /parent does not write Story prose/i);
  assert.match(publicContracts, /(?:complete|every phase-free)[^\n]{0,80}(?:Story )?proposal[^\n]{0,80}(?:before|collected before)[^\n]{0,80}(?:receipt|authority)/i);
  assert.match(publicContracts, /one Story batch recorder/i);
  assert.match(publicContracts, /exactly one receipt per (?:expected )?shard/i);
  assert.match(publicContracts, /Insight remains a separate later pass/i);
  assert.match(publicContracts, /Static tests prove contracts and authority behavior, not\s+actual host-subagent spawning; that requires later E2E evidence/i);

  for (const document of [sop, storyTransport]) {
    assert.match(document, /"\$Transport" story "\$StoryProposals" "\$StoryPhases"[\s\S]{0,80}--correction-attempt-count 0/);
    assert.doesNotMatch(document, /"\$Transport" story "<manifest-shard-id>" "<proposal-path>"/);
  }

  assert.doesNotMatch(preparer, /MAX_STORY_PREPARATION_SHARD_IDENTITIES/);
  assert.match(preparer, /ownerBundles/);
  assert.match(preparer, /STORY_OWNER_BUNDLE_TOO_LARGE/);
  assert.match(recorder, /STORY_PROPOSAL_PARENT_FIELD_FORBIDDEN/);
  assert.match(recorder, /PARTIAL_BATCH_REJECTED/);
  assert.match(recorder, /validateStorySourcePackage/);
});
