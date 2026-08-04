"use client";

import { useState } from "react";

export type Probe = {
  id: string; document_id: string; document_kind?: string;
  event_ids: string[]; timestamp?: string; signal: string;
  score: number; turns: number; recap: string; question: string;
  options: Array<{ id: string; text: string }>;
  allow_other: number; allow_skip: number;
  answer_choice?: string | null; answer_text?: string | null; answered_at?: string | null;
};
export type BulkDecision = {
  id: string; kind: string; count: number; question: string;
  default_answer: string; answer?: string | null; answered_at?: string | null;
  evidence_sample: string[];
};
export type ProbeRun = {
  status: string; stage: string; model?: string;
  generated: number; set_aside: number; auto_removed_json?: string;
} | null;

export function ProbePanel(props: {
  run: ProbeRun;
  probes: Probe[];
  bulkDecisions: BulkDecision[];
  busyId: string;
  onAnswer: (id: string, patch: { choice?: string; text?: string; clear?: boolean; bulk?: boolean }) => void;
}) {
  const { run, probes, bulkDecisions, busyId, onAnswer } = props;
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  if (run && run.status === "running") {
    return <div className="redactionPanel">
      <h2>Finding preference moments…</h2>
      <p className="redactionMuted">
        Stage: {run.stage}{run.model ? ` · model ${run.model}` : ""}
      </p>
      <div className="redactionBar"><span style={{ width: "40%" }} /></div>
      <p className="redactionMuted">
        This page refreshes on its own and shows the questions when the pass finishes.
      </p>
    </div>;
  }

  if (!probes.length && !bulkDecisions.length) {
    return <div className="redactionPanel">
      <h2>No preference questions</h2>
      <p className="redactionMuted">
        {run
          ? "The pass found no moment worth asking about. That is a valid result — it does not mean the session was reviewed poorly."
          : "No elicitation pass has been run yet."}
      </p>
    </div>;
  }

  const answered = probes.filter((probe) => probe.answered_at).length;

  return <div className="redactionPanel">
    <h2>Preference probes · {probes.length} question(s) · {answered} answered</h2>
    <p className="redactionNotice">
      Answer only what you actually want recorded. An unanswered or skipped question produces no
      preference — silence is never read as agreement. Answering is not publication approval.
      {run?.set_aside ? ` ${run.set_aside} lower-scoring moment(s) were set aside.` : ""}
    </p>

    {bulkDecisions.length > 0 && <>
      <h3>Judgement calls</h3>
      {bulkDecisions.map((decision) => <div className="probeCard bulk" key={decision.id}>
        <div className="probeMeta">{decision.kind} · {decision.count} passage(s) · default: keep</div>
        <p className="probeQuestion">{decision.question}</p>
        <div className="probeOptions">
          {["remove", "keep", "inspect"].map((choice) => <button
            key={choice}
            className={decision.answer === choice ? "chosen" : ""}
            disabled={busyId === decision.id}
            onClick={() => onAnswer(decision.id, { choice, bulk: true })}
          >{choice}</button>)}
          {decision.answer && <button
            className="probeClear"
            disabled={busyId === decision.id}
            onClick={() => onAnswer(decision.id, { clear: true, bulk: true })}
          >clear</button>}
        </div>
      </div>)}
    </>}

    <h3>Questions</h3>
    {probes.map((probe) => {
      const chosen = probe.answer_choice;
      return <div className={`probeCard ${chosen ? "answered" : ""}`} key={probe.id}>
        <div className="probeMeta">
          {probe.signal} · score {probe.score} · {probe.turns} turn(s) ·
          {" "}<code>{probe.document_id}</code>
          {probe.event_ids.length ? ` · evidence: ${probe.event_ids.join(", ")}` : ""}
        </div>
        <p className="probeRecap">{probe.recap}</p>
        <p className="probeQuestion">{probe.question}</p>
        <div className="probeOptions">
          {probe.options.map((option) => <button
            key={option.id}
            className={chosen === option.id ? "chosen" : ""}
            disabled={busyId === probe.id}
            onClick={() => onAnswer(probe.id, { choice: option.id })}
          >{option.id}. {option.text}</button>)}
          {probe.allow_skip ? <button
            className={chosen === "none" ? "chosen" : ""}
            disabled={busyId === probe.id}
            onClick={() => onAnswer(probe.id, { choice: "none" })}
          >Nothing worth recording here</button> : null}
        </div>
        {probe.allow_other ? <div className="probeOther">
          <input
            placeholder="Something else — type it and press Save"
            value={drafts[probe.id] ?? (chosen === "other" ? probe.answer_text || "" : "")}
            onChange={(event) => setDrafts({ ...drafts, [probe.id]: event.target.value })}
          />
          <button
            disabled={busyId === probe.id || !(drafts[probe.id] || "").trim()}
            onClick={() => onAnswer(probe.id, { choice: "other", text: drafts[probe.id] })}
          >Save</button>
        </div> : null}
        {chosen && <div className="probeAnswered">
          Recorded: {chosen === "other" ? probe.answer_text : chosen === "none" ? "nothing recorded" : chosen}
          <button
            className="probeClear"
            disabled={busyId === probe.id}
            onClick={() => onAnswer(probe.id, { clear: true })}
          >clear</button>
        </div>}
      </div>;
    })}
  </div>;
}
