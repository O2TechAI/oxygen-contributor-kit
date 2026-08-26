import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  phaseGroupIdentity,
  readStoryNavigation,
  resolveStoryNavigation,
  restoreChapterContext,
  restoreEvidenceOrigin,
  storyNavigationProjects,
  writeStoryNavigation,
} from "../lib/story-navigation.ts";

const candidates = [
  { project: "Alpha", story: { key: "alpha-one" } },
  { project: "Alpha", story: { key: "alpha-two" } },
  { project: "Beta", story: { key: "beta-one" } },
  { project: "Beta", story: { key: "beta-two" } },
];

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("ready Project Story choices come only from activated reviewable candidates", () => {
  const organizationProjects = ["Alpha", "Beta", "Metadata only"];
  assert.deepEqual(storyNavigationProjects(candidates), ["Alpha", "Beta"]);
  assert.equal(organizationProjects.includes("Metadata only"), true);
  assert.equal(storyNavigationProjects(candidates).includes("Metadata only"), false);
});

test("valid second-project and exact-Chapter navigation stay within activated Story", () => {
  assert.deepEqual(resolveStoryNavigation(candidates, { project:"Beta" }, "Alpha"), {
    project:"Beta", storyKey:"",
  });
  assert.deepEqual(resolveStoryNavigation(candidates, { project:"Beta", storyKey:"beta-two" }, "Alpha"), {
    project:"Beta", storyKey:"beta-two",
  });
});

test("Previous and Next resolve only exact activated Chapters in the selected project", () => {
  const beta = candidates.filter((candidate) => candidate.project === "Beta");
  const current = beta.findIndex((candidate) => candidate.story.key === "beta-two");
  assert.deepEqual(resolveStoryNavigation(candidates, {
    project:"Beta", storyKey:beta[current - 1].story.key,
  }), { project:"Beta", storyKey:"beta-one" });
  assert.deepEqual(resolveStoryNavigation(candidates, {
    project:"Beta", storyKey:beta[current].story.key,
  }), { project:"Beta", storyKey:"beta-two" });
});

test("valid Story navigation round-trips through URL refresh bootstrap", () => {
  const search = writeStoryNavigation("?kept=value", { project:"Beta", storyKey:"beta-two" });
  assert.equal(search, "?kept=value&storyProject=Beta&storyChapter=beta-two");
  assert.deepEqual(
    resolveStoryNavigation(candidates, readStoryNavigation(search), "Alpha"),
    { project:"Beta", storyKey:"beta-two" },
  );
});

test("stale, foreign, and mismatched URL navigation fails closed to activated candidates", () => {
  assert.deepEqual(resolveStoryNavigation(candidates, {
    project:"Foreign", storyKey:"raw-foreign-chapter",
  }, "Alpha"), { project:"Alpha", storyKey:"" });
  assert.deepEqual(resolveStoryNavigation(candidates, {
    project:"Beta", storyKey:"alpha-one",
  }, "Alpha"), { project:"Beta", storyKey:"" });
  assert.deepEqual(resolveStoryNavigation(candidates, {
    project:"Foreign", storyKey:"beta-two",
  }, "Missing fallback"), { project:"Alpha", storyKey:"" });
});

test("document reload preserves valid navigation and drops a removed Chapter", () => {
  const selected = { project:"Beta", storyKey:"beta-two" };
  assert.deepEqual(resolveStoryNavigation([...candidates], selected, "Alpha"), selected);
  const reloaded = candidates.filter((candidate) => candidate.story.key !== "beta-two");
  assert.deepEqual(resolveStoryNavigation(reloaded, selected, "Alpha"), {
    project:"Beta", storyKey:"",
  });
  assert.equal(reloaded.some((candidate) => candidate.story.key === "beta-two"), false);
});

test("workspace wires activated navigation to native history without Review Session writes", async () => {
  const workspace = await read("../app/workspace.tsx");
  const navigationOwner = workspace.slice(
    workspace.indexOf("const setStoryNavigation"),
    workspace.indexOf("useEffect(() => {", workspace.indexOf("const setStoryNavigation")),
  );
  assert.match(workspace, /storyNavigationProjects\(navigationCandidates\)/);
  assert.match(navigationOwner, /resolveStoryNavigation\(navigationCandidates/);
  assert.match(workspace, /window\.history\.pushState/);
  assert.match(workspace, /window\.history\.replaceState/);
  assert.doesNotMatch(navigationOwner, /workflowRunId|storyPersistence|story-review-session|serverVersion|sourceRevision|active_story_digest|publication/);
  assert.match(workspace, /if \(!storyWorkspaceReady \|\| storySessionReadyRunId !== workflowRunId[\s\S]*?!navigationCandidates\.length\) return;[\s\S]*?readStoryNavigation/);
  assert.match(workspace, /onPrevious=\{\(\) => navigateStory/);
  assert.match(workspace, /onNext=\{\(\) => navigateStory/);
  assert.match(workspace, /if \(!storyWorkspaceReady\) \{[\s\S]*?return <WorkflowProgress/);
});

test("Evidence return state restores only its originating Chapter", () => {
  const context = { storyKey: "chapter-nine", scrollTop: 842, focusOriginId: "chapter-evidence-1" };
  assert.deepEqual(restoreChapterContext(context, "chapter-nine"), { scrollTop: 842, focusOriginId: "chapter-evidence-1" });
  assert.deepEqual(restoreChapterContext(context, "chapter-ten"), { scrollTop: 0, focusOriginId: "" });
  assert.deepEqual(restoreChapterContext(null, "chapter-nine"), { scrollTop: 0, focusOriginId: "" });
});

test("Evidence return reopens its disclosure and focuses the exact originating control", () => {
  const disclosure = { open: false };
  let originFocused = false;
  let fallbackFocused = false;
  const origin = {
    closest: (selector) => selector === "details" ? disclosure : null,
    focus: (options) => {
      originFocused = options.preventScroll;
    },
  };
  const fallback = { focus: () => { fallbackFocused = true; } };
  assert.equal(restoreEvidenceOrigin(origin, fallback), true);
  assert.equal(disclosure.open, true);
  assert.equal(originFocused, true);
  assert.equal(fallbackFocused, false);

  assert.equal(restoreEvidenceOrigin(null, fallback), false);
  assert.equal(fallbackFocused, true);
});

test("non-contiguous duplicate phase labels receive stable distinct sibling identities", () => {
  assert.deepEqual(["A", "B", "A"].map(phaseGroupIdentity), ["A:0", "B:1", "A:2"]);
});
