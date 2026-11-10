import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "../components/Placeholder.tsx";
import { RunList, WorkflowsTabs } from "../components/workflow/Runs.tsx";

export const Route = createFileRoute("/_app/settings/workflows/runs/")({ component: AllRuns });

/** Every workflow's latest runs. */
function AllRuns() {
  return (
    <>
      <PageHeader title="Workflows" subtitle="Chain agent steps behind a button or a chat." />
      <WorkflowsTabs />
      <RunList />
    </>
  );
}
