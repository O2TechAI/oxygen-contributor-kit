import { InlineWorkspace } from "./workspace";
import { loadWorkspaceBootstrap } from "../lib/workflow-progress-server";

export default async function Home() {
  const initial = await loadWorkspaceBootstrap();
  return <InlineWorkspace
    initialWorkflow={initial.workflow}
    initialStatus={initial.status}
    initialDocuments={initial.documents}
    initialChapterReviews={initial.chapterReviews}
    initialPrivacyDecisions={initial.privacyDecisions}
    initialStorySessionReadyRunId={initial.storySessionReadyRunId}
  />;
}
