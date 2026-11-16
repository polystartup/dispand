import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { PageHeader } from "../components/Placeholder.tsx";
import { RunList, WorkflowsTabs } from "../components/workflow/Runs.tsx";

export const Route = createFileRoute("/_app/settings/workflows/runs/")({ component: AllRuns });

/** Every workflow's latest runs. */
function AllRuns() {
  const { t } = useTranslation("workflows");
  return (
    <>
      <PageHeader title={t("list.title")} subtitle={t("list.subtitle")} />
      <WorkflowsTabs />
      <RunList />
    </>
  );
}
