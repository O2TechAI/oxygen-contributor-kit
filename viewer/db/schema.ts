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
