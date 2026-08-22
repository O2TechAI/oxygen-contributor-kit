#!/usr/bin/env python3
"""Oxygen Ingest — minimal local web frontend with progress bars for the ingestion tools.

Stdlib only. Binds 127.0.0.1 (internal only, per team decision 2026-07-29).
Password auth because this is a multi-user machine: the password is generated
on first start into webapp-data/.password (chmod 600) — read it there.

    python3 webapp.py            # http://127.0.0.1:8899

Jobs run the CLI tools as subprocesses and surface their PROGRESS lines.
"""

from __future__ import annotations

import html
import json
import re
import secrets
import subprocess
import sys
import threading
import time
import urllib.parse
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from oxygen_common import configure_utf8_stdio, text_subprocess_options

TOOLS_DIR = Path(__file__).resolve().parent
DATA_DIR = TOOLS_DIR / "webapp-data"
UPLOAD_DIR = DATA_DIR / "uploads"
PASSWORD_FILE = DATA_DIR / ".password"
JOBS_LOG = DATA_DIR / "jobs.jsonl"
HOST, PORT = "127.0.0.1", 8899

SESSIONS: set[str] = set()
JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()
JOB_COUNTER = [0]


def ensure_password() -> str:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    if not PASSWORD_FILE.exists():
        PASSWORD_FILE.write_text(secrets.token_urlsafe(12) + "\n", encoding="utf-8")
        PASSWORD_FILE.chmod(0o600)
    return PASSWORD_FILE.read_text(encoding="utf-8").strip()


PASSWORD = ensure_password()

JOB_TYPES = {
    "repo": {
        "title": "Repo → trajectories",
        "cmd": lambda p: [sys.executable, str(TOOLS_DIR / "collect_repo_trajectories.py"),
                          p["path"]] + (["--agents", p["agents"]] if p.get("agents") else []),
    },
    "anthropic": {
        "title": "claude.ai export → trajectories",
        "cmd": lambda p: [sys.executable, str(TOOLS_DIR / "import_anthropic_export.py"), p["path"]],
    },
    "meeting": {
        "title": "Meeting notes/audio → meeting records",
        "cmd": lambda p: [sys.executable, str(TOOLS_DIR / "import_meeting.py"), p["path"]]
        + (["--title", p["title"]] if p.get("title") else [])
        + (["--language", p["language"]] if p.get("language") else [])
        + (["--model", p["model"]] if p.get("model") else []),
    },
}


def start_job(job_type: str, params: dict) -> dict:
    with JOBS_LOCK:
        JOB_COUNTER[0] += 1
        job_id = f"job-{JOB_COUNTER[0]:04d}"
    job = {
        "id": job_id, "type": job_type, "title": JOB_TYPES[job_type]["title"],
        "params": params, "status": "running", "pct": 0, "stage": "start",
        "detail": "", "log": [], "output": None, "started_at": time.strftime("%H:%M:%S"),
    }
    with JOBS_LOCK:
        JOBS[job_id] = job

    def run() -> None:
        try:
            cmd = JOB_TYPES[job_type]["cmd"](params)
        except KeyError as error:
            job.update(status="failed", detail=f"missing param {error}")
            return
        try:
            process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                cwd=str(TOOLS_DIR),
                **text_subprocess_options(),
            )
        except OSError as error:
            job.update(status="failed", detail=str(error))
            return
        for line in process.stdout:
            line = line.rstrip("\n")
            job["log"].append(line)
            del job["log"][:-400]
            if line.startswith("PROGRESS "):
                try:
                    record = json.loads(line[len("PROGRESS "):])
                except json.JSONDecodeError:
                    continue
                job["stage"] = record.get("stage", job["stage"])
                job["detail"] = record.get("detail", "")
                if "pct" in record:
                    job["pct"] = record["pct"]
                if record.get("stage") == "error":
                    job["status"] = "failed"
            elif line.startswith("{"):
                try:
                    job["output"] = json.loads(line).get("output")
                except json.JSONDecodeError:
                    pass
        code = process.wait()
        if job["status"] != "failed":
            job["status"] = "done" if code == 0 else "failed"
            if code == 0:
                job["pct"] = 100
        with JOBS_LOCK:
            with JOBS_LOG.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps({k: v for k, v in job.items() if k != "log"},
                                        ensure_ascii=False) + "\n")

    threading.Thread(target=run, daemon=True).start()
    return job


PAGE = """<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Oxygen Ingest</title><style>
:root{--bg:#f6f7f9;--card:#fff;--line:#e3e6ea;--text:#1c2430;--mut:#64707f;--acc:#3557b7;--ok:#2e7d4f;--bad:#b3372e}
*{box-sizing:border-box}body{margin:0;font:15px/1.55 system-ui,'PingFang SC','Noto Sans CJK SC',sans-serif;background:var(--bg);color:var(--text)}
header{background:var(--card);border-bottom:1px solid var(--line);padding:14px 22px;display:flex;justify-content:space-between;align-items:center}
h1{font-size:17px;margin:0}main{max-width:1080px;margin:22px auto;padding:0 16px;display:grid;gap:16px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px}
.card h2{font-size:15px;margin:0 0 4px}.card p{color:var(--mut);font-size:13px;margin:4px 0 12px}
label{display:block;font-size:13px;color:var(--mut);margin:8px 0 3px}
input[type=text],select{width:100%;padding:7px 9px;border:1px solid var(--line);border-radius:7px;font:inherit}
button{margin-top:12px;padding:8px 14px;border:0;border-radius:7px;background:var(--acc);color:#fff;font:inherit;cursor:pointer}
button:disabled{opacity:.5;cursor:wait}
.jobs{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px}
.job{border-top:1px solid var(--line);padding:10px 0}.job:first-of-type{border-top:0}
.jhead{display:flex;flex-wrap:wrap;min-width:0;justify-content:space-between;gap:8px;font-size:14px}
.jhead>span:first-child{overflow-wrap:anywhere;min-width:0}
.badge{font-size:12px;padding:1px 8px;border-radius:10px;background:#e8ecf5;color:var(--acc)}
.badge.done{background:#e2f2e8;color:var(--ok)}.badge.failed{background:#f8e4e2;color:var(--bad)}
.bar{height:8px;background:#edf0f4;border-radius:5px;margin:7px 0 4px;overflow:hidden}
.bar i{display:block;height:100%;background:var(--acc);border-radius:5px;transition:width .4s}
.detail{font-size:12.5px;color:var(--mut);word-break:break-all}
.out{font-size:12.5px;color:var(--ok);word-break:break-all}
details{margin-top:5px}summary{font-size:12.5px;color:var(--mut);cursor:pointer}
pre{background:#0f1720;color:#cfe0f1;font-size:11.5px;padding:10px;border-radius:7px;max-height:260px;overflow:auto;white-space:pre-wrap}
#toast{position:fixed;right:18px;bottom:18px;display:flex;flex-direction:column;gap:8px}
.toast{background:#1c2430;color:#fff;padding:10px 14px;border-radius:8px;font-size:13.5px;box-shadow:0 4px 14px rgba(0,0,0,.25);max-width:380px}
.toast.err{background:var(--bad)}.empty{color:var(--mut);font-size:13.5px;padding:8px 0}
a{color:var(--acc)}</style></head><body>
<header><h1>Oxygen Ingest <span style="color:var(--mut);font-weight:400;font-size:13px">· 内网 127.0.0.1 · 进度看板</span></h1>
<a href="/logout" style="font-size:13px">退出</a></header>
<main>
<div class="cards">
<form class="card" data-type="repo">
<h2>① Repo → Trajectories</h2><p>指定服务器上的 repo 路径,自动收集 .claude/.codex 里与它相关的全部会话与 memory,导出 v0.2 trajectory。</p>
<label>Repo 路径</label><input type="text" name="path" placeholder="/path/to/repository" required>
<label>采集范围</label><select name="agents"><option value="claude,codex">Claude + Codex</option>
<option value="claude">仅 Claude</option><option value="codex">仅 Codex</option></select>
<button>开始收集</button>
</form>
<form class="card" data-type="anthropic">
<h2>② claude.ai 导出 → Trajectories</h2><p>上传 claude.ai 导出的 zip / conversations.json(或填服务器路径),整理为 trajectory + memory。</p>
<label>上传导出文件</label><input type="file" name="file" accept=".zip,.json">
<label>或服务器上的路径</label><input type="text" name="path" placeholder="/path/to/conversations.json">
<button>开始导入</button>
</form>
<form class="card" data-type="meeting">
<h2>③ 会议记录 / 录音 → Meeting</h2><p>上传 txt/md 转写稿或 m4a/wav/mp3 录音(或填路径)。录音在本机 CPU 转写,可选说话人分离。</p>
<label>上传文件</label><input type="file" name="file" accept=".txt,.md,.m4a,.wav,.mp3,.flac">
<label>或服务器上的路径</label><input type="text" name="path" placeholder="/path/to/meeting.m4a">
<label>标题(可选)</label><input type="text" name="title" placeholder="0730 组会">
<label>语言</label><select name="language"><option value="">自动检测</option>
<option value="zh">中文</option><option value="en">English</option></select>
<button>开始整理</button>
</form>
</div>
<div class="jobs"><h2 style="font-size:15px;margin:0 0 6px">任务进度</h2>
<div id="joblist"><div class="empty">还没有任务。上面提交一个试试。</div></div></div>
</main>
<div id="toast"></div>
<script>
function toast(msg,err){const t=document.createElement('div');t.className='toast'+(err?' err':'');
t.textContent=msg;document.getElementById('toast').appendChild(t);setTimeout(()=>t.remove(),4200)}
async function submitForm(f){const type=f.dataset.type;const btn=f.querySelector('button');
btn.disabled=true;btn.textContent='提交中…';
try{const params={};for(const el of f.querySelectorAll('input[type=text],select'))if(el.value)params[el.name]=el.value;
const fileInput=f.querySelector('input[type=file]');
if(fileInput&&fileInput.files.length){const fd=new FormData();fd.append('file',fileInput.files[0]);
toast('正在上传 '+fileInput.files[0].name+' …');
const up=await fetch('/upload',{method:'POST',body:fd});const uj=await up.json();
if(!up.ok)throw new Error(uj.error||'上传失败');params.path=uj.path;toast('上传完成 ✓')}
if(!params.path)throw new Error('请上传文件或填写服务器路径');
const r=await fetch('/api/jobs',{method:'POST',headers:{'Content-Type':'application/json'},
body:JSON.stringify({type,params})});const j=await r.json();
if(!r.ok)throw new Error(j.error||'提交失败');
toast('任务 '+j.id+' 已开始');f.reset();refresh()}
catch(e){toast(e.message,true)}
finally{btn.disabled=false;btn.textContent=btn.dataset.label}}
document.querySelectorAll('form.card').forEach(f=>{const b=f.querySelector('button');
b.dataset.label=b.textContent;
f.addEventListener('submit',e=>{e.preventDefault();submitForm(f)})});
function esc(s){const d=document.createElement('span');d.textContent=s||'';return d.innerHTML}
async function refresh(){try{const r=await fetch('/api/jobs');if(r.status===401){location='/';return}
const jobs=await r.json();const el=document.getElementById('joblist');
if(!jobs.length){el.innerHTML='<div class="empty">还没有任务。上面提交一个试试。</div>';return}
el.innerHTML=jobs.map(j=>`<div class="job"><div class="jhead">
<span><b>${j.id}</b> · ${esc(j.title)} <span style="color:var(--mut)">${esc((j.params&&j.params.path)||'')}</span></span>
<span class="badge ${j.status}">${j.status==='running'?'运行中':j.status==='done'?'完成':'失败'} ${j.pct}%</span></div>
<div class="bar"><i style="width:${j.pct}%"></i></div>
<div class="detail">[${esc(j.stage)}] ${esc(j.detail)}</div>
${j.output?`<div class="out">输出:${esc(j.output)}</div>`:''}
<details><summary>日志</summary><pre>${esc((j.log||[]).slice(-60).join('\\n'))}</pre></details>
</div>`).join('')}catch(e){}}
refresh();setInterval(refresh,1500);
</script></body></html>"""

LOGIN = """<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Oxygen Ingest · 登录</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{font:15px system-ui,sans-serif;background:#f6f7f9;display:grid;place-items:center;height:100vh;margin:0}
form{background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:26px;width:300px}
h1{font-size:16px;margin:0 0 12px}input{width:100%;box-sizing:border-box;padding:8px;border:1px solid #e3e6ea;border-radius:7px;font:inherit}
button{margin-top:12px;width:100%;padding:9px;border:0;border-radius:7px;background:#3557b7;color:#fff;font:inherit;cursor:pointer}
.err{color:#b3372e;font-size:13px;margin-top:8px}</style></head><body>
<form method="post" action="/login"><h1>Oxygen Ingest</h1>
<input type="password" name="password" placeholder="密码(见 tools/webapp-data/.password)" autofocus>
<button>登录</button>__ERR__</form></body></html>"""


class Handler(BaseHTTPRequestHandler):
    server_version = "OxygenIngest/1.0"

    def log_message(self, fmt, *args):
        pass

    # -- helpers -------------------------------------------------------------
    def authed(self) -> bool:
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        token = cookie.get("oxysession")
        return bool(token and token.value in SESSIONS)

    def send_html(self, body: str, status=HTTPStatus.OK, headers=None):
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, value, status=HTTPStatus.OK):
        data = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def read_body(self, limit=200 * 1024 * 1024) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length > limit:
            raise ValueError("body too large")
        return self.rfile.read(length)

    # -- routes --------------------------------------------------------------
    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/logout":
            SESSIONS.clear()
            self.send_html("", HTTPStatus.FOUND, {"Location": "/", "Set-Cookie":
                           "oxysession=; Path=/; Max-Age=0"})
            return
        if not self.authed():
            self.send_html(LOGIN.replace("__ERR__", ""),
                           HTTPStatus.UNAUTHORIZED if path.startswith("/api") else HTTPStatus.OK)
            return
        if path == "/":
            self.send_html(PAGE)
        elif path == "/api/jobs":
            with JOBS_LOCK:
                jobs = sorted(JOBS.values(), key=lambda j: j["id"], reverse=True)
                self.send_json([{**j, "log": j["log"][-60:]} for j in jobs])
        else:
            self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/login":
            form = urllib.parse.parse_qs(self.read_body().decode("utf-8"))
            if form.get("password", [""])[0] == PASSWORD:
                token = secrets.token_urlsafe(24)
                SESSIONS.add(token)
                self.send_html("", HTTPStatus.FOUND, {"Location": "/", "Set-Cookie":
                               f"oxysession={token}; Path=/; HttpOnly; SameSite=Strict"})
            else:
                self.send_html(LOGIN.replace("__ERR__", '<div class="err">密码不对</div>'),
                               HTTPStatus.UNAUTHORIZED)
            return
        if not self.authed():
            self.send_json({"error": "not logged in"}, HTTPStatus.UNAUTHORIZED)
            return
        if path == "/api/jobs":
            try:
                request = json.loads(self.read_body().decode("utf-8"))
                job_type = request.get("type")
                params = request.get("params") or {}
                if job_type not in JOB_TYPES:
                    raise ValueError(f"unknown job type: {job_type}")
                source = Path(str(params.get("path", ""))).expanduser()
                if not source.exists():
                    raise ValueError(f"路径不存在: {source}")
                params["path"] = str(source.resolve())
                job = start_job(job_type, params)
                self.send_json({"id": job["id"]})
            except (ValueError, json.JSONDecodeError) as error:
                self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        elif path == "/upload":
            try:
                filename, data = self.parse_upload()
                safe = re.sub(r"[^\w.一-鿿-]+", "_", filename)[-80:] or "upload"
                dest = UPLOAD_DIR / f"{int(time.time())}-{safe}"
                dest.write_bytes(data)
                self.send_json({"path": str(dest), "bytes": len(data)})
            except ValueError as error:
                self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        else:
            self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    def parse_upload(self) -> tuple[str, bytes]:
        content_type = self.headers.get("Content-Type", "")
        match = re.search(r"boundary=([^;]+)", content_type)
        if not match:
            raise ValueError("expected multipart/form-data")
        boundary = ("--" + match.group(1).strip('"')).encode("utf-8")
        body = self.read_body()
        for part in body.split(boundary):
            if b"filename=" not in part:
                continue
            header_blob, _, content = part.partition(b"\r\n\r\n")
            name_match = re.search(rb'filename="([^"]*)"', header_blob)
            if not name_match or not name_match.group(1):
                continue
            content = content.rsplit(b"\r\n", 1)[0]
            if not content:
                raise ValueError("空文件")
            return name_match.group(1).decode("utf-8"), content
        raise ValueError("没有找到上传文件")


def main() -> int:
    configure_utf8_stdio()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Oxygen Ingest on http://{HOST}:{PORT}  (password: {PASSWORD_FILE})", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
