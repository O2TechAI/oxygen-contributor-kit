export default function Loading() {
  return <main className="organizationPage">
    <section className="organizationCard workflowCard" role="status" aria-live="polite">
      <div className="organizationBrand"><span className="brandMark">O₂</span> Oxygen</div>
      <div className="organizationKicker">Local workflow</div>
      <h1>Preparing your project workflow</h1>
      <p className="organizationIntro">Loading the current local Viewer. Nothing is uploaded.</p>
      <div className="progressTrack indeterminate" role="progressbar" aria-label="Loading local workflow"><div /></div>
    </section>
  </main>;
}
