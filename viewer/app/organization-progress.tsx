"use client";

type Status = {
  status: string; stage: string; completed: number; total: number;
  percent: number; documentCount: number; warnings: string[];
};

export function OrganizationProgress({ status, error }: { status: Status | null; error: string }) {
  const percent = status?.percent || 0;
  return <main className="organizationPage">
    <div className="organizationCard">
      <div className="organizationBrand"><span className="brandMark">O₂</span> Oxygen</div>
      <div className="organizationKicker">Local preparation</div>
      <h1>Organizing your project history</h1>
      <p className="organizationIntro">
        Oxygen is separating mixed project work, finding the primary project, and building its timeline.
        Nothing is uploaded during this step.
      </p>
      <div className="progressTrack" aria-label="Organization progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} role="progressbar">
        <div style={{ width: `${percent}%` }} />
      </div>
      <div className="progressMeta">
        <strong>{percent}%</strong>
        <span>{status ? `${status.completed.toLocaleString()} of ${status.total.toLocaleString()} events` : "Preparing organizer…"}</span>
      </div>
      <div className="organizationStages">
        {["Discover projects", "Assign project labels", "Build main timeline", "Ready to review"].map((label, index) =>
          <div className={percent >= [0, 1, 96, 100][index] ? "active" : ""} key={label}>
            <i>{percent >= [0, 1, 96, 100][index] ? "✓" : index + 1}</i><span>{label}</span>
          </div>)}
      </div>
      {status?.status === "empty" && <div className="organizationNotice">Import trajectories to begin organizing.</div>}
      {error && <div className="organizationError">{error}</div>}
    </div>
  </main>;
}
