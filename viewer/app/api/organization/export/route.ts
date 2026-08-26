import {
  type ReviewedStoryRelease,
} from "../../../../lib/story-release.ts";
import {
  RELEASE_ERROR,
  reconstructReviewedStoryRelease,
  releaseErrorResponse,
} from "../../../../lib/story-release-server.ts";

function safeSerializedStory(value: string) {
  return value.replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function renderReviewedStoryHtml(serializedStory: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Oxygen reviewed project story</title><style>
  :root{--ink:#191b1a;--muted:#70756e;--paper:#f5f3ed;--panel:#fffef9;--line:#dedbd2;--acid:#d8ff46}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.65 Arial,sans-serif}header{background:#fffef9;border-bottom:1px solid var(--line);padding:18px 5vw;display:flex;align-items:center;gap:16px}header b{font-size:20px}main{max-width:880px;margin:auto;padding:36px 5vw}.chapter{border-bottom:1px solid var(--line);padding:12px 0 34px;margin-bottom:34px}.meta{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.08em}h1,h2{font-family:Georgia,serif}.story p{white-space:pre-wrap}.insight{border-left:3px solid #7868d8;padding-left:14px;margin:24px 0}.empty{color:var(--muted)}</style></head><body>
  <header><b>O₂ Oxygen</b><span>Human-confirmed Final Release Memory · not publication approval</span></header><main id="view"></main>
  <script>const STORY=${safeSerializedStory(serializedStory)};const view=document.getElementById('view');const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const legacy=c=>{const x=c.en;return '<article class="chapter"><div class="meta">Revision '+c.revision+' · '+esc(c.kind)+'</div><h1>'+esc(x.title)+'</h1><p>'+esc(x.overview)+'</p><section class="story"><p>'+esc(x.story.scene)+'</p>'+x.story.reconstruction.map(p=>'<p>'+esc(p)+'</p>').join('')+'<ul>'+x.story.importantDetails.map(p=>'<li>'+esc(p)+'</li>').join('')+'</ul><p>'+esc(x.story.decisionOutcome)+'</p></section>'+x.insights.map(i=>'<aside class="insight"><b>'+esc(i.title)+'</b><p>'+esc(i.noticed)+'</p><p>'+esc(i.lesson)+'</p></aside>').join('')+'</article>'};
  const successor=c=>{const x=c.en;return '<article class="chapter"><div class="meta">'+esc(c.phase.label)+' · Revision '+c.revision+(c.kind?' · '+esc(c.kind):'')+'</div><h1>'+esc(x.title)+'</h1><p>'+esc(x.overview)+'</p>'+x.people.map(p=>'<p><b>'+esc(p.releaseLabel)+'</b> · '+esc(p.role)+' — '+esc(p.description)+'</p>').join('')+'<section class="story">'+x.story.blocks.map(p=>'<p>'+esc(p)+'</p>').join('')+(x.story.uncertainty?'<p>'+esc(x.story.uncertainty)+'</p>':'')+'</section>'+x.insights.map(i=>'<aside class="insight">'+(i.title?'<b>'+esc(i.title)+'</b>':'')+'<p><b>Background</b> '+esc(i.background)+'</p><p><b>Quote</b> '+esc(i.quote)+'</p><p><b>Directly Acquired Experience</b> '+esc(i.directlyAcquiredExperience)+'</p><p><b>Principle</b> '+esc(i.principle)+'</p></aside>').join('')+'</article>'};
  if(!STORY.chapters.length){view.innerHTML='<p class="empty">No Chapter has completed human review yet.</p>'}else{const render=STORY.schema_version==='oxygen.reviewed-story/2'?successor:legacy;view.innerHTML=STORY.chapters.map(render).join('')}</script></body></html>`;
}

const emptyStory = (): ReviewedStoryRelease => ({
  schema_version: "oxygen.reviewed-story/1",
  publication_approved: false,
  chapters: [],
});

export async function GET() {
  return new Response(renderReviewedStoryHtml(JSON.stringify(emptyStory())), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-disposition": 'attachment; filename="oxygen-reviewed-story.html"',
      "cache-control": "no-store",
    },
  });
}

export async function POST(request: Request) {
  const releaseRequest = await request.json().catch(() => null);
  const reconstruction = await reconstructReviewedStoryRelease(releaseRequest);
  if (!reconstruction.ok) return releaseErrorResponse(reconstruction);
  const html = renderReviewedStoryHtml(reconstruction.serializedStory);
  const finalReconstruction = await reconstructReviewedStoryRelease(releaseRequest);
  if (!finalReconstruction.ok) return releaseErrorResponse(finalReconstruction);
  if (finalReconstruction.serializedStory !== reconstruction.serializedStory) {
    return releaseErrorResponse({ ok: false, code: RELEASE_ERROR.stateInvalid });
  }
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-disposition": 'attachment; filename="oxygen-reviewed-story.html"',
      "cache-control": "no-store",
    },
  });
}
