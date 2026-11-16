import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { AgentEditor } from "../components/settings/AgentEditor.tsx";
import { useTranslation } from "react-i18next";
import { PageHeader } from "../components/Placeholder.tsx";

export const Route = createFileRoute("/_app/settings/agents/new")({
  validateSearch: z.object({ harness: z.string().optional() }),
  component: NewAgent,
});

function NewAgent() {
  const { t } = useTranslation("agents");
  const { harness } = Route.useSearch();
  return (
    <>
      <PageHeader title={t("new.title")} subtitle={t("new.subtitle")} />
      <AgentEditor defaultHarnessId={harness} />
    </>
  );
}
