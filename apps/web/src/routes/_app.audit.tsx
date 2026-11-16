import { AUDIT_FAMILIES, AUDIT_RESOURCES, AUDIT_RESULTS } from "@dispand/domain/audit/model";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { AuditFilters, auditFilter } from "../components/audit/AuditFilters.tsx";
import { AuditList } from "../components/audit/AuditList.tsx";
import { PageHeader } from "../components/Placeholder.tsx";
import { AuditRetention } from "../components/settings/AuditRetention.tsx";

export const Route = createFileRoute("/_app/audit")({
  component: Audit,
  // The filters live in the URL, so a filtered page survives a reload and can be linked to (a Job's page does).
  validateSearch: z.object({
    actorType: z.enum(["user", "job", "scheduler"]).optional().catch(undefined),
    agentId: z.string().max(200).optional().catch(undefined),
    jobId: z.string().max(200).optional().catch(undefined),
    action: z.enum(AUDIT_FAMILIES).optional().catch(undefined),
    resourceType: z.enum(AUDIT_RESOURCES).optional().catch(undefined),
    result: z.enum(AUDIT_RESULTS).optional().catch(undefined),
    from: z.iso.date().optional().catch(undefined),
    to: z.iso.date().optional().catch(undefined),
  }),
});

/** What the agents' work did and met, newest first (design 6.8). */
function Audit() {
  const { t } = useTranslation("audit");
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <AuditRetention />
      <AuditFilters value={search} onChange={(next) => void navigate({ search: next, replace: true })} />
      <AuditList filter={auditFilter(search)} />
    </>
  );
}
