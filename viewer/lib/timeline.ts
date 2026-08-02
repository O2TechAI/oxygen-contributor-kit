export type TimelineCandidate = {
  id:string; timestamp?:string; summary?:string; content?:string;
  project?:string; documentId?:string; document_id?:string;
};

function score(event:TimelineCandidate){
  const text=`${event.summary || ""} ${event.content || ""}`.toLowerCase();
  let value=Math.min(text.length,1200)/120;
  for(const term of ["decision","defines","completes","fixes","launch","export","baseline","privacy","timeline","决定","完成","修复","定义","验证","导出"]){
    if(text.includes(term)) value+=4;
  }
  return value;
}

/** Select 10–40 representative milestones while preserving the full time span. */
export function selectProjectTimeline<T extends TimelineCandidate>(events:T[],maximum=40):T[]{
  const ordered=[...events].sort((a,b)=>String(a.timestamp||"").localeCompare(String(b.timestamp||"")));
  if(ordered.length<=maximum) return ordered;
  const selected:T[]=[];
  for(let bucket=0;bucket<maximum;bucket++){
    const start=Math.floor(bucket*ordered.length/maximum);
    const end=Math.max(start+1,Math.floor((bucket+1)*ordered.length/maximum));
    const slice=ordered.slice(start,end);
    selected.push(slice.reduce((best,event)=>score(event)>score(best)?event:best));
  }
  return selected.sort((a,b)=>String(a.timestamp||"").localeCompare(String(b.timestamp||"")));
}
