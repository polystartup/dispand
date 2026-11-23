import { AUDIT_FAMILIES, AUDIT_RESOURCES, AUDIT_RESULTS } from "@dispand/domain/audit/model";
import { useQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { useAgentName } from "../../lib/agent-name.ts";
import { type api, orpc } from "../../lib/api.ts";
import { selectClass } from "../data/NewFieldPopover.tsx";

/** What the page keeps in the URL's search parameters: dates are days (`2026-11-12`), the rest as `AuditFilter`. */
export type AuditSearch = Omit<Parameters<typeof api.audit.list>[0], "cursor" | "resourceId" | "from" | "to"> & { from?: string; to?: string };

/** `from` and `to` are local days: the range runs from the first one's start to the second one's end. */
export function auditFilter(search: AuditSearch) {
  const { from, to, ...rest } = search;
  return {
    ...rest,
    ...(from ? { from: new Date(`${from}T00:00:00`).toISOString() } : {}),
    ...(to ? { to: new Date(`${to}T23:59:59.999`).toISOString() } : {}),
  };
}

/** The Audit page's filters: who, which agent, what, on what, how it ended, when, and one Job. */
export function AuditFilters({ value, onChange }: { value: AuditSearch; onChange: (next: AuditSearch) => void }) {
  const { t } = useTranslation("audit");
  const agentName = useAgentName();
  const agents = useQuery(orpc.agents.list.queryOptions());
  const set = (key: keyof AuditSearch) => (e: { target: { value: string } }) => onChange({ ...value, [key]: e.target.value || undefined } as AuditSearch);
  const pick = (name: keyof AuditSearch, label: string, options: [string, string][]) => (
    <label className="flex flex-col gap-1 text-[13px] text-muted">
      {label}
      <select className={selectClass} value={value[name] ?? ""} onChange={set(name)}>
        <option value="">{t("filters.any")}</option>
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
  const date = (name: "from" | "to") => (
    <label className="flex flex-col gap-1 text-[13px] text-muted">
      {t(`filters.${name}`)}
      <input type="date" className={selectClass} value={value[name] ?? ""} onChange={set(name)} />
    </label>
  );
  const actors: [string, string][] = [
    ["user", t("actor.aPerson")],
    ["job", t("actor.aJob")],
    ["agent", t("actor.unattended")],
    ["scheduler", t("actor.scheduler")],
  ];
  const fields = [
    pick("actorType", t("filters.actor"), actors),
    pick("agentId", t("filters.agent"), (agents.data ?? []).map((a) => [a.id, agentName(a)])),
    pick("action", t("filters.action"), AUDIT_FAMILIES.map((f) => [f, t(`family.${f}`, { defaultValue: f })])),
    pick("resourceType", t("filters.resource"), AUDIT_RESOURCES.map((r) => [r, t(`resource.${r}`)])),
    pick("result", t("filters.result"), AUDIT_RESULTS.map((r) => [r, t(`filters.results.${r}`)])),
    date("from"),
    date("to"),
  ];
  return (
    <form aria-label={t("filters.label")} className="mb-6 flex flex-wrap items-end gap-3" onSubmit={(e) => e.preventDefault()}>
      {fields.map((f, i) => (
        <Fragment key={i}>{f}</Fragment>
      ))}
      {value.jobId && (
        <span className="flex items-center gap-2 text-[13px]">
          {t("filters.job", { id: value.jobId })}
          <button type="button" className="text-accent hover:underline" onClick={() => onChange({ ...value, jobId: undefined })}>
            {t("filters.clearJob")}
          </button>
        </span>
      )}
    </form>
  );
}
