import { readStoryPrivacySourceRedactions, storyPrivacyProposalRanges } from "../../lib/story-privacy-projection.ts";
import { seedCoveragePrivacyAuthority } from "../story-coverage-privacy-fixture.mjs";
import { deriveStoryReleaseTargetContents, storyPreparationDigest } from "../../lib/story-preparation.ts";
import { emptyChapterReview, recordStoryEdit } from "../../lib/story-review.ts";
import { createStoryReviewSession } from "../../lib/story-review-session.ts";

export async function seedChapterPrivacy(db, { badSecondChapter = true, interactive = false, multiplePrivacyChoices = false, rereview = false } = {}) {
  const run = "synthetic-chapter-privacy", now = "2042-01-01T00:00:00.000Z", sourceRevision = 2;
  const sources = ["a", "b"].map((key) => {
    const evidence = { documentId: "synthetic-source", eventId: `synthetic-${key}` };
    return { schema: "oxygen.story", key, language: "en", languagePolicyDigest: "f".repeat(64),
      phase: { id: `phase-${key}`, label: "Build" }, title: `Synthetic chapter ${key.toUpperCase()}`,
      overview: `Review the public ${key.toUpperCase()} narrative.`, people: [{ id: `person-${key}`,
        releaseLabel: "Contributor", role: "Owner", description: "A synthetic contributor.",
        localIdentityState: "not_identified", evidence: [evidence] }],
      story: { blocks: [{ id: "passage", text: `The ${key.toUpperCase()} draft was reviewed.`, evidence: [evidence] }] },
      insights: [], evidence: { primary: evidence, supporting: [] }, coverage: {
        semanticManifest: { revision: 1, digest: "b".repeat(64) }, coverageManifest: { revision: 1, digest: "c".repeat(64) },
        representedUnitIds: [], excludedUnits: [] } };
  });
  if (interactive) {
    sources[0].story.blocks[0].text = "The A draft for Project Delta used sk-synthetic-1234567890 during a public test.";
    if (multiplePrivacyChoices) {
      sources[0].overview = "Project Delta was reviewed before a public demonstration.";
      sources[0].story.uncertainty = "The test credential sk-synthetic-1234567890 must be removed.";
    }
    const evidence = sources[0].evidence.primary;
    sources[0].insights = [{ id: "synthetic-insight", title: "Keep a separate review step",
      background: "The public test used a separate review step.", anchorStoryBlockId: "passage",
      quote: { text: "during a public test", evidence }, directlyAcquiredExperience: "I checked the draft before release.",
      principle: "Review the exact draft before release.", evidence: [evidence] }];
  }
  if (rereview) {
    sources[0].overview = "Project Cedar is a public evaluation.";
    sources[0].story.blocks[0].text = "Project Cedar was discussed on May 2.";
  }
  await db.prepare(`INSERT INTO workflow_runs (id,target_confirmed,collection_status,story_generation_status,
    story_source_revision,active_story_digest,created_at,updated_at) VALUES (?,1,'complete','ready_for_human_review',?,?,?,?)`)
    .bind(run, sourceRevision, "0".repeat(64), now, now).run();
  await db.prepare(`INSERT INTO documents (id,kind,title,item_count,imported_at,updated_at)
    VALUES ('synthetic-source','trajectory','Public synthetic review',2,?,?)`).bind(now, now).run();
  for (const [index, source] of sources.entries()) await db.prepare(`INSERT INTO items
    (id,document_id,sequence,content,original_json,organization_reason,event_type,actor_id,actor_type)
    VALUES (?,'synthetic-source',?,?,'{}',?,'message','synthetic-person','human')`).bind(
      source.evidence.primary.eventId, index + 1, source.story.blocks[0].text, `oxygen.story:${JSON.stringify(source)}`).run();
  const redactions = interactive ? [["Project Delta", "sensitive"], ["sk-synthetic-1234567890", "credential"]]
    .map(([text, category]) => ({ itemId: "synthetic-a", documentId: "synthetic-source",
      startOffset: sources[0].story.blocks[0].text.indexOf(text),
      endOffset: sources[0].story.blocks[0].text.indexOf(text) + text.length,
      category, confidence: "high", reason: "Explicitly marked synthetic test information.",
      reviewState: "deterministic", uncertaintyReason: null, createdBy: "llm" })) : [];
  const seeded = await seedCoveragePrivacyAuthority(db, { workflowRunId: run, sourceRevision, stories: sources, now, redactions });
  await db.prepare("UPDATE items SET organization_category='Synthetic project',organization_confidence=100").run();
  await db.prepare(`INSERT INTO organization_jobs (id,status,stage,completed,total,started_at,updated_at,completed_at)
    VALUES ('synthetic-organization','complete','complete',2,2,?,?,?)`).bind(now, now, now).run();
  await db.prepare("UPDATE documents SET organization_status='complete',formatted_summary_json=? WHERE id='synthetic-source'")
    .bind(JSON.stringify({ primary_project: "Synthetic project", project_summary: "Public synthetic review fixture.",
      highlights: sources.map((source, index) => ({ id: source.evidence.primary.eventId,
        sequence: index + 1, timestamp: null, category: "Synthetic project", summary: `oxygen.story:${JSON.stringify(source)}` })) })).run();
  const targets = deriveStoryReleaseTargetContents(sources);
  const privacy = await syntheticPrivacyOutput(targets, await readStoryPrivacySourceRedactions(db));
  if (rereview) for (const proposal of privacy.targetProposals) {
    if (!proposal.proposedText.includes("Project Cedar")) continue;
    const original = proposal.proposedText;
    proposal.proposedText = original.replace("Project Cedar", "Cedar project").replace("May 2", "an earlier day");
    proposal.occurrences = [{ originalStartOffset: 0, originalEndOffset: 13,
      proposalStartOffset: 0, proposalEndOffset: 13, category: "project-name" }];
    if (original.includes("May 2")) proposal.occurrences.push({ originalStartOffset: original.indexOf("May 2"),
      originalEndOffset: original.indexOf("May 2") + 5, proposalStartOffset: proposal.proposedText.indexOf("an earlier day"),
      proposalEndOffset: proposal.proposedText.indexOf("an earlier day") + 14, category: "date" });
    privacy.candidates.push({ id: proposal.targetId.replace(/[^a-z0-9-]/g, "-"), reviewState: "needs_confirmation",
      title: "Public synthetic name and date", whyFlagged: "Synthetic old recommendation.",
      uncertaintyReason: "Review the proposed wording.", releaseTargets: [proposal.targetId] });
  }
  privacy.candidates.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (interactive || rereview) for (const candidate of privacy.candidates) {
    candidate.reviewState = "needs_confirmation"; candidate.uncertaintyReason = "Choose the release wording.";
    await db.prepare("INSERT INTO story_privacy_candidates (workflow_run_id,candidate_id,candidate_json) VALUES (?,?,?)")
      .bind(run, candidate.id, JSON.stringify(candidate)).run();
  }
  await db.prepare(`INSERT INTO story_preparation_receipts (workflow_run_id,lane,source_revision,input_digest,
    scope_digest,scope_count,output_digest,output_count,completed_at) VALUES (?,'story_privacy',?,?,?,?,?,?,?)`)
    .bind(run, sourceRevision, seeded.storyPrivacyInputDigest, await storyPreparationDigest(targets.map((target) => target.id)),
      targets.length, await storyPreparationDigest(privacy), targets.length, now).run();
  for (const target of privacy.targetProposals) await db.prepare(`INSERT INTO story_privacy_targets
    (workflow_run_id,target_id,target_content_digest,proposed_text,occurrences_json,selected_text,public_overrides_json,decided_at)
    VALUES (?,?,?,?,?,NULL,'[]',NULL)`).bind(run, target.targetId, target.targetContentDigest, target.proposedText, storyPrivacyProposalRanges(target)).run();
  const reviews = Object.fromEntries(sources.map((source) => [source.key, emptyChapterReview(source)]));
  if (badSecondChapter) {
    const text = sources[1].story.blocks[0].text;
    reviews.b = recordStoryEdit(reviews.b, { storyKey: "b", blockId: "passage", sourceLanguage: "en",
      baseText: text, nextText: `${text} Revenue was 900.`, workingRange: { start: text.length, end: text.length },
      insertedText: " Revenue was 900.", now: 1 }).state;
  }
  const session = createStoryReviewSession(run, reviews, {}, now);
  await db.prepare(`INSERT INTO story_review_sessions (workflow_run_id,state_json,updated_at,server_version) VALUES (?,?,?,1)`)
    .bind(run, JSON.stringify({ sourceRevision, session }), now).run();
  return { run, sourceRevision, sources, session, now };
}

// These fixture phrases explicitly denote the marked source information.
// This is synthetic test authorship, never a runtime semantic classifier.
export function syntheticInheritedMatches(text, sources) {
  const points = Array.from(text);
  return sources.flatMap((source) => {
    const needle = Array.from(source.text), matches = [];
    for (let start = 0; start + needle.length <= points.length; start++) {
      if (needle.every((point, index) => points[start + index] === point)) matches.push({
        sourceRedactionId: source.id, originalStartOffset: start, originalEndOffset: start + needle.length,
        relation: "inherited", reason: "The synthetic target repeats the same marked source information.",
      });
    }
    return matches;
  });
}

export async function syntheticPrivacyOutput(targets, sources = []) {
  const proposals = await Promise.all(targets.map(async (target) => {
    const original = Array.from(target.content), output = [], occurrences = [];
    const matches = syntheticInheritedMatches(target.content, sources);
    for (let start = 0; start < original.length;) {
      const match = matches.filter((value) => value.originalStartOffset === start)
        .sort((left, right) => right.originalEndOffset - left.originalEndOffset)[0];
      if (!match) { output.push(original[start++]); continue; }
      const replacement = Array.from("[Private detail abstracted]");
      occurrences.push({ originalStartOffset: start, originalEndOffset: match.originalEndOffset,
        proposalStartOffset: output.length, proposalEndOffset: output.length + replacement.length, category: sources.find((source) => source.id === match.sourceRedactionId).category });
      output.push(...replacement); start = match.originalEndOffset;
    }
    return { targetId: target.id, targetContentDigest: target.contentDigest || await storyPreparationDigest(target.content),
      proposedText: output.join(""), occurrences, ...(matches.length ? { sourceMatches: matches } : {}) };
  }));
  const changed = proposals.filter((target) => target.occurrences.length).map((target) => target.targetId);
  return { candidates: changed.length ? [{ id: "synthetic-privacy", reviewState: "deterministic",
    title: "Synthetic source privacy", whyFlagged: "This test target repeats explicitly marked synthetic information.",
    uncertaintyReason: null, releaseTargets: changed }] : [], targetProposals: proposals };
}
