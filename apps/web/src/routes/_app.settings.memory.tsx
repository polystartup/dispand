import { createFileRoute } from "@tanstack/react-router";
import { MemoryPanel } from "../components/memory/MemoryPanel.tsx";
import { useTranslation } from "react-i18next";
import { PageHeader } from "../components/Placeholder.tsx";

export const Route = createFileRoute("/_app/settings/memory")({ component: WorkspaceMemory });

function WorkspaceMemory() {
  const { t } = useTranslation("settings");
  return (
    <>
      <PageHeader title={t("memory.title")} subtitle={t("memory.subtitle")} />
      <MemoryPanel where={{ scope: "workspace" }} />
    </>
  );
}
