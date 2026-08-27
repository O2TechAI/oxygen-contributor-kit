import { testStoryCoverage } from "./story-coverage.mjs";
import { STORY_PREFIX } from "../../lib/timeline.ts";

const documentId = "synthetic-harbor-document";
const evidence = (id) => ({ documentId, eventId: `${documentId}:${id}` });

const definitions = [
  {
    key: "comparison-boundary",
    phase: { id: "calibration", label: "Calibration" },
    kind: "discovery",
    timestamp: "2031-03-02T09:00:00Z",
    title: "The sensors needed one comparison boundary",
    overview: "Four synthetic sensors used incompatible scales until one comparison question bounded the work.",
    transition: { before: "Unrelated sensor scales", after: "One comparison question" },
    chips: ["4 synthetic sensors"],
    actors: [{ id: "calibration-owner", label: "Calibration owner" }],
    blocks: ["A shared comparison question became the prerequisite for every later drift claim."],
    insights: [],
  },
  {
    key: "controlled-trial",
    phase: { id: "calibration", label: "Calibration" },
    kind: "direction_change",
    timestamp: "2031-03-06T13:30:00Z",
    title: "Temperature became a controlled variable",
    overview: "A safe synthetic observation connected apparent drift to temperature and changed the validation plan.",
    transition: { before: "Drift looked random", after: "Temperature was controlled" },
    chips: ["controlled trial", "bounded evidence"],
    actors: [
      { id: "calibration-owner", label: "Calibration owner" },
      { id: "field-technician", label: "Field technician" },
    ],
    blocks: [
      "The field technician connected the synthetic drift to operating temperature.",
      "The calibration owner changed the validation plan to a controlled trial.",
    ],
    insights: [{
      id: "insight-control-variable",
      block: 0,
      background: "An apparent random error changed with a measured operating condition.",
      experience: "The observed relationship changed the next validation step.",
      principle: "Turn suspected noise into a controlled variable before widening a trial.",
    }],
  },
  {
    key: "independent-gate",
    phase: { id: "release-gate", label: "Release gate" },
    kind: "current_state",
    timestamp: "2031-03-11T16:00:00Z",
    title: "An independent holdout became the release gate",
    overview: "The synthetic project separated tuning evidence from the decision to release.",
    transition: { before: "One trial implied readiness", after: "An independent holdout gates release" },
    chips: ["1 independent gate"],
    actors: [{ id: "reviewer", label: "Reviewer" }],
    blocks: [
      "The Reviewer required an independent holdout before release.",
      "Release remains blocked until the holdout reproduces the calibrated behavior.",
    ],
    insights: [{
      id: "insight-independent-evidence",
      block: 0,
      background: "Tuning and release had depended on the same evidence.",
      experience: "The review separated the two decisions.",
      principle: "Reserve independent evidence for the decision that matters most.",
    }, {
      id: "insight-explicit-uncertainty",
      block: 1,
      background: "The passing trial did not establish behavior on an independent holdout.",
      experience: "The remaining uncertainty stayed visible as a release blocker.",
      principle: "Keep an unresolved boundary explicit until independent evidence resolves it.",
    }],
  },
];

export const dynamicStoryProject = Object.freeze({
  name: "Harbor Sensor Calibration",
  overview: "A non-Golden synthetic project with changing Chapter, actor, block, and Insight shapes.",
});

export const dynamicStorySources = definitions.map((definition, chapterIndex) => {
  const primary = evidence(`event-${chapterIndex + 1}`);
  const blocks = definition.blocks.map((text, blockIndex) => ({
    id: `block-${chapterIndex + 1}-${blockIndex + 1}`,
    text,
    evidence: [primary],
  }));
  return {
    schema: "oxygen.story",
    key: definition.key,
    phase: definition.phase,
    kind: definition.kind,
    title: definition.title,
    overview: definition.overview,
    transition: definition.transition,
    chips: definition.chips,
    people: definition.actors.map((actor) => ({
      id: actor.id,
      releaseLabel: actor.label,
      role: "Synthetic project actor",
      description: "Contributed to the bounded synthetic Chapter.",
      localIdentityState: "not_identified",
      evidence: [primary],
    })),
    story: {
      blocks,
      ...(chapterIndex === 2 ? { uncertainty: "The independent holdout has not yet completed." } : {}),
    },
    insights: definition.insights.map((item) => ({
      id: item.id,
      background: item.background,
      quote: { storyBlockIds: [blocks[item.block].id] },
      directlyAcquiredExperience: item.experience,
      principle: item.principle,
      evidence: [primary],
    })),
    evidence: { primary, supporting: [] },
    coverage: testStoryCoverage({ representedUnitIds: [`unit-${chapterIndex + 1}`] }),
  };
});

export const dynamicStoryEvents = dynamicStorySources.map((source, index) => ({
  id: `event-${index + 1}`,
  documentId,
  sequence: index + 1,
  timestamp: definitions[index].timestamp,
  project: dynamicStoryProject.name,
  summary: `${STORY_PREFIX}${JSON.stringify(source)}`,
}));

export const dynamicStoryEvidenceItems = dynamicStorySources.map((source) => ({
  id: source.evidence.primary.eventId,
}));
