# Oxygen Ingest Tools

三个数据接入工具 + 内网进度前端。目标:把「repo 相关的 agent 会话」「claude.ai 导出的聊天记录」「会议记录/录音」统一整理成 Oxygen 的标准格式(trajectory v0.2 / meeting canonical records),全部默认 `review_status=pending` / `publication_approved=false`,发布前必须走隐私终审。

Agent 对接说明(给 AI agent 看的操作手册)见 [SKILL.md](SKILL.md);给最终用户的导出/导入指南见 [EXPORT-GUIDE.md](EXPORT-GUIDE.md)。

## 目录

```text
tools/
├── collect_repo_trajectories.py   # ① repo → 相关 Claude/Codex 会话 + memory → trajectory v0.2
├── import_anthropic_export.py     # ② claude.ai 导出(zip/conversations.json)→ trajectory + memory
├── import_meeting.py              # ③ 会议 txt/md/m4a → meeting.json + raw.md + timestamped.txt
├── transcribe_diarize.py          #    本机 CPU 语音转写(faster-whisper)+ 可选说话人分离(pyannote)
├── webapp.py                      # ④ 内网前端(127.0.0.1:8899,登录 + 进度条)
├── oxygen_common.py               # 公共:进度协议 / 凭据文件黑名单 / hash
├── vendor/                        # Oxygen v0.2 提取器(从 oxygen/scripts 复制,勿改动)
├── .venv-audio/                   # ASR 依赖(faster-whisper)
└── out/                           # 所有产出(未脱敏,内部)
```

## 用法

```bash
# ① 指定 repo,收集相关 trajectory(含 memory)
python3 collect_repo_trajectories.py /path/to/repo            # 产出 out/repo-<name>-<ts>/

# ② 导入 claude.ai 数据导出(设置→Privacy→Export data 邮件里的 zip)
python3 import_anthropic_export.py ~/Downloads/export.zip

# ③ 会议:文本直接进;录音先本机转写再进
python3 import_meeting.py meeting.txt --title "0730 组会"
python3 import_meeting.py meeting.m4a --language zh --hf-token $HF_TOKEN

# ④ 前端(密码首次启动自动生成到 webapp-data/.password)
python3 webapp.py     # → http://127.0.0.1:8899
```

Windows PowerShell 使用同一套 UTF-8 工具链，无需 `python -X utf8`、`chcp` 或 WSL：

```powershell
python .\collect_repo_trajectories.py `
  "D:\Coding Projects\my-project" --out "out\repo-run"
python .\import_anthropic_export.py `
  "D:\Downloads\export.zip" --out "out\claude-run"
python .\import_meeting.py "D:\Meetings\meeting.txt" `
  --out "out\meeting-run" --title "项目会议" --no-publish
python .\webapp.py  # → http://127.0.0.1:8899
```

Codex 会话默认来自用户全局目录 `Path.home() / ".codex" / "sessions"`，Windows 通常是
`C:\Users\<user>\.codex\sessions`。仓库内 `.codex` 是被忽略的 fixture/runtime
目录，不是默认会话存储。只有 recorded cwd 等于目标仓库或位于其子目录的会话才纳入；
父目录、兄弟仓库和仅在正文提到仓库的会话都会排除，因此新 worktree 得到零条结果可能是正常的。

## 说话人分离(diarization)

按团队决定,音频**只在本机 CPU 处理,不出服务器**。转写用 faster-whisper(已装,无需 token)。说话人分离用 pyannote 3.1,模型是 gated:

```bash
.venv-audio/bin/pip install pyannote.audio        # 需要 torch,较大
# 到 https://huggingface.co/pyannote/speaker-diarization-3.1 接受协议,拿 HF token
python3 import_meeting.py xx.m4a --hf-token hf_xxx
```

没有 token 时管线不会失败:输出单说话人转写稿并在 `transcript.json.warnings` 里明确标注。

Windows 的可选音频解释器路径是 `.venv-audio\Scripts\python.exe`。音频依赖必须安装在
这个项目本地环境中，不要全局安装；文本会议导入不需要音频包。临时 token 用完后立即清理：

```powershell
$AudioPython = ".\.venv-audio\Scripts\python.exe"
& $AudioPython -c "import faster_whisper"  # 只检查可用性
$env:HF_TOKEN = "<current-user-token>"
try {
  python .\import_meeting.py "D:\Meetings\meeting.m4a" `
    --out "out\meeting-run" --language zh --no-publish
}
finally {
  Remove-Item Env:\HF_TOKEN -ErrorAction SilentlyContinue
}
```

## 格式对接

- trajectory 输出与 `oxygen/data/team/trajectories/` 完全同构(直接用 Oxygen v0.2 提取器);
- 会议输出的 `timestamped.txt`(`M:SSSpeaker A 文本`)就是 `oxygen/scripts/import_timestamped_meeting.py` 的输入格式,可直接入库 Inline;
- claude.ai 导出的 schema 无官方保证,解析器是容错的,坏结构会记进 `index.json.warnings` 而不是崩;拿到真实导出后请再验证一轮。

## 隐私

- 凭据类文件(auth.json / .credentials.json / 私钥 / token)按名字黑名单**永不采集**(`oxygen_common.SENSITIVE_NAME_RE`);
- 文本经 vendored 提取器的掩码(API token/密码模式、家目录路径 → `<USER_HOME>`);
- 自动过滤≠发布批准:所有产出 `publication_approved=false`,公开前必须过 redaction 流水线 + 原贡献者终审;
- 前端只绑 127.0.0.1 且有密码;`out/` 与 `webapp-data/` 含未脱敏内容,不要放进公网 dropbox(如需共享先 `chgrp oxygen_collab`)。
