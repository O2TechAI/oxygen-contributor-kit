#!/usr/bin/env python3
"""Render a self-contained before/after page for every redaction decision.

This page shows the ORIGINAL text alongside the tagged version. It is a review
artifact for the contributor only and must never be published -- the left-hand
column is exactly the material the redaction pass exists to withhold.
"""
import argparse
import html
import json
import pathlib
import sys

TOOLS_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

from oxygen_utf8 import configure_utf8_stdio

CSS = """
:root{--bg:#faf9f7;--fg:#1a1a1a;--mut:#6b6b6b;--line:#e3e0da;--hit:#ffe08a;--tag:#0a7d4b}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
 font:15px/1.6 ui-sans-serif,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);
 padding:16px 24px;z-index:9}
h1{font-size:19px;margin:0 0 4px}
.sub{color:var(--mut);font-size:13px}
.warn{margin:12px 24px 0;padding:10px 14px;border:1px solid #d9534f;border-radius:6px;
 background:#fff4f4;color:#8a1f1a;font-size:13px}
main{padding:16px 24px 64px}
details{border:1px solid var(--line);border-radius:8px;background:#fff;margin:10px 0}
summary{cursor:pointer;padding:12px 16px;font-weight:600;font-size:14px}
summary .n{color:var(--mut);font-weight:400;margin-left:8px}
.turn{border-top:1px solid var(--line);padding:14px 16px}
.meta{color:var(--mut);font-size:12px;margin-bottom:8px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:900px){.cols{grid-template-columns:1fr}}
.col h4{margin:0 0 6px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--mut)}
pre{margin:0;padding:10px 12px;background:#fbfaf8;border:1px solid var(--line);border-radius:6px;
 white-space:pre-wrap;word-break:break-word;font:13px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace}
mark{background:var(--hit);padding:1px 0}
.tag{color:var(--tag);font-weight:700}
.reasons{margin:10px 0 0;padding:0;list-style:none}
.reasons li{font-size:12.5px;color:var(--mut);padding:4px 0;border-top:1px dashed var(--line)}
.cat{display:inline-block;background:#eef2ee;color:#2c4a3a;border-radius:4px;
 padding:1px 6px;font-size:11px;margin-right:6px}
"""


def mark_original(text: str, spans: list) -> str:
    out, cursor = [], 0
    for span in spans:
        out.append(html.escape(text[cursor:span["start"]]))
        out.append("<mark>" + html.escape(text[span["start"]:span["end"]]) + "</mark>")
        cursor = span["end"]
    out.append(html.escape(text[cursor:]))
    return "".join(out)


def show_tagged(text: str) -> str:
    escaped = html.escape(text)
    return escaped.replace("&lt;redacted category=", '<span class="tag">&lt;redacted category=')\
                  .replace("/&gt;", "/&gt;</span>")


def main() -> int:
    configure_utf8_stdio()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--redacted", type=pathlib.Path, required=True)
    parser.add_argument("--out", type=pathlib.Path, required=True)
    args = parser.parse_args()

    blocks, total_spans, total_turns = [], 0, 0
    for path in sorted(args.redacted.glob("traj-*.json")):
        bundle = json.loads(path.read_text(encoding="utf-8"))
        changed = [t for t in bundle["turns"] if t.get("redactions")]
        if not changed:
            continue
        rows = []
        for turn in changed:
            spans = turn["redactions"]
            total_spans += len(spans)
            total_turns += 1
            reasons = "".join(
                f'<li><span class="cat">{html.escape(s["category"])}</span>'
                f'<strong>{html.escape(s["review_state"])}</strong> &middot; '
                f'{html.escape(s.get("reason") or "")}'
                f'{" &middot; " + html.escape(s["uncertainty_reason"]) if s.get("uncertainty_reason") else ""}'
                f' <em>({html.escape(str(s.get("confidence") or ""))})</em></li>'
                for s in spans)
            rows.append(f"""
<div class="turn">
 <div class="meta">{html.escape(turn["event_id"])} &middot; {html.escape(str(turn.get("role")))}
  &middot; {len(spans)} span(s)</div>
 <div class="cols">
  <div class="col"><h4>原文 (original)</h4><pre>{mark_original(turn["text"], spans)}</pre></div>
  <div class="col"><h4>脱敏后 (tagged)</h4><pre>{show_tagged(turn["redacted_text"])}</pre></div>
 </div>
 <ul class="reasons">{reasons}</ul>
</div>""")
        blocks.append(f"""
<details>
 <summary>{html.escape(bundle["trajectory"])}
  <span class="n">{len(changed)} turn(s) changed</span></summary>
 {"".join(rows)}
</details>""")

    page = f"""<!doctype html><html lang="zh"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>脱敏对照 · Redaction diff</title><style>{CSS}</style>
<header>
 <h1>脱敏对照 · Redaction diff</h1>
 <div class="sub">{total_spans} spans across {total_turns} turns &middot;
  left = original, right = tagged &middot; only changed turns are listed</div>
</header>
<div class="warn"><strong>不要公开这个页面。</strong>左栏是未脱敏原文 —
 publishing this file would defeat the entire redaction pass.
 Best-effort redaction v0.1; no formal anonymity guarantee.</div>
<main>{"".join(blocks)}</main></html>"""

    args.out.write_text(page, encoding="utf-8")
    print(json.dumps({"out": str(args.out), "spans": total_spans,
                      "turns_changed": total_turns}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
