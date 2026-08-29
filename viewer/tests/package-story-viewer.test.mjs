import test from "node:test";
import assert from "node:assert/strict";
import { renderPackagedLocalViewer } from "../app/api/package/route.ts";

test("packaged local Viewer nests accepted Insights beside their Story block with exact safe Quotes", () => {
  const reviewedStory = {
    schema: "oxygen.reviewed-story",
    publication_approved: false,
    chapters: [{
      phase: "Resolution",
      en: {
        title: "A reviewed decision",
        overview: "The participants narrowed the repair.",
        people: [{
          releaseLabel: "One participant",
          role: "Contributor",
          description: "Proposed the bounded repair.",
        }],
        story: {
          blocks: [{
            text: "One participant proposed a narrow change; the reviewer then confirmed it.",
            insights: [{
              title: "Keep the boundary explicit",
              background: "The first proposal left the authority boundary implicit.",
              quote: "the reviewer then confirmed it",
              directlyAcquiredExperience: "The confirmation made the handoff explicit.",
              principle: "Name the authority boundary before completing the handoff.",
            }, {
              title: "Human-selected passage",
              background: "The contributor selected the opening proposal during review.",
              quote: "One participant proposed a narrow change",
              directlyAcquiredExperience: "The selected passage retained its reviewed wording.",
              principle: "Keep human-selected Story Quotes exact.",
            }],
          }],
        },
      },
    }],
  };

  const html = renderPackagedLocalViewer(JSON.stringify(reviewedStory));
  const embedded = html.match(/const STORY=([\s\S]*?);const view=/)?.[1];
  assert.deepEqual(JSON.parse(embedded), reviewedStory);
  assert.deepEqual(JSON.parse(embedded).chapters[0].en.story.blocks[0].insights.map(({ quote }) => quote), [
    "the reviewer then confirmed it",
    "One participant proposed a narrow change",
  ]);
  assert.match(html, /x\.story\.blocks\.map\(b=>'<div class="story-row">/);
  assert.match(html, /b\.insights\.map\(card\)/);
  assert.match(html, /<p><b>Quote<\/b> '\+esc\(i\.quote\)/);
  assert.match(html, /@media\(max-width:720px\)\{\.story-row\{grid-template-columns:1fr\}/);
  assert.match(html, /"publication_approved":false/);
  assert.doesNotMatch(html, /"(?:anchorStoryBlockId|documentId|eventId|evidence|authority|serverVersion|sourceRevision|reviewGateDigest)"\s*:/);
});
