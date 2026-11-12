import { createFileRoute } from "@tanstack/react-router";
import { MemoryPanel } from "../components/memory/MemoryPanel.tsx";
import { PageHeader } from "../components/Placeholder.tsx";

export const Route = createFileRoute("/_app/settings/memory")({ component: WorkspaceMemory });

function WorkspaceMemory() {
  return (
    <>
      <PageHeader title="Memory" subtitle="What every agent of the workspace reads when its Jobs start." />
      <MemoryPanel where={{ scope: "workspace" }} />
    </>
  );
}
