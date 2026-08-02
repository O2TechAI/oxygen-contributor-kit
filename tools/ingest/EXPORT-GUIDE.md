# 用户指南:导出你的 claude.ai 聊天记录(zip)并导入 Oxygen

> 适用对象:想把自己在 claude.ai(网页/App)上的对话贡献给 Oxygen 的用户。
> 整个过程数据只经过你自己的邮箱和电脑;导入工具在本机运行,不上传。

## 一、导出步骤

1. 用浏览器登录 [claude.ai](https://claude.ai)(用你平时聊天的那个账号)。
2. 左下角头像 → **Settings** → **Privacy**(隐私)。
3. 找到 **Export data** / 「导出数据」,点击确认。
4. Anthropic 会把导出结果**发到你账号绑定的邮箱**(不是当场下载)。数据多的话可能要等几分钟到几小时。
5. 打开邮件里的下载链接,得到一个 zip。**链接有时效,收到后尽快下载**。

zip 里包含(已用真实导出验证,2026-07-29):

| 文件 | 内容 | 导入处理 |
|---|---|---|
| `conversations.json` | 全部对话 | 每个对话 → 一条 trajectory |
| `memories.json` | Claude 的记忆(会话记忆摘要 + memory 文件) | → `memory/claudeai-memory/` |
| `projects/*.json` | 每个 Project 一个文件(含知识库文档) | 文档 → `memory/claudeai-projects/` |
| `design_chats/*.json` | Design/Artifacts 会话 | 每个 → 一条 trajectory |
| `users.json` | 邮箱/姓名/手机号 | **不导入**(纯 PII) |

数据量大时导出可能拆成多个 `batch0000`、`batch0001`… zip,每个分别导入即可。

## 二、一直收不到邮件?(常见坑)

你之前在 ChatGPT 上导出收不到邮件,大概率也是下面这些原因,Claude 同样适用:

1. **翻垃圾箱/广告箱**:这类系统邮件极易进 Spam / Promotions(Gmail 尤其),搜索发件人含 `anthropic` 或主题含 `export` 的邮件。
2. **确认邮箱对不对**:用 Google 登录的账号,邮件发到那个 Google 邮箱;公司邮箱可能被网关直接拦截(连垃圾箱都看不到),换个人邮箱的账号试。
3. **等久一点再重试**:导出是异步任务,高峰期可能排队数小时;等 24 小时还没有,再点一次 Export。
4. **链接过期**:如果邮件里链接点开报错,说明过期了,重新发起导出即可。
5. 顺带一提:ChatGPT(OpenAI)的导出在 Settings → Data controls → Export,邮件链接 **24 小时过期**,同样常进垃圾箱——但它的 `conversations.json` 格式和 Claude 不同,目前我们的工具只支持 claude.ai 的导出。

## 三、导入 Oxygen

拿到 zip 后(不用解压也行):

```bash
python3 tools/import_anthropic_export.py ~/Downloads/data-export.zip
```

或在内网前端(`http://127.0.0.1:8899`)的「② claude.ai 导出」卡片直接上传 zip,看进度条。
产出在 `tools/out/claudeai-<时间>/`:每个对话一条 trajectory,Projects 文档进 `memory/`,解析不了的对话会列在 `index.json` 的 `warnings` 里(不会中断)。

## 四、录音转写要说话人分离?(可选)

用**你自己的** Hugging Face token(免费,不要用别人的):

1. 注册 [huggingface.co](https://huggingface.co);
2. 在 [pyannote/speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1) 与 [pyannote/segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0) 页面接受使用条款;
3. Settings → Access Tokens → 新建 **read** token;
4. `python3 tools/import_meeting.py 会议.m4a --hf-token hf_xxx`(或 `export HF_TOKEN=hf_xxx`)。

没有 token 也能转写,只是所有句子都标成 Speaker A。

## 五、隐私提醒

- 导出 zip 含你的全部原始对话,**只放在自己电脑/服务器上,不要传公共盘**;
- 导入产出默认 `publication_approved=false`,进入 Oxygen 公开数据前必须经过脱敏流程和你本人终审。
