import { getD1 } from "../../../db";
import { createZip } from "../../../lib/zip";
import { selectProjectTimeline } from "../../../lib/timeline";

const clean = <T,>(value:string, fallback:T):T => { try{return JSON.parse(value) as T}catch{return fallback} };
type TimelineEvent={id:string;sequence:number;timestamp?:string;project?:string;summary?:string;content?:string;document_id?:string};
type ProjectSummary={primary_project?:string;project_summary?:string;projects?:Array<{name:string;event_count:number;primary?:boolean}>;highlights?:TimelineEvent[]};
export async function GET(){
  const db=await getD1();
  const {results:documents}=await db.prepare(`SELECT id,kind,title,source_user,source_system,source_timestamp,item_count,metadata_json,formatted_summary_json FROM documents ORDER BY source_timestamp,title`).all<Record<string,unknown>>();
  const {results:rows}=await db.prepare(`SELECT id,document_id,sequence,event_type,actor_id,actor_type,timestamp,content,original_json,organization_category,organization_confidence,organization_reason FROM items ORDER BY document_id,sequence`).all<Record<string,unknown>>();
  const docs=documents.map((d)=>({...d,metadata:clean(String(d.metadata_json||"{}"),{}),formatted_summary:clean<ProjectSummary>(String(d.formatted_summary_json||"{}"),{}),metadata_json:undefined,formatted_summary_json:undefined}));
  const items=rows.map((r)=>({...r,original:clean(String(r.original_json||"{}"),{}),original_json:undefined}));
  const primaryProject=docs[0]?.formatted_summary.primary_project||"Unclassified";
  const projectNames=Array.from(new Set(docs.flatMap((d)=>(d.formatted_summary.projects||[]).map((p)=>p.name))));
  const projects=projectNames.map((name)=>({
    name,
    primary:name===primaryProject,
    event_count:docs.reduce((sum,d)=>sum+Number((d.formatted_summary.projects||[]).find((p)=>p.name===name)?.event_count||0),0),
    timeline:selectProjectTimeline(docs.flatMap((d)=>(d.formatted_summary.highlights||[]).filter((event)=>event.project===name).map((event)=>({...event,document_id:String(d.id)})))),
  }));
  const projectMap={schema_version:"1",primary_project:primaryProject,projects};
  const exportedAt=new Date().toISOString();
  const manifest={format:"oxygen-contribution",version:1,exported_at:exportedAt,publication_approved:false,document_count:docs.length,event_count:items.length,notice:"Local review package. Nothing was uploaded by the viewer."};
  const viewer=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Oxygen local review</title><style>body{margin:0;background:#f5f3ed;color:#191b1a;font:14px/1.6 Arial}header{padding:22px 5vw;background:#fffef9;border-bottom:1px solid #dedbd2;position:sticky;top:0}main{max-width:920px;margin:auto;padding:30px}.project,.event{background:#fffef9;border:1px solid #dedbd2;border-radius:14px;padding:20px;margin:14px 0}.meta{color:#71766f;font-size:12px}.event time{font-weight:bold}.tag{color:#3757ff;margin-left:12px}pre{white-space:pre-wrap;font:13px/1.6 Arial}</style><header><b>O₂ Oxygen</b> · Project timelines · local only · nothing uploaded</header><main id="app"></main><script>const P=${JSON.stringify(projectMap).replace(/</g,"\\u003c")};const e=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));document.getElementById('app').innerHTML=P.projects.map(p=>'<section class="project"><div class="meta">'+(p.primary?'PRIMARY PROJECT':'PROJECT')+' · COMBINED ACROSS TRAJECTORIES</div><h1>'+e(p.name)+'</h1><div class="meta">'+p.event_count+' source events · '+p.timeline.length+' timeline events</div>'+p.timeline.map((x,i)=>'<article class="event"><time>'+e(x.timestamp||'Time unavailable')+'</time><span class="tag">'+e(x.project||'')+'</span><h2>'+(i+1)+'. '+e(x.summary||'Project event')+'</h2><pre>'+e(x.content||'')+'</pre><div class="meta">Source: '+e(x.document_id||'')+'</div></article>').join('')+'</section>').join('')</script>`;
  const zip=createZip([
    {name:"manifest.json",data:JSON.stringify(manifest,null,2)},
    {name:"data/documents.json",data:JSON.stringify(docs,null,2)},
    {name:"data/events.json",data:JSON.stringify(items,null,2)},
    {name:"project-map.json",data:JSON.stringify(projectMap,null,2)},
    {name:"review/oxygen-local-viewer.html",data:viewer},
  ]);
  return new Response(zip,{headers:{"content-type":"application/zip","content-disposition":'attachment; filename="oxygen-contribution.zip"',"cache-control":"no-store"}});
}
