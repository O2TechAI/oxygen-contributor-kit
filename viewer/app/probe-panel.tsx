"use client";

import { useState } from "react";
import {
  resolveBulkPreferencePresentation,
  resolveProbePresentation,
  type BulkPreferencePresentations,
  type ProbePresentations,
} from "../lib/preference-presentation";
import type { StoryLanguage } from "../lib/timeline";

export type Probe = {
  id: string; document_id: string; document_kind?: string;
  storyKey?: string; insightId?: string; lifecycle_key?: string;
  lifecycle_status?: "active"|"inactive"|"needs_update"|"history"|"legacy";
  event_ids: string[]; timestamp?: string; signal: string;
  score: number; turns: number; recap: string; question: string;
  options: Array<{ id: string; text: string }>;
  presentations?: ProbePresentations;
  allow_other: number; allow_skip: number;
  answer_choice?: string | null; answer_text?: string | null; answered_at?: string | null;
};
export type BulkDecision = {
  id: string; kind: string; count: number; question: string;
  presentations?: BulkPreferencePresentations;
  default_answer: string; answer?: string | null; answered_at?: string | null;
  evidence_sample: string[];
};
export type ProbeRun = {
  status: string; stage: string; model?: string;
  generated: number; set_aside: number; auto_removed_json?: string;
} | null;

const preferenceUi = {
  en: {
    running: "Finding preference moments…", stage: "Stage", model: "model",
    runningNote: "This page refreshes on its own and shows the questions when the pass finishes.",
    empty: "No preference questions", noFindings: "The pass found no moment worth asking about. That is a valid result — it does not mean the session was reviewed poorly.",
    noRun: "No elicitation pass has been run yet.", title: "Preference probes", questions: "questions", answered: "answered",
    notice: "Answer only what you actually want recorded. An unanswered or skipped question produces no preference — silence is never read as agreement. Answering is not publication approval.",
    setAside: "lower-scoring moments were set aside.", judgements: "Judgement calls", passages: "passages", defaultKeep: "default: keep",
    choices: { remove: "remove", keep: "keep", inspect: "inspect" }, questionList: "Questions", score: "score", turns: "turns", evidence: "evidence",
    skip: "Nothing worth recording here", other: "Something else — type it and press Save", save: "Save", recorded: "Recorded", nothing: "nothing recorded", clear: "clear",
    localeMissing: "This preference does not yet have reviewed English display copy. Its answer state is unchanged.",
    stale: "Needs update", inactive: "Inactive", history: "History", legacy: "Legacy",
    staleHelp: "Run the Toolkit Agent Preference regeneration export → validation → import flow.",
    inactiveHelp: "Accept and apply the linked AI Insight to activate this question.",
    historyHelp: "This archived version is read-only and does not affect release.",
    legacyHelp: "Run a full current Preference refresh; this pre-lifecycle question cannot authorize release.",
    authorityMissing: "No current Preference lifecycle authority exists. Run a full current Preference refresh.", review: "Review linked Insight",
  },
  zh: {
    running: "正在寻找偏好线索…", stage: "阶段", model: "模型",
    runningNote: "此页面会自动刷新；处理完成后会显示问题。",
    empty: "暂无偏好问题", noFindings: "本轮没有发现值得提问的时刻；这是有效结果，并不表示审阅质量不足。",
    noRun: "尚未运行偏好提取。", title: "偏好问题", questions: "个问题", answered: "已回答",
    notice: "只记录你明确愿意保留的偏好。未回答或跳过不会产生偏好，沉默不会被视为同意；回答也不代表发布批准。",
    setAside: "个得分较低的时刻未进入提问。", judgements: "需要判断的事项", passages: "段内容", defaultKeep: "默认：保留",
    choices: { remove: "移除", keep: "保留", inspect: "检查" }, questionList: "问题", score: "得分", turns: "轮次", evidence: "证据",
    skip: "这里没有值得记录的内容", other: "其他内容——输入后点击保存", save: "保存", recorded: "已记录", nothing: "未记录内容", clear: "清除",
    localeMissing: "此偏好尚无经过审阅的中文展示文本；其回答状态未改变。",
    stale: "需要更新", inactive: "未启用", history: "历史版本", legacy: "旧版问题",
    staleHelp: "运行 Toolkit Agent 的偏好重新生成导出 → 校验 → 导入流程。",
    inactiveHelp: "接受并应用关联的 AI 洞察后，此问题才会启用。",
    historyHelp: "此归档版本只读，不影响发布。",
    legacyHelp: "运行完整的当前偏好刷新；旧版问题不能提供发布授权。",
    authorityMissing: "不存在当前偏好生命周期授权。请运行完整的当前偏好刷新。", review: "审阅关联洞察",
  },
} as const;

export function ProbePanel(props: {
  language: StoryLanguage;
  run: ProbeRun;
  lifecycleCurrent: boolean;
  probes: Probe[];
  bulkDecisions: BulkDecision[];
  busyId: string;
  onAnswer: (id: string, patch: { choice?: string; text?: string; clear?: boolean; bulk?: boolean }) => void;
  onReviewInsight: (storyKey: string, insightId: string) => void;
}) {
  const { language, run, lifecycleCurrent, probes, bulkDecisions, busyId, onAnswer, onReviewInsight } = props;
  const labels = preferenceUi[language];
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  if (run && run.status === "running") {
    return <div className="redactionPanel preferencesPanel" lang={language === "zh" ? "zh-CN" : "en"}>
      <h2>{labels.running}</h2>
      <p className="redactionMuted">
        {labels.stage}: {run.stage}{run.model ? ` · ${labels.model} ${run.model}` : ""}
      </p>
      <div className="redactionBar"><span style={{ width: "40%" }} /></div>
      <p className="redactionMuted">{labels.runningNote}</p>
    </div>;
  }

  if (!probes.length && !bulkDecisions.length) {
    return <div className="redactionPanel preferencesPanel" lang={language === "zh" ? "zh-CN" : "en"}>
      <h2>{labels.empty}</h2>
      <p className="redactionMuted">{!lifecycleCurrent ? labels.authorityMissing : run ? labels.noFindings : labels.noRun}</p>
    </div>;
  }

  const answered = probes.filter((probe) => probe.lifecycle_status === "active" && probe.answered_at).length;

  return <div className="redactionPanel preferencesPanel" lang={language === "zh" ? "zh-CN" : "en"}>
    <h2>{labels.title} · {probes.length} {labels.questions} · {answered} {labels.answered}</h2>
    <p className="redactionNotice">
      {labels.notice}{run?.set_aside ? ` ${run.set_aside} ${labels.setAside}` : ""}
    </p>

    {bulkDecisions.length > 0 ? <>
      <h3>{labels.judgements}</h3>
      {bulkDecisions.map((decision) => {
        const display = resolveBulkPreferencePresentation(decision, language);
        if (!display) return <div className="probeCard bulk localeMissing" data-preference-id={decision.id} key={decision.id}>
          <p className="redactionMuted" role="alert">{labels.localeMissing}</p>
        </div>;
        return <div className="probeCard bulk" data-preference-id={decision.id} key={decision.id}>
          <div className="probeMeta">{decision.kind} · {decision.count} {labels.passages} · {labels.defaultKeep}</div>
          <p className="probeQuestion">{display.question}</p>
          <div className="probeOptions">
            {(["remove", "keep", "inspect"] as const).map((choice) => <button
              key={choice}
              className={decision.answer === choice ? "chosen" : ""}
              disabled={busyId === decision.id}
              onClick={() => onAnswer(decision.id, { choice, bulk: true })}
            >{labels.choices[choice]}</button>)}
            {decision.answer ? <button
              className="probeClear"
              disabled={busyId === decision.id}
              onClick={() => onAnswer(decision.id, { clear: true, bulk: true })}
            >{labels.clear}</button> : null}
          </div>
        </div>;
      })}
    </> : null}

    <h3>{labels.questionList}</h3>
    {probes.map((probe) => {
      const display = resolveProbePresentation(probe, language);
      const chosen = probe.answer_choice;
      const inactive = probe.lifecycle_status !== "active";
      const status=probe.lifecycle_status;
      const statusLabel=status==="needs_update"?labels.stale:status==="history"?labels.history:status==="legacy"?labels.legacy:labels.inactive;
      const instruction=status==="needs_update"?labels.staleHelp:status==="history"?labels.historyHelp:status==="legacy"?labels.legacyHelp:labels.inactiveHelp;
      const reviewable=(status==="inactive"||status==="needs_update")&&probe.storyKey&&probe.insightId;
      const statusLine=inactive?<div className="probeMeta" role="status"><b>⚠ {statusLabel}</b> · {instruction} {reviewable
        ?<button onClick={()=>onReviewInsight(probe.storyKey!,probe.insightId!)}>{labels.review}</button>:null}</div>:null;
      if (!display) return <div className="probeCard localeMissing" data-preference-id={probe.id} key={probe.lifecycle_key||probe.id}>
        {statusLine}<div className="probeMeta"><code>{probe.id}</code></div>
        <p className="redactionMuted" role="alert">{labels.localeMissing}</p>
      </div>;
      return <div className={`probeCard ${chosen ? "answered" : ""}`} data-preference-id={probe.id} key={probe.lifecycle_key||probe.id}>
        {statusLine}
        <div className="probeMeta">
          {probe.signal} · {labels.score} {probe.score} · {probe.turns} {labels.turns} ·
          {" "}<code>{probe.document_id}</code>
          {probe.event_ids.length ? ` · ${labels.evidence}: ${probe.event_ids.join(", ")}` : ""}
        </div>
        <p className="probeRecap">{display.recap}</p>
        <p className="probeQuestion">{display.question}</p>
        <div className="probeOptions">
          {display.options.map((option) => <button
            key={option.id}
            className={chosen === option.id ? "chosen" : ""}
            disabled={inactive || busyId === probe.id}
            onClick={() => onAnswer(probe.id, { choice: option.id })}
          >{option.id}. {option.text}</button>)}
          {probe.allow_skip ? <button
            className={chosen === "none" ? "chosen" : ""}
            disabled={inactive || busyId === probe.id}
            onClick={() => onAnswer(probe.id, { choice: "none" })}
          >{labels.skip}</button> : null}
        </div>
        {probe.allow_other ? <div className="probeOther">
          <input
            aria-label={labels.other}
            placeholder={labels.other}
            disabled={inactive || busyId === probe.id}
            value={drafts[probe.id] ?? (chosen === "other" ? probe.answer_text || "" : "")}
            onChange={(event) => setDrafts((current) => ({ ...current, [probe.id]: event.target.value }))}
          />
          <button
            disabled={inactive || busyId === probe.id || !(drafts[probe.id] || "").trim()}
            onClick={() => onAnswer(probe.id, { choice: "other", text: drafts[probe.id] })}
          >{labels.save}</button>
        </div> : null}
        {chosen ? <div className="probeAnswered">
          {labels.recorded}: {chosen === "other" ? probe.answer_text : chosen === "none" ? labels.nothing : chosen}
          <button
            className="probeClear"
            disabled={inactive || busyId === probe.id}
            onClick={() => onAnswer(probe.id, { clear: true })}
          >{labels.clear}</button>
        </div> : null}
      </div>;
    })}
  </div>;
}
