import { createFileRoute } from "@tanstack/react-router";
import { AuditList } from "../components/audit/AuditList.tsx";
import { PageHeader } from "../components/Placeholder.tsx";
import { AuditRetention } from "../components/settings/AuditRetention.tsx";

export const Route = createFileRoute("/_app/audit")({ component: Audit });

/** What the agents' work did and met, newest first (design 6.8). */
function Audit() {
  return (
    <>
      <PageHeader title="Audit" subtitle="What your agents did, when, and how it ended. Ids, names and counts only: never what they read or wrote." />
      <AuditRetention />
      <AuditList />
    </>
  );
}
