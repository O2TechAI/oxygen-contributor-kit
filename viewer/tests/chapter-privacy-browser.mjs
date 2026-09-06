import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
const origin = new URL(process.argv[2]);
assert.ok(["127.0.0.1", "localhost"].includes(origin.hostname));
const workflow = await fetch(new URL("/api/workflow", origin)).then((response) => response.json());
assert.equal(workflow.workflowRunId, "synthetic-chapter-privacy", "browser test only operates on its public synthetic fixture");
const browser = await chromium.launch({ headless: true, channel: process.env.OXYGEN_BROWSER_CHANNEL || "msedge" });
try {
  const page = await browser.newPage();
  const run = workflow.workflowRunId;
  const session = () => fetch(new URL(`/api/story-review-session?workflowRunId=${run}`, origin)).then((response) => response.json());
  const until = async (predicate) => { for (let count = 0; count < 100; count++) {
    if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 100));
  } throw new Error("Expected synthetic review state did not arrive"); };
  await page.goto(origin.href);
  await page.getByRole("button", { name: /Release preview/ }).click();
  const initialPreview = page.locator(".storyPrivacyReview");
  await initialPreview.locator(".storyPrivacyProjection").first().waitFor();
  assert.ok(await initialPreview.locator(".storyPrivacyProjection").count() > 1, "unapplied preview is complete and nonempty");
  assert.match(await initialPreview.innerText(), /Suggested/);
  assert.equal(await initialPreview.locator("button,textarea,input").count(), 0);
  assert.doesNotMatch((await initialPreview.locator(".storyPrivacyProjectionCompare > div:nth-child(2)").allTextContents()).join(" "), /sk-synthetic/);
  await page.getByRole("button", { name: "Project Story", exact: true }).click();
  await page.locator("#story-open-a").click();
  const chapter = page.locator(".storyChapterEditor");
  await chapter.waitFor();
  const card = chapter.locator(".privacyDecisionCard");
  const backToPassage = async () => {
    for (let count = 0; count < 4; count++) {
      if (await card.count() && await card.locator("h4").innerText() === "Story passage") return;
      await chapter.getByRole("navigation", { name: "Privacy choices" }).getByRole("button", { name: "Previous", exact: true }).click();
    }
    throw new Error("Passage choice is not reachable");
  };
  await card.waitFor();
  assert.equal(await chapter.locator(".privacyDecisionCard").count(), 1, "one card is visible at a time");
  assert.equal(await chapter.getByText("Other text in this Chapter", { exact: true }).count(), 0);
  const headingSizes = await chapter.locator("#story-people-heading,#story-privacy-heading,#story-review-summary-heading")
    .evaluateAll((elements) => elements.map((element) => getComputedStyle(element).fontSize));
  assert.equal(new Set(headingSizes).size, 1, "editorial section headings share one scale");
  if (await card.locator("h4").innerText() !== "Story passage") {
    await card.getByRole("button", { name: "Accept", exact: true }).click();
    await card.getByRole("heading", { name: "Story passage", exact: true }).waitFor();
    assert.match(await chapter.locator(".privacyProgress").innerText(), /2 \/ 3/);
  }
  assert.match(await card.innerText(), /Credentials stay hidden/);
  await card.getByRole("button", { name: "Reject", exact: true }).click();
  if (await card.count() && await card.locator("h4").innerText() === "Open questions") {
    assert.equal(await card.getByRole("button").count(), 1, "credential-only confirmation has one safe Accept action");
    await card.getByRole("button", { name: "Accept", exact: true }).click();
  }
  await backToPassage();
  assert.equal(await card.getByRole("button", { name: "Reject", exact: true }).getAttribute("aria-pressed"), "true");
  await card.getByRole("button", { name: "Accept", exact: true }).click();
  await backToPassage();
  assert.equal(await card.getByRole("button", { name: "Reject", exact: true }).getAttribute("aria-pressed"), "false");
  await card.getByRole("button", { name: "Reject", exact: true }).click();
  await until(async () => (await session()).session?.privacyDrafts?.["a::story:passage"]?.publicOverrides.length === 1);
  const before = await fetch(new URL(`/api/story-privacy?workflowRunId=${run}`, origin)).then((response) => response.json());
  assert.equal(before.targets.find((target) => target.targetId === "a::story:passage").selectedText, null);
  await page.reload(); await chapter.waitFor(); await backToPassage();
  assert.equal(await card.getByRole("button", { name: "Reject", exact: true }).getAttribute("aria-pressed"), "true");
  await card.getByRole("button", { name: "Edit", exact: true }).click();
  assert.match(await card.locator("textarea").inputValue(), /Project Delta/);
  assert.doesNotMatch(await card.locator("textarea").inputValue(), /sk-synthetic/);
  await card.getByRole("button", { name: "Cancel", exact: true }).click();
  await chapter.getByRole("button", { name: "× Do not preserve", exact: true }).click();
  await chapter.getByRole("button", { name: "Edit Story", exact: true }).click();
  await chapter.locator("textarea").first().waitFor();
  await until(async () => (await session()).session?.chapterReviews.a.sourceInsightReviews["synthetic-insight"].decision === "rejected");
  let releaseResponse, responseArrived = false;
  const held = new Promise((resolve) => { releaseResponse = resolve; });
  await page.route("**/api/story-review-session/apply", async (route) => {
    const response = await route.fetch(); responseArrived = true;
    await held; await route.fulfill({ response });
  });
  await chapter.getByRole("button", { name: "Apply current review", exact: true }).click();
  await until(() => responseArrived);
  assert.notEqual(await chapter.locator("fieldset").getAttribute("disabled"), null);
  const editor = chapter.locator("textarea").first(), copy = await editor.inputValue();
  await assert.rejects(() => editor.fill("Typing during pending acknowledgement", { timeout: 300 }));
  assert.equal(await editor.inputValue(), copy);
  assert.equal(await chapter.getByRole("navigation", { name: "Privacy choices" }).getByRole("button", { name: "Previous", exact: true }).isDisabled(), true);
  await page.locator(".chapterRailList button").filter({ hasText: "Synthetic chapter B" }).click();
  assert.equal(await chapter.locator("fieldset").getAttribute("disabled"), null);
  await page.locator(".chapterRailList button").filter({ hasText: "Synthetic chapter A" }).click();
  assert.notEqual(await chapter.locator("fieldset").getAttribute("disabled"), null,
    "navigation back cannot unlock the applying Chapter before acknowledgement");
  releaseResponse();
  await chapter.getByRole("button", { name: "All set", exact: true }).waitFor();
  const applied = await session();
  assert.equal(applied.session.chapterReviews.a.stage, "revision_ready");
  assert.equal(applied.session.chapterReviews.b.stage, "reviewing");
  assert.equal(applied.session.privacyDrafts?.["a::story:passage"], undefined);
  await chapter.getByRole("button", { name: "← Project story", exact: true }).click();
  await page.getByRole("button", { name: /Release preview/ }).click();
  const preview = page.locator(".storyPrivacyReview"); await preview.waitFor();
  assert.equal(await preview.locator("button,textarea,input").count(), 0);
  assert.match(await preview.innerText(), /Review is incomplete/);
  assert.match(await preview.innerText(), /Project Delta/);
  assert.doesNotMatch((await preview.locator(".storyPrivacyProjectionCompare > div:nth-child(2)").allTextContents()).join(" "), /sk-synthetic/);
  const passage = preview.locator(".storyPrivacyProjection").filter({ hasText: "Original retained where allowed" }).first();
  assert.match(await passage.innerText(), /Applied/);
  assert.equal(await passage.locator(".storyPrivacyProjectionCompare > div:nth-child(2) mark").count(), 1,
    "Reject removes ordinary redaction highlights while credential replacement remains");
  console.log("PASS: single-card sequence, safe credential confirmation, staged Accept/Reject, durable refresh, delayed-ack lock, Apply and accurate read-only preview");
} finally { await browser.close(); }
