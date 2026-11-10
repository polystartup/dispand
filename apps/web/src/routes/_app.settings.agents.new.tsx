import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { AgentEditor } from "../components/settings/AgentEditor.tsx";
import { PageHeader } from "../components/Placeholder.tsx";

export const Route = createFileRoute("/_app/settings/agents/new")({
  validateSearch: z.object({ harness: z.string().optional() }),
  component: NewAgent,
});

function NewAgent() {
  const { harness } = Route.useSearch();
  return (
    <>
      <PageHeader title="New agent" subtitle="Give it a job and a harness to run on." />
      <AgentEditor defaultHarnessId={harness} />
    </>
  );
}
