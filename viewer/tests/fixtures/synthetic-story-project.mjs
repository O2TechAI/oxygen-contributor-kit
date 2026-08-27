import {
  dynamicStoryEvents,
  dynamicStoryProject,
} from "./story-dynamic-project.mjs";

export const syntheticStoryProject = Object.freeze({
  name: dynamicStoryProject.name,
  overview: {
    en: dynamicStoryProject.overview,
    zh: "一个会改变章节、参与者、段落与洞察形态的非黄金合成项目。",
  },
  sourceRecordCount: dynamicStoryEvents.length,
});

export const syntheticStoryEvents = dynamicStoryEvents.map((event) => ({
  id: event.id,
  document_id: event.documentId,
  sequence: event.sequence,
  timestamp: event.timestamp,
  event_type: "record",
  actor_id: "synthetic-reviewer",
  actor_type: "human",
  summary: event.summary,
  content: "Safe synthetic reviewed event.",
}));
