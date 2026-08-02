import { getD1 } from "../../../../db";

function safeJson(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export async function GET(request: Request) {
  void request;
  const db = await getD1();
  const { results: documents } = await db.prepare(
    `SELECT id,kind,title,source_user,source_system,source_timestamp,item_count,
            formatted_summary_json FROM documents ORDER BY source_timestamp,title`
  ).all<Record<string, unknown>>();
  const { results: items } = await db.prepare(
    `SELECT id,document_id,sequence,event_type,actor_id,actor_type,timestamp,content,
            organization_category,organization_confidence,organization_reason
       FROM items ORDER BY document_id,sequence`
  ).all();
  const data = {
    exported_at: new Date().toISOString(),
    documents: documents.map((doc) => ({
      ...doc, formatted_summary: JSON.parse(String(doc.formatted_summary_json || "{}")),
      formatted_summary_json: undefined,
    })),
    items,
  };
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Oxygen local trajectory review</title><style>
  :root{--ink:#191b1a;--muted:#70756e;--paper:#f5f3ed;--panel:#fffef9;--line:#dedbd2;--acid:#d8ff46}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.55 Arial,sans-serif}header{position:sticky;top:0;background:#fffef9ee;border-bottom:1px solid var(--line);padding:18px 5vw;display:flex;align-items:center;gap:16px}header b{font-size:20px}main{display:grid;grid-template-columns:320px 1fr;min-height:calc(100vh - 65px)}aside{border-right:1px solid var(--line);padding:20px}.doc{width:100%;text-align:left;border:1px solid transparent;background:none;padding:12px;border-radius:10px}.doc:hover,.doc.active{background:var(--panel);border-color:var(--line)}section{padding:32px 5vw}.summary{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:18px}.event{border-left:2px solid var(--line);padding:5px 0 18px 16px}.meta{color:var(--muted);font-size:11px;margin-bottom:5px}.tag{display:inline-block;background:#e8e5dc;border-radius:99px;padding:2px 7px;margin-right:7px;font-size:10px}.content{white-space:pre-wrap;word-break:break-word}.empty{color:var(--muted)}@media(max-width:760px){main{display:block}aside{border-right:0;border-bottom:1px solid var(--line)}} </style></head><body>
  <header><b>O₂ Oxygen</b><span>Main-project timeline · nothing has been uploaded</span></header><main><aside id="docs"></aside><section id="view"></section></main>
  <script>const DATA=${safeJson(data)};const docs=document.getElementById('docs'),view=document.getElementById('view');let selected=DATA.documents[0]?.id;
  function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  function render(){docs.innerHTML=DATA.documents.map(d=>'<button class="doc '+(d.id===selected?'active':'')+'" data-id="'+esc(d.id)+'"><b>'+esc(d.title)+'</b><div class="meta">'+esc(d.kind)+' · '+d.item_count+' events</div></button>').join('');
  docs.querySelectorAll('button').forEach(b=>b.onclick=()=>{selected=b.dataset.id;render()});const d=DATA.documents.find(x=>x.id===selected);if(!d){view.innerHTML='<p class="empty">No organized trajectories.</p>';return}
  const timeline=d.formatted_summary?.highlights||[];const projects=d.formatted_summary?.projects||[];view.innerHTML='<h1>'+esc(d.formatted_summary?.primary_project||d.title)+'</h1><div class="summary"><b>Primary project</b><p>'+esc(d.formatted_summary?.project_summary||'')+'</p><p>'+projects.map(x=>esc(x.name)+': '+x.event_count+' events').join(' · ')+'</p><span class="meta">'+esc(d.source_system||'unknown source')+' · '+esc(d.source_timestamp||'unknown date')+'</span></div>'+timeline.map((x,i)=>'<article class="event"><div class="meta">'+(i+1)+' <span class="tag">'+esc(x.project)+'</span>'+esc(x.timestamp||'')+'</div><b>'+esc(x.summary||'')+'</b><div class="content">'+esc(x.content)+'</div></article>').join('')}
  render();</script></body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-disposition": 'attachment; filename="oxygen-local-viewer.html"',
    },
  });
}
