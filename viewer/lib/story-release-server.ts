import type { getLocalDatabase } from "../db";
import { computeSourceDigest, redactionReleaseError } from "./redaction-pass.mjs";
import {
  buildReviewedStoryRelease,
  sanitizeReviewedStoryRelease,
  serializeReviewedStoryRelease,
} from "./story-release.ts";
import {
  STORY_REVIEW_SESSION_SCHEMA,
  hydrateStoryReviewSession,
} from "./story-review-session.ts";
import {
  parseStoredStoryReviewSession,
  readActiveStoryReviewPackage,
  readStoryReviewSessionRecord,
} from "./story-review-session-server.ts";
import {
  selectReservedStorySourceItems,
  canonicalAuthorityJson,
  validateCurrentStorySourcePackage,
  type StoryCandidateRow,
  type StoryEvidenceRow,
} from "./story-readiness.ts";
import { parseStorySource, type StorySource } from "./timeline.ts";
import { hasRequiredProbePresentation } from "./preference-presentation.ts";
import { isWorkflowRunId } from "./workflow-progress.ts";
import {
  captureStoryReleasePrivacySnapshot,
  capturePackageReleasePrivacySnapshot,
  computeReviewGateDigest,
  validateReleaseSourcePrivacyReceipt,
  type ReleaseSnapshotTestOptions,
} from "./release-privacy-snapshot.ts";
import {
  readStoryPrivacyAuthority,
} from "./story-privacy-authority.ts";
import {
  validActivatedSourceRevision,
  validNonnegativeAuthorityCounter,
} from "./authority-validation.mjs";
import {
  canonicalPreferenceInsightScope,
  insightAuthorityValue,
  storyPreparationDigest,
  type PreferenceInsightBinding,
} from "./story-preparation.ts";

type ReleaseDatabase = Awaited<ReturnType<typeof getLocalDatabase>>;

export type PreferenceLifecycleStatus="active"|"inactive"|"needs_update"|"history"|"legacy";
export type PreferenceQuestionBinding=PreferenceInsightBinding&{id:string;questionDigest:string};
export type PreferenceLifecycleState={generationScope:PreferenceInsightBinding[];questions:PreferenceQuestionBinding[];history:Record<string,unknown>[]};
export type PreferenceLifecycleRow={workflow_run_id?:string;source_revision?:number;active_story_digest?:string|null;
  story_session_version?:number;state_json?:string;state_digest?:string;};
const preferenceDigest=/^[0-9a-f]{64}$/u;
const preferenceObject=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==="object"&&!Array.isArray(value);
const preferenceExact=(value:Record<string,unknown>,keys:string[])=>Object.keys(value).length===keys.length&&keys.every((key)=>Object.hasOwn(value,key));
const preferenceBinding=(value:unknown):value is PreferenceInsightBinding=>preferenceObject(value)
  &&preferenceExact(value,["storyKey","insightId","insightAuthorityDigest"])
  &&[value.storyKey,value.insightId].every((item)=>typeof item==="string"&&Boolean(item.trim()))&&typeof value.insightAuthorityDigest==="string"
  &&preferenceDigest.test(value.insightAuthorityDigest);
export const preferenceQuestionValue=(probe:Record<string,unknown>)=>({question:probe.question,
  options:probe.options??JSON.parse(String(probe.options_json||"[]")),presentations:probe.presentations??JSON.parse(String(probe.presentations_json||"{}"))});
export const preferenceQuestionDigest=(probe:Record<string,unknown>)=>storyPreparationDigest(preferenceQuestionValue(probe));
export async function preferenceInsightScope(stories:StorySource[]){return canonicalPreferenceInsightScope(await Promise.all(stories.flatMap((story)=>story.insights.map(async(insight)=>({
  storyKey:story.key,insightId:insight.id,insightAuthorityDigest:await storyPreparationDigest(insightAuthorityValue(story.key,insight))})))));}
export async function createPreferenceLifecycleState(generationScope:PreferenceInsightBinding[],
  probes:Array<PreferenceInsightBinding&{id:string;question:unknown;options?:unknown;presentations?:unknown}>,
  history:Record<string,unknown>[]=[]) {
  const questions=await Promise.all(probes.map(async(probe)=>({id:probe.id,storyKey:probe.storyKey,insightId:probe.insightId,
    insightAuthorityDigest:probe.insightAuthorityDigest,questionDigest:await preferenceQuestionDigest(probe as Record<string,unknown>)})));
  return {generationScope,questions,history};
}
export function parsePreferenceLifecycleState(value:unknown):PreferenceLifecycleState|null {
  if(!preferenceObject(value)||!preferenceExact(value,["generationScope","questions","history"])
    ||!Array.isArray(value.generationScope)||!value.generationScope.every(preferenceBinding)
    ||!Array.isArray(value.questions)||!Array.isArray(value.history)||!value.history.every(preferenceObject))return null;
  const questions:PreferenceQuestionBinding[]=[];for(const question of value.questions){
    if(!preferenceObject(question))return null;
    const binding={storyKey:question.storyKey,insightId:question.insightId,insightAuthorityDigest:question.insightAuthorityDigest};
    if(!preferenceExact(question,["id","storyKey","insightId","insightAuthorityDigest","questionDigest"])
      ||!preferenceBinding(binding)||typeof question.id!=="string"||!question.id.trim()
      ||typeof question.questionDigest!=="string"||!preferenceDigest.test(question.questionDigest))return null;
    questions.push(question as PreferenceQuestionBinding);
  }
  const scopeKeys=value.generationScope.map((item)=>`${item.storyKey}\0${item.insightId}`),scope=new Map(value.generationScope.map(
    (item)=>[`${item.storyKey}\0${item.insightId}`,item.insightAuthorityDigest])),questionKeys=questions.map(
    (item)=>`${item.storyKey}\0${item.insightId}`);
  if(new Set(scopeKeys).size!==scopeKeys.length||new Set(questionKeys).size!==questionKeys.length
    ||new Set(questions.map((item)=>item.id)).size!==questions.length
    ||canonicalAuthorityJson(value.generationScope)!==canonicalAuthorityJson(canonicalPreferenceInsightScope(value.generationScope))
    ||questions.some((item)=>scope.get(`${item.storyKey}\0${item.insightId}`)!==item.insightAuthorityDigest))return null;
  return {generationScope:value.generationScope,questions,history:value.history};
}
export async function validatePreferenceLifecycleRow(row:PreferenceLifecycleRow|null,workflowRunId:string,sourceRevision:number,
  activeStoryDigest:string|null){
  if(!row||row.workflow_run_id!==workflowRunId||Number(row.source_revision)!==sourceRevision
    ||row.active_story_digest!==activeStoryDigest||typeof row.state_json!=="string"
    ||typeof row.state_digest!=="string"||!preferenceDigest.test(row.state_digest))return null;
  try{const state=parsePreferenceLifecycleState(JSON.parse(row.state_json));return state&&await storyPreparationDigest(state)===row.state_digest
    ?state:null;}catch{return null;}
}
export async function projectPreferenceLifecycle(stories:StorySource[],
  reviews:ReturnType<typeof hydrateStoryReviewSession>["chapterReviews"]|null,
  state:PreferenceLifecycleState,probes:Record<string,unknown>[]){
  const identities=(values:PreferenceInsightBinding[])=>values.map(({storyKey,insightId})=>({storyKey,insightId}));
  if(canonicalAuthorityJson(identities(await preferenceInsightScope(stories)))
    !==canonicalAuthorityJson(identities(state.generationScope)))return null;
  const byId=new Map(probes.map((probe)=>[String(probe.id),probe])),projected=[];
  for(const question of state.questions){
    const probe=byId.get(question.id),story=stories.find((item)=>item.key===question.storyKey),insight=story?.insights.find(
      (item)=>item.id===question.insightId);if(!story||!insight)return null;
    if(!probe||!hasRequiredProbePresentation(preferenceQuestionValue(probe).presentations,story.language))return null;
    const review=reviews?.[question.storyKey]?.sourceInsightReviews[question.insightId];
    let status:PreferenceLifecycleStatus="inactive";
    if(review?.decision==="accepted"&&review.resolution==="applied"&&review.appliedVersion===review.version){
      const content=review.editedContent?{...insight,...review.editedContent,id:insight.id}:insight;
      const current=await storyPreparationDigest(insightAuthorityValue(question.storyKey,content));
      const questionCurrent=probe&&await preferenceQuestionDigest(probe)===question.questionDigest;
      status=current===question.insightAuthorityDigest&&questionCurrent?"active":"needs_update";
    }
    projected.push({...probe,...question,language:story.language,lifecycle_status:status,lifecycle_key:`current:${question.id}`});
  }
  return projected;
}
const taggedPreference=(row:Record<string,unknown>,status:"history"|"legacy",key:string)=>
  ({...row,lifecycle_status:status,lifecycle_key:key});
export async function readCurrentPreferenceLifecycle(db:ReleaseDatabase,workflowRunId:string){
  const queries=[readActiveStoryReviewPackage(db,workflowRunId),db.prepare(`SELECT workflow_run_id,source_revision,
    active_story_digest,story_session_version,state_json,state_digest FROM preference_lifecycle_authorities
    WHERE workflow_run_id=?`).bind(workflowRunId).first<PreferenceLifecycleRow>(),
  readStoryReviewSessionRecord(db,workflowRunId),db.prepare("SELECT * FROM probes ORDER BY score DESC,created_at,id").all<Record<string,unknown>>(),
  db.prepare("SELECT active_story_digest FROM workflow_runs WHERE id=?").bind(workflowRunId)
    .first<{active_story_digest?:string}>()] as const;
  const [{active,candidateRows,validation},row,record,probeResult,run]=await Promise.all(queries);
  const legacy=probeResult.results.map((probe)=>taggedPreference(probe,"legacy",`legacy:${String(probe.id)}`));
  if(!active.ready||active.sourceRevision===null||!validation||typeof run?.active_story_digest!=="string"
    ||!preferenceDigest.test(run.active_story_digest))return {ok:false as const,probes:[]};
  const stories=candidateRows.map((item)=>parseStorySource(item.summary));if(stories.some((story)=>!story))
    return {ok:false as const,probes:legacy};
  const exactStories=stories.flatMap((story)=>story?[story]:[]);
  const state=await validatePreferenceLifecycleRow(row,workflowRunId,active.sourceRevision,run.active_story_digest);
  if(!state)return {ok:false as const,probes:legacy};
  const reviews=record.session&&record.sourceRevision===active.sourceRevision
    ?hydrateStoryReviewSession(record.session,workflowRunId,exactStories).chapterReviews:null;
  const current=await projectPreferenceLifecycle(exactStories,reviews,state,probeResult.results);if(!current)
    return {ok:false as const,probes:legacy};
  const currentIds=new Set(state.questions.map((item)=>item.id));
  const history=state.history.map((probe,index)=>taggedPreference(probe,"history",
    `history:${index}:${String(probe.id)}`));
  const unbound=probeResult.results.filter((probe)=>!currentIds.has(String(probe.id)))
    .map((probe)=>taggedPreference(probe,"legacy",`legacy:${String(probe.id)}`));
  return {ok:true as const,active,stories:exactStories,record,reviews,row:row!,state,current,
    probes:[...current,...history,...unbound]};
}

type ReleaseRunRow = {
  id?: string;
  story_generation_status?: string;
  story_source_revision?: number;
  active_story_digest?: string;
};

type ReleaseItemRow = {
  id: string;
  document_id: string;
  sequence?: number;
  event_type?: string | null;
  actor_id?: string | null;
  actor_type?: string | null;
  timestamp?: string | null;
  content?: string;
  organization_reason?: string;
};

type ReleaseSessionRow = {
  state_json?: string;
  updated_at?: string;
  server_version?: number;
};

type ReleaseSessionRecord = {
  session: ReturnType<typeof parseStoredStoryReviewSession>["session"];
  serverVersion: number;
  sourceRevision: number | null;
  persistedAt: string | null;
};

export type ServerOwnedReleaseRequest = {
  workflowRunId: string;
  serverVersion: number;
  sourceRevision: number;
};

export const RELEASE_ERROR = {
  requestInvalid: "RELEASE_REQUEST_INVALID",
  runConflict: "RELEASE_RUN_CONFLICT",
  storyNotReady: "RELEASE_STORY_NOT_READY",
  versionConflict: "RELEASE_VERSION_CONFLICT",
  sourceConflict: "RELEASE_SOURCE_CONFLICT",
  sessionMissing: "RELEASE_SESSION_MISSING",
  reviewIncomplete: "RELEASE_REVIEW_INCOMPLETE",
  stateInvalid: "RELEASE_STATE_INVALID",
  privacyConflict: "RELEASE_PRIVACY_CONFLICT",
  preparationInvalid: "RELEASE_PREPARATION_INVALID",
  storyPrivacyPending: "RELEASE_STORY_PRIVACY_PENDING",
  preferencePending: "RELEASE_PREFERENCE_PENDING",
  releaseConfirmationRequired: "RELEASE_CONFIRMATION_REQUIRED",
} as const;

export type ReleaseErrorCode = typeof RELEASE_ERROR[keyof typeof RELEASE_ERROR];

type ReleaseFailure = {
  ok: false;
  code: ReleaseErrorCode;
  serverVersion?: number;
  sourceRevision?: number;
};

type ReleaseSuccess = {
  ok: true;
  story: NonNullable<ReturnType<typeof sanitizeReviewedStoryRelease>>;
  serializedStory: string;
  preferenceProbeIds: string[];
  binding: {
    workflowRunId: string;
    activeStoryDigest: string;
    sourceRevision: number;
    serverVersion: number;
    reviewGateDigest: string;
  };
};

export type ServerOwnedReleaseResult = ReleaseSuccess | ReleaseFailure;

type ReleaseReconstructionOptions = ReleaseSnapshotTestOptions & {
  allowUnsetReleaseConfirmation?: boolean;
};

const REQUEST_KEYS = new Set(["workflowRunId", "serverVersion", "sourceRevision"]);
const validCounter = (value: unknown): value is number => (
  typeof value === "number" && validNonnegativeAuthorityCounter(value)
);
const validSourceRevision = (value: unknown): value is number => (
  typeof value === "number" && validActivatedSourceRevision(value)
);
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseServerOwnedReleaseRequest(value: unknown): ServerOwnedReleaseRequest | null {
  if (!isRecord(value)
    || Object.keys(value).length !== REQUEST_KEYS.size
    || Object.keys(value).some((key) => !REQUEST_KEYS.has(key))
    || !isWorkflowRunId(value.workflowRunId)
    || !validCounter(value.serverVersion)
    || !validSourceRevision(value.sourceRevision)) return null;
  return {
    workflowRunId: value.workflowRunId,
    serverVersion: value.serverVersion,
    sourceRevision: value.sourceRevision,
  };
}

function failure(
  code: ReleaseErrorCode,
  metadata: { serverVersion?: number; sourceRevision?: number } = {},
): ReleaseFailure {
  return { ok: false, code, ...metadata };
}

const sameKeys = (left: string[], right: string[]) => left.length === right.length
  && new Set(left).size === left.length
  && new Set(right).size === right.length
  && left.every((key) => right.includes(key));

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const digestPattern = /^[0-9a-f]{64}$/;
const corePreparationLanes = ["insight", "preference", "story"];
const preparationLanes = [...corePreparationLanes, "story_privacy"];

function exactTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

async function validPreparationAndPreference(
  snapshot: Awaited<ReturnType<typeof captureStoryReleasePrivacySnapshot>>,
  workflowRunId: string,
  sourceRevision: number,
  sources: NonNullable<ReturnType<typeof parseStorySource>>[],
  reviews: ReturnType<typeof hydrateStoryReviewSession>["chapterReviews"],
  activeStoryDigest: string,
) {
  const receipts = snapshot.preparationReceiptRows;
  const lanes = receipts.map((row) => String(row.lane));
  const exactBootstrap = sameKeys(lanes, preparationLanes);
  const exactCurrentImport = sameKeys(lanes, corePreparationLanes)
    && snapshot.storyPrivacyAuthorityRows.length === 1;
  if (!exactBootstrap && !exactCurrentImport) {
    return false;
  }
  for (const receipt of receipts) {
    if (receipt.workflow_run_id !== workflowRunId
      || !preparationLanes.includes(String(receipt.lane))
      || Number(receipt.source_revision) !== sourceRevision
      || !digestPattern.test(String(receipt.input_digest || ""))
      || !digestPattern.test(String(receipt.scope_digest || ""))
      || !digestPattern.test(String(receipt.output_digest || ""))
      || !validCounter(Number(receipt.scope_count))
      || !validCounter(Number(receipt.output_count))
      || !exactTimestamp(receipt.completed_at)) return false;
  }
  const preferenceReceipt = receipts.find((row) => row.lane === "preference")!;
  const probeRun = snapshot.probeRun;
  if (!probeRun || probeRun.workflow_run_id !== workflowRunId || probeRun.id !== workflowRunId
    || Number(probeRun.source_revision) !== sourceRevision
    || probeRun.status !== "complete" || probeRun.stage !== "preference" || probeRun.model !== null
    || probeRun.input_digest !== preferenceReceipt.input_digest
    || probeRun.output_digest !== preferenceReceipt.output_digest
    || Number(probeRun.output_count) !== Number(preferenceReceipt.output_count)
    || !validCounter(Number(probeRun.output_count))
    || Number(probeRun.output_count) !== snapshot.probeRows.length + snapshot.bulkRows.length
    || snapshot.bulkRows.some((row) => row.answer === null || row.answer === undefined
      || !exactTimestamp(row.answered_at))) return null;
  const state = await validatePreferenceLifecycleRow(
    snapshot.preferenceLifecycleRows[0] || null, workflowRunId, sourceRevision, activeStoryDigest,
  );
  if (!state || !sameKeys(state.questions.map((item) => item.id),
    snapshot.probeRows.map((item) => String(item.id)))) return null;
  const current = await projectPreferenceLifecycle(sources, reviews, state, snapshot.probeRows);
  if (!current || current.some((row) => row.lifecycle_status === "needs_update")) return null;
  const active = current.filter((row) => row.lifecycle_status === "active");
  return active.every((row) => "answer_choice" in row && "answered_at" in row
    && Boolean(row.answer_choice) && exactTimestamp(row.answered_at))
    ? active.map((row) => String(row.id)) : null;
}

function exactReleaseConfirmationBinding(
  snapshot: Awaited<ReturnType<typeof captureStoryReleasePrivacySnapshot>>,
  request: ServerOwnedReleaseRequest,
  reviewGateDigest: string,
) {
  const row = snapshot.releaseConfirmation;
  return snapshot.releaseConfirmationRows.length === 1
    && row?.workflow_run_id === request.workflowRunId
    && row.review_gate_digest === reviewGateDigest
    && exactTimestamp(row.confirmed_at);
}

function sameReleaseConfirmation(
  left: Awaited<ReturnType<typeof captureStoryReleasePrivacySnapshot>>,
  right: Awaited<ReturnType<typeof captureStoryReleasePrivacySnapshot>>,
) {
  const a = left.releaseConfirmationRows;
  const b = right.releaseConfirmationRows;
  return a.length === b.length && a.every((row, index) => (
    row.workflow_run_id === b[index]?.workflow_run_id
    && row.review_gate_digest === b[index]?.review_gate_digest
    && row.confirmed_at === b[index]?.confirmed_at
  ));
}

function readReleaseSessionRecord(row: ReleaseSessionRow | null): ReleaseSessionRecord {
  if (!row) return { session: null, serverVersion: 0, sourceRevision: null, persistedAt: null };
  let session: ReleaseSessionRecord["session"] = null;
  let sourceRevision: number | null = null;
  try {
    const stored = JSON.parse(String(row.state_json || ""));
    const parsed = parseStoredStoryReviewSession(stored);
    sourceRevision = parsed.sourceRevision;
    session = parsed.session;
  } catch {
    // Malformed state remains fail-closed while bounded CAS metadata is retained.
  }
  return {
    session,
    serverVersion: validCounter(row.server_version) ? row.server_version : 0,
    sourceRevision,
    persistedAt: typeof row.updated_at === "string" && row.updated_at ? row.updated_at : null,
  };
}

/** Reconstruct the only POST-eligible reviewed Story from the exact activated
 * candidate, current Privacy source, and source-bound durable review session. */
export async function reconstructReviewedStoryReleaseFromDatabase(
  db: ReleaseDatabase,
  input: unknown,
  options: ReleaseReconstructionOptions = {},
): Promise<ServerOwnedReleaseResult> {
  const request = parseServerOwnedReleaseRequest(input);
  if (!request) return failure(RELEASE_ERROR.requestInvalid);

  const initialSnapshot = await captureStoryReleasePrivacySnapshot(db, request.workflowRunId);
  if (initialSnapshot.authorityRows.length !== 1
    || initialSnapshot.authorityRows[0]?.id !== request.workflowRunId) {
    return failure(RELEASE_ERROR.runConflict);
  }

  const run = initialSnapshot.run as ReleaseRunRow | null;
  const record = readReleaseSessionRecord(initialSnapshot.session as ReleaseSessionRow | null);
  const redactionJob = initialSnapshot.redactionJob;

  const candidateSourceRevision = run?.story_source_revision;
  const activeSourceRevision = validSourceRevision(candidateSourceRevision)
    ? candidateSourceRevision
    : null;
  const boundedMetadata = {
    serverVersion: record.serverVersion,
    ...(activeSourceRevision === null ? {} : { sourceRevision: activeSourceRevision }),
  };
  if (!run || run.story_generation_status !== "ready_for_human_review"
    || activeSourceRevision === null) {
    return failure(RELEASE_ERROR.storyNotReady, boundedMetadata);
  }
  if (request.sourceRevision !== activeSourceRevision) {
    return failure(RELEASE_ERROR.sourceConflict, boundedMetadata);
  }
  if (!record.persistedAt) return failure(RELEASE_ERROR.sessionMissing, boundedMetadata);
  if (!record.session || record.session.schema !== STORY_REVIEW_SESSION_SCHEMA) {
    return failure(RELEASE_ERROR.stateInvalid, boundedMetadata);
  }
  if (request.serverVersion !== record.serverVersion) {
    return failure(RELEASE_ERROR.versionConflict, boundedMetadata);
  }
  if (record.sourceRevision !== activeSourceRevision) {
    return failure(RELEASE_ERROR.sourceConflict, boundedMetadata);
  }

  const items = initialSnapshot.itemRows as ReleaseItemRow[];
  const currentSourceDigest = await computeSourceDigest(items);
  if (!(await validateReleaseSourcePrivacyReceipt(
    initialSnapshot,
    request.workflowRunId,
    activeSourceRevision,
    currentSourceDigest,
  )) || redactionReleaseError(
    redactionJob,
    currentSourceDigest,
    initialSnapshot.redactionReviewRows,
    activeSourceRevision,
  )) {
    return failure(RELEASE_ERROR.storyNotReady, boundedMetadata);
  }

  const candidateItems = selectReservedStorySourceItems(items);
  const candidateRows: StoryCandidateRow[] = candidateItems.map((item) => ({
    id: item.id,
    documentId: item.document_id,
    sequence: item.sequence,
    timestamp: item.timestamp,
    summary: String(item.organization_reason || ""),
  }));
  const evidenceRows: StoryEvidenceRow[] = items.map((item) => ({
    id: item.id,
    documentId: item.document_id,
    eventType: item.event_type,
    actorId: item.actor_id,
    actorType: item.actor_type,
  }));
  const validation = await validateCurrentStorySourcePackage(
    db,
    request.workflowRunId,
    candidateRows,
    evidenceRows,
  );
  if (!validation.ok || !run.active_story_digest
    || await sha256(validation.canonicalCandidate) !== run.active_story_digest) {
    return failure(RELEASE_ERROR.stateInvalid, boundedMetadata);
  }

  const sources = candidateRows.map((row) => parseStorySource(row.summary));
  if (sources.some((source) => !source)) return failure(RELEASE_ERROR.stateInvalid, boundedMetadata);
  const exactSources = sources.flatMap((source) => source ? [source] : []);
  const expectedKeys = exactSources.map((source) => source.key);
  if (expectedKeys.length !== validation.chapterCount
    || !sameKeys(expectedKeys, Object.keys(record.session.chapterReviews))) {
    return failure(RELEASE_ERROR.reviewIncomplete, boundedMetadata);
  }

  const hydrated = hydrateStoryReviewSession(
    record.session,
    request.workflowRunId,
    exactSources,
  );
  if (!sameKeys(expectedKeys, Object.keys(hydrated.chapterReviews))
    || expectedKeys.some((key) => hydrated.chapterReviews[key]?.stage !== "human_confirmed")) {
    return failure(RELEASE_ERROR.reviewIncomplete, boundedMetadata);
  }
  const storyPrivacy = await readStoryPrivacyAuthority(db, request.workflowRunId);
  if (!storyPrivacy.ok || storyPrivacy.authority.sourceRevision !== activeSourceRevision
    || storyPrivacy.authority.activeStoryDigest !== run.active_story_digest
    || storyPrivacy.authority.status === "preparation_required") {
    return failure(RELEASE_ERROR.preparationInvalid, boundedMetadata);
  }
  if (storyPrivacy.authority.targets.some((target) => target.selectedText === null)) {
    return failure(RELEASE_ERROR.storyPrivacyPending, boundedMetadata);
  }
  const preferenceProbeIds = await validPreparationAndPreference(
    initialSnapshot,
    request.workflowRunId,
    activeSourceRevision,
    exactSources,
    hydrated.chapterReviews,
    String(run.active_story_digest),
  );
  if (!preferenceProbeIds) return failure(RELEASE_ERROR.preferencePending, boundedMetadata);
  const targetById = new Map(storyPrivacy.authority.targets.map((target) => (
    [target.targetId, target]
  )));
  let projectionInvalid = targetById.size !== storyPrivacy.authority.targets.length;
  const built = buildReviewedStoryRelease(exactSources, hydrated.chapterReviews, {
    project: (target, copy) => {
      const choice = targetById.get(target);
      if (!choice || choice.originalText !== copy || choice.selectedText === null) {
        projectionInvalid = true;
        return "";
      }
      return choice.selectedText;
    },
  });
  if (projectionInvalid) return failure(RELEASE_ERROR.preparationInvalid, boundedMetadata);
  const story = sanitizeReviewedStoryRelease(built);
  const serializedStory = serializeReviewedStoryRelease(story);
  if (!story || !serializedStory || story.chapters.length !== expectedKeys.length) {
    return failure(RELEASE_ERROR.reviewIncomplete, boundedMetadata);
  }
  const initialPackageSnapshot = await capturePackageReleasePrivacySnapshot(db);
  const reviewGateDigest = await computeReviewGateDigest(
    initialSnapshot,
    initialPackageSnapshot.digest,
    storyPrivacy.authority,
    serializedStory,
  );
  if (!options.allowUnsetReleaseConfirmation
    && !exactReleaseConfirmationBinding(initialSnapshot, request, reviewGateDigest)) {
    return failure(RELEASE_ERROR.releaseConfirmationRequired, boundedMetadata);
  }
  await options.beforeFinalPrivacyCheck?.();
  const finalSnapshot = await captureStoryReleasePrivacySnapshot(db, request.workflowRunId);
  const finalPackageSnapshot = await capturePackageReleasePrivacySnapshot(db);
  if (finalSnapshot.digest !== initialSnapshot.digest
    || !sameReleaseConfirmation(initialSnapshot, finalSnapshot)
    || finalPackageSnapshot.digest !== initialPackageSnapshot.digest
    || (!options.allowUnsetReleaseConfirmation
      && !exactReleaseConfirmationBinding(finalSnapshot, request, reviewGateDigest))) {
    return failure(RELEASE_ERROR.privacyConflict, boundedMetadata);
  }
  return {
    ok: true,
    story,
    serializedStory,
    preferenceProbeIds,
    binding: {
      workflowRunId: request.workflowRunId,
      activeStoryDigest: String(run.active_story_digest),
      sourceRevision: request.sourceRevision,
      serverVersion: request.serverVersion,
      reviewGateDigest,
    },
  };
}

export async function reconstructReviewedStoryRelease(input: unknown) {
  const request = parseServerOwnedReleaseRequest(input);
  if (!request) return failure(RELEASE_ERROR.requestInvalid);
  const { getLocalDatabase: getRuntimeDatabase } = await import("../db/index.ts");
  return reconstructReviewedStoryReleaseFromDatabase(await getRuntimeDatabase(), request);
}

const messages: Record<ReleaseErrorCode, string> = {
  [RELEASE_ERROR.requestInvalid]: "Invalid reviewed Story release request",
  [RELEASE_ERROR.runConflict]: "Reviewed Story workflow run is not current",
  [RELEASE_ERROR.storyNotReady]: "Reviewed Story release is not ready",
  [RELEASE_ERROR.versionConflict]: "Reviewed Story session version changed",
  [RELEASE_ERROR.sourceConflict]: "Reviewed Story source changed",
  [RELEASE_ERROR.sessionMissing]: "Reviewed Story session is missing",
  [RELEASE_ERROR.reviewIncomplete]: "Reviewed Story review is incomplete",
  [RELEASE_ERROR.stateInvalid]: "Reviewed Story release state is invalid",
  [RELEASE_ERROR.privacyConflict]: "Release Privacy state changed during assembly",
  [RELEASE_ERROR.preparationInvalid]: "Story preparation authority is invalid",
  [RELEASE_ERROR.storyPrivacyPending]: "Story Privacy decisions are incomplete",
  [RELEASE_ERROR.preferencePending]: "Preference answers are incomplete",
  [RELEASE_ERROR.releaseConfirmationRequired]: "Final release confirmation is required",
};

export function releaseErrorResponse(result: ReleaseFailure) {
  const status = result.code === RELEASE_ERROR.requestInvalid ? 400 : 409;
  return Response.json({
    error: messages[result.code],
    code: result.code,
    ...(result.serverVersion === undefined ? {} : { serverVersion: result.serverVersion }),
    ...(result.sourceRevision === undefined ? {} : { sourceRevision: result.sourceRevision }),
  }, { status });
}
