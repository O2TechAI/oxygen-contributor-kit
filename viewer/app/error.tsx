"use client";

export default function ErrorBoundary({ reset }: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <main className="organizationPage">
    <section className="organizationCard workflowCard" role="alert" aria-labelledby="viewer-error-title">
      <div className="organizationBrand"><span className="brandMark">O₂</span> Oxygen</div>
      <div className="organizationKicker">Local Viewer</div>
      <h1 id="viewer-error-title">The local Viewer could not finish loading</h1>
      <p className="organizationIntro">No private error details are shown. You can safely try the local load again.</p>
      <button type="button" className="download primary" onClick={reset}>Try again</button>
    </section>
  </main>;
}
