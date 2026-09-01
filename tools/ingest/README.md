# Oxygen Ingest Tools

三个本地数据接入工具。目标:把「repo 相关的 agent 会话」「claude.ai 导出的聊天记录」「会议记录/录音」整理到用户明确指定的 Oxygen run 目录(canonical trajectory / meeting records)。所有产出保持 `review_status=pending` / `publication_approved=false`，不会复制到共享目录。

Agent 对接说明见 [oxygen-ingest-project-history](../../skills/oxygen-ingest-project-history/SKILL.md)；给最终用户的导出/导入指南见 [EXPORT-GUIDE.md](EXPORT-GUIDE.md)。

## 目录

```text
tools/
├── collect_repo_trajectories.py   # ① repo → 相关 Claude/Codex 会话 + memory → canonical trajectory
├── import_anthropic_export.py     # ② claude.ai 导出(zip/conversations.json)→ trajectory + memory
├── import_meeting.py              # ③ 会议 txt/md/m4a → meeting.json + raw.md + timestamped.txt
├── transcribe_diarize.py          #    本机 CPU 语音转写(faster-whisper)+ 可选说话人分离(pyannote)
├── oxygen_common.py               # 公共:进度协议 / 凭据文件黑名单 / hash
├── vendor/                        # canonical Oxygen trajectory 提取器
├── .venv-audio/                   # ASR 依赖(faster-whisper)
└── out/                           # 所有产出(未脱敏,内部)
```

## 用法

```bash
# 唯一 UI 是 canonical Viewer；它只绑定本机 loopback
python3 skills/oxygen-organize-review-export/scripts/run_local_review.py --target /path/to/repo

# ① 指定 repo,收集相关 trajectory(含 memory)
python3 tools/ingest/collect_repo_trajectories.py /path/to/repo --out work/repo-run

# ② 导入本机已有的 claude.ai 数据导出
python3 tools/ingest/import_anthropic_export.py ~/Downloads/export.zip --out work/claude-run

# ③ 会议:文本直接进;录音先本机转写再进
python3 tools/ingest/import_meeting.py meeting.txt --out work/meeting-run --title "0730 组会" --date 2026-07-30
python3 tools/ingest/import_meeting.py meeting.m4a --out work/meeting-run --language zh --date 2026-08-30
```

Windows PowerShell 使用同一套 UTF-8 工具链，无需 `python -X utf8`、`chcp` 或 WSL：

```powershell
python .\tools\ingest\collect_repo_trajectories.py `
  "D:\Coding Projects\my-project" --out "out\repo-run"
python .\tools\ingest\import_anthropic_export.py `
  "D:\Downloads\export.zip" --out "out\claude-run"
python .\tools\ingest\import_meeting.py "D:\Meetings\meeting.txt" `
  --out "out\meeting-run" --title "项目会议" --date "2026-08-30"
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
python3 tools/ingest/import_meeting.py xx.m4a --out work/meeting-run --hf-token hf_xxx --date 2026-08-30
```

没有 token 时管线不会失败:输出单说话人转写稿并在 `transcript.json.warnings` 里明确标注。

Windows 的可选音频解释器路径是 `.venv-audio\Scripts\python.exe`。音频依赖必须安装在
这个项目本地环境中，不要全局安装；文本会议导入不需要音频包。临时 token 用完后立即清理：

```powershell
$AudioPython = ".\tools\ingest\.venv-audio\Scripts\python.exe"
& $AudioPython -c "import faster_whisper"  # 只检查可用性
$env:HF_TOKEN = "<current-user-token>"
try {
  python .\tools\ingest\import_meeting.py "D:\Meetings\meeting.m4a" `
    --out "out\meeting-run" --language zh --date "2026-08-30"
}
finally {
  Remove-Item Env:\HF_TOKEN -ErrorAction SilentlyContinue
}
```

## 格式对接

- trajectory 输出遵守唯一的 unversioned Oxygen contract;
- 会议输出的 `timestamped.txt`(`M:SSSpeaker A 文本`)就是 `tools/ingest/import_meeting.py` 的输入格式,可直接入库 Inline;
- claude.ai 导出的 schema 无官方保证,解析器是容错的,坏结构会记进 `index.json.warnings` 而不是崩;拿到真实导出后请再验证一轮。

## 隐私

- 凭据类文件(auth.json / .credentials.json / 私钥 / token)按名字黑名单**永不采集**(`oxygen_common.SENSITIVE_NAME_RE`);
- 文本经 vendored 提取器的掩码(API token/密码模式、家目录路径 → `<USER_HOME>`);
- 自动过滤≠发布批准:所有产出 `publication_approved=false`,公开前必须过 redaction 流水线 + 原贡献者终审;
- 三个接入工具只写入显式 `--out` 目录；音频转写使用自动清理的操作系统临时目录。产出含未脱敏内容，不要复制到共享盘或网络位置。
