import { getLocalDatabase } from "../../../../db";
import { preferenceQuestionDigest, readCurrentPreferenceLifecycle } from "../../../../lib/story-release-server";
import { insightAuthorityValue, storyPreparationDigest } from "../../../../lib/story-preparation";
import { canonicalAuthorityJson } from "../../../../lib/story-readiness";
import { normalizeProbe, preferenceQuestionAuthority } from "../route";
const object=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==="object"&&!Array.isArray(value);
const exact=(value:Record<string,unknown>,keys:string[])=>Object.keys(value).length===keys.length
  &&keys.every((key)=>Object.hasOwn(value,key));
const safeCount=(value:unknown)=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=0;

export async function GET(request: Request) {
  const workflowRunId = new URL(request.url).searchParams.get("workflowRunId") || "";
  const db = await getLocalDatabase();
  const lifecycle = await readCurrentPreferenceLifecycle(db, workflowRunId);
  if (!lifecycle.ok) return Response.json({ error:"Preference authority is unavailable" }, { status:409 });
  const targets = lifecycle.current.filter((probe) => probe.lifecycle_status === "needs_update");
  if (!targets.length) return Response.json({ error:"No accepted stale Preference questions are exportable" }, { status:409 });
  const kinds = new Map((await db.prepare("SELECT id,kind FROM documents").all<{id:string;kind:string}>())
    .results.map((row) => [row.id, row.kind]));
  const lessons = await Promise.all(targets.map(async (target) => {
    const story = lifecycle.stories.find((item) => item.key === target.storyKey)!;
    const source = story.insights.find((item) => item.id === target.insightId)!;
    const edited = lifecycle.reviews?.[target.storyKey]?.sourceInsightReviews[target.insightId]?.editedContent;
    const content = edited ? { ...source, ...edited, id:source.id } : source;
    return { storyKey:target.storyKey, insightId:target.insightId,
      insightAuthorityDigest:await storyPreparationDigest(insightAuthorityValue(target.storyKey, content)),
      ...(content.title === undefined ? {} : { title:content.title }), background:content.background,
      directlyAcquiredExperience:content.directlyAcquiredExperience, principle:content.principle,
      evidence:[content.quote.evidence, ...content.evidence] };
  }));
  const reviewedEvidence = [...new Map(lessons.flatMap((lesson) => lesson.evidence).map((item) => (
    [`${item.documentId}\0${item.eventId}`, { documentId:item.documentId, eventId:item.eventId,
      documentKind:kinds.get(item.documentId) }]
  ))).values()];
  if (reviewedEvidence.some((item) => typeof item.documentKind !== "string")) {
    return Response.json({ error:"Preference evidence authority is stale" }, { status:409 });
  }
  const binding = { workflowRunId, sourceRevision:lifecycle.active.sourceRevision,
    activeStoryDigest:lifecycle.row.active_story_digest, serverVersion:lifecycle.record.serverVersion,
    lifecycleDigest:lifecycle.row.state_digest };
  const draft = { schema:"oxygen.preference-regeneration-context", binding,
    reusableLessons:lessons.map(({ evidence:_evidence, ...lesson }) => lesson),
    insightScope:lessons.map(({ storyKey, insightId, insightAuthorityDigest }) => ({ storyKey, insightId, insightAuthorityDigest })),
    reviewedEvidence, targets:targets.map((item) => ({ id:item.id, storyKey:item.storyKey,
      insightId:item.insightId, previousQuestionDigest:item.questionDigest })) };
  return Response.json({ ...draft, exportDigest:await storyPreparationDigest(draft) });
}

export async function POST(request:Request){
  const body:unknown=await request.json().catch(()=>null);
  if(!object(body)||!exact(body,["schema","binding","targets","probes","receipt","importDigest"])
    ||body.schema!=="oxygen.preference-regeneration-import"||!object(body.binding)||!Array.isArray(body.targets)
    ||!Array.isArray(body.probes)||!object(body.receipt)
    ||!exact(body.receipt,["status","inputDigest","outputDigest","outputCount"])
    ||body.receipt.status!=="complete"||typeof body.importDigest!=="string"||typeof body.receipt.inputDigest!=="string"
    ||typeof body.receipt.outputDigest!=="string"||!safeCount(body.receipt.outputCount))
    return Response.json({error:"Invalid Preference regeneration"},{status:400});
  const binding=body.binding;
  const receipt=body.receipt;
  const importedTargets=body.targets;
  const unsigned={schema:body.schema,binding,targets:importedTargets,probes:body.probes,receipt};
  if(await storyPreparationDigest(unsigned)!==body.importDigest)
    return Response.json({error:"Invalid Preference regeneration digest"},{status:400});
  const normalized=body.probes.map(normalizeProbe);
  if(normalized.some((item)=>!item)||receipt.outputCount!==normalized.length)
    return Response.json({error:"Invalid Preference regeneration"},{status:400});
  const probes=normalized.flatMap((item)=>item?[item]:[]);
  if(await storyPreparationDigest(probes.map(preferenceQuestionAuthority))!==receipt.outputDigest)
    return Response.json({error:"Invalid Preference regeneration digest"},{status:400});
  const db=await getLocalDatabase();
  try{return await db.transaction(async()=>{
    const workflowRunId=String(binding.workflowRunId||"");
    const exported=await GET(new Request(
      `http://127.0.0.1/api/probes/regeneration?workflowRunId=${encodeURIComponent(workflowRunId)}`));
    if(!exported.ok)throw new Error();const context=await exported.json() as Record<string,unknown>;
    if(canonicalAuthorityJson(binding)!==canonicalAuthorityJson(context.binding)
      ||canonicalAuthorityJson(importedTargets)!==canonicalAuthorityJson(context.targets)
      ||receipt.inputDigest!==context.exportDigest)throw new Error();
    const scope=new Map((context.insightScope as Array<Record<string,string>>)
      .map((item)=>[`${item.storyKey}\0${item.insightId}`,item.insightAuthorityDigest]));
    const targets=new Map((context.targets as Array<Record<string,string>>).map((item)=>[`${item.storyKey}\0${item.insightId}`,item]));
    if(probes.length!==targets.size||probes.some((item)=>{
      const target=targets.get(`${item.storyKey}\0${item.insightId}`);
      return !target||target.id!==item.id||scope.get(`${item.storyKey}\0${item.insightId}`)!==item.insightAuthorityDigest;
    }))throw new Error();
    const lifecycle=await readCurrentPreferenceLifecycle(db,workflowRunId);
    if(!lifecycle.ok||binding.sourceRevision!==lifecycle.active.sourceRevision
      ||binding.serverVersion!==lifecycle.record.serverVersion
      ||binding.lifecycleDigest!==lifecycle.row.state_digest)throw new Error();
    const current=new Map(lifecycle.current.map((item)=>[item.id,item]));if(probes.some((item)=>
      current.get(item.id)?.lifecycle_status!=="needs_update"))throw new Error();
    const [documents,items]=await Promise.all([db.prepare("SELECT id,kind FROM documents").all<{id:string;kind:string}>(),
      db.prepare("SELECT id,document_id FROM items").all<{id:string;document_id:string}>()]);
    const kinds=new Map(documents.results.map((item)=>[item.id,item.kind]));
    const owners=new Map(items.results.map((item)=>[item.id,item.document_id]));
    if(probes.some((item)=>kinds.get(item.documentId)!==item.documentKind
      ||item.eventIds.some((id)=>owners.get(id)!==item.documentId)))throw new Error();
    const old=await Promise.all(probes.map((item)=>db.prepare("SELECT * FROM probes WHERE id=?")
      .bind(item.id).first<Record<string,unknown>>()));if(old.some((item)=>!item))throw new Error();
    const digests=await Promise.all(probes.map((item)=>preferenceQuestionDigest(item as unknown as Record<string,unknown>)));
    if(digests.some((digest,index)=>digest===current.get(probes[index].id)?.questionDigest))throw new Error();
    const replacements=new Map(probes.map((item)=>[`${item.storyKey}\0${item.insightId}`,item.insightAuthorityDigest]));
    const generationScope=lifecycle.state.generationScope.map((item)=>({...item,insightAuthorityDigest:
      replacements.get(`${item.storyKey}\0${item.insightId}`)||item.insightAuthorityDigest}));
    const questions=await Promise.all(lifecycle.state.questions.map(async(item)=>{
      const probe=probes.find((candidate)=>candidate.id===item.id);
      return probe?{id:probe.id,storyKey:probe.storyKey,insightId:probe.insightId,
        insightAuthorityDigest:probe.insightAuthorityDigest,questionDigest:await preferenceQuestionDigest(
          probe as unknown as Record<string,unknown>)}:item;
    }));
    const archived=old.map((row,index)=>({...row,storyKey:current.get(probes[index].id)?.storyKey,
      insightId:current.get(probes[index].id)?.insightId,insightAuthorityDigest:current.get(probes[index].id)?.insightAuthorityDigest}));
    const state={generationScope,questions,history:[...lifecycle.state.history,...archived]};
    const stateJson=canonicalAuthorityJson(state),stateDigest=await storyPreparationDigest(state),now=new Date().toISOString();
    for(const item of probes){
      const saved=await db.prepare(`INSERT OR REPLACE INTO probes (id,document_id,document_kind,event_ids_json,timestamp,
        signal,score,turns,recap,question,options_json,presentations_json,allow_other,allow_skip,
        answer_choice,answer_text,answered_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,1,NULL,NULL,NULL,?)`)
        .bind(item.id,item.documentId,item.documentKind,JSON.stringify(item.eventIds),item.timestamp,item.signal,
          item.score,item.turns,item.recap,item.question,JSON.stringify(item.options),JSON.stringify(item.presentations),now).run();
      if(Number(saved.meta.changes)!==1)throw new Error();
    }
    const updated=await db.prepare(`UPDATE preference_lifecycle_authorities SET story_session_version=?,
      state_json=?,state_digest=?,updated_at=? WHERE workflow_run_id=? AND source_revision=?
      AND active_story_digest=? AND state_digest=?`).bind(binding.serverVersion,stateJson,stateDigest,now,
      workflowRunId,binding.sourceRevision,binding.activeStoryDigest,binding.lifecycleDigest).run();
    if(Number(updated.meta.changes)!==1)throw new Error();
    const cleared=await db.prepare("DELETE FROM project_release_confirmations WHERE workflow_run_id=?")
      .bind(workflowRunId).run();
    if(![0,1].includes(Number(cleared.meta.changes)))throw new Error();
    return Response.json({workflowRunId,status:"complete",regenerated:probes.length});
  });}catch{return Response.json({error:"Preference regeneration authority changed"},{status:409});}
}
