import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { AuditList } from "../components/audit/AuditList.tsx";
import { PageHeader } from "../components/Placeholder.tsx";
import { AuditRetention } from "../components/settings/AuditRetention.tsx";

export const Route = createFileRoute("/_app/audit")({ component: Audit });

/** What the agents' work did and met, newest first (design 6.8). */
function Audit() {
  const { t } = useTranslation("audit");
  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <AuditRetention />
      <AuditList />
    </>
  );
}
