import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const documents = sqliteTable("documents", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  sourceUser: text("source_user"),
  sourceSystem: text("source_system"),
  sourceTimestamp: text("source_timestamp"),
  itemCount: integer("item_count").notNull().default(0),
  metadataJson: text("metadata_json").notNull().default("{}"),
  originalEnvelopeJson: text("original_envelope_json").notNull().default("{}"),
  importedAt: text("imported_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  organizationStatus: text("organization_status").notNull().default("pending"),
  formattedSummaryJson: text("formatted_summary_json").notNull().default("{}"),
});

export const items = sqliteTable("items", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull(),
  sequence: integer("sequence").notNull(),
  eventType: text("event_type"),
  actorId: text("actor_id"),
  actorType: text("actor_type"),
  timestamp: text("timestamp"),
  content: text("content").notNull(),
  originalJson: text("original_json").notNull(),
  organizationCategory: text("organization_category"),
  organizationConfidence: integer("organization_confidence"),
  organizationReason: text("organization_reason"),
});

export const organizationJobs = sqliteTable("organization_jobs", {
  id: text("id").primaryKey(),
  status: text("status").notNull(),
  stage: text("stage").notNull(),
  completed: integer("completed").notNull().default(0),
  total: integer("total").notNull().default(0),
  warningsJson: text("warnings_json").notNull().default("[]"),
  startedAt: text("started_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  completedAt: text("completed_at"),
});

// Sanitized operational state begins before collection. It intentionally has
// no target path, free-form message, model output, or project payload column.
export const workflowRuns = sqliteTable("workflow_runs", {
  id: text("id").primaryKey(),
  targetConfirmed: integer("target_confirmed").notNull().default(0),
  collectionStatus: text("collection_status").notNull().default("pending"),
  collectionCompleted: integer("collection_completed").notNull().default(0),
  collectionTotal: integer("collection_total").notNull().default(0),
  storyGenerationStatus: text("story_generation_status").notNull().default("not_started"),
  storyGenerationCompleted: integer("story_generation_completed").notNull().default(0),
  storyGenerationTotal: integer("story_generation_total").notNull().default(0),
  storySourceRevision: integer("story_source_revision").notNull().default(0),
  activeStoryDigest: text("active_story_digest"),
  blockerCode: text("blocker_code"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// Project-local Story review state persists only for the lifetime of the
// isolated Viewer runtime. It is never part of the reviewed release package.
export const storyReviewSessions = sqliteTable("story_review_sessions", {
  workflowRunId: text("workflow_run_id").primaryKey(),
  stateJson: text("state_json").notNull(),
  updatedAt: text("updated_at").notNull(),
  serverVersion: integer("server_version").notNull().default(0),
});
