import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { orpc } from "../../lib/api.ts";
import { useFormat } from "../../lib/format.ts";

const MAX_DAYS = 3650;
const whole = (value: string) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= MAX_DAYS ? n : null;
};

/**
 * The organization's data retention, for its owner: how long a deleted person is kept before the
 * nightly purge deletes them and their data, and how long Audit records are kept.
 */
export function DataRetention() {
  const { t } = useTranslation("settings");
  const format = useFormat();
  const queryClient = useQueryClient();
  const current = useQuery(orpc.organization.retention.queryOptions());
  // What is typed, while editing; otherwise the fields follow the settings (another tab).
  const [typed, setTyped] = useState<{ person?: string; audit?: string }>({});
  const save = useMutation(orpc.organization.setRetention.mutationOptions({ onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.organization.retention.key() }) }));
  if (!current.data) return null;
  const person = typed.person ?? String(current.data.personDays);
  const audit = typed.audit ?? String(current.data.auditDays);
  const personDays = whole(person);
  const auditDays = whole(audit);
  const valid = personDays !== null && auditDays !== null;
  const changed = valid && (personDays !== current.data.personDays || auditDays !== current.data.auditDays);
  return (
    <section aria-labelledby="data-retention" className="mt-8">
      <h2 id="data-retention" className="text-[17px] font-medium tracking-tight">
        {t("dataRetention.title")}
      </h2>
      <p className="mb-3 text-[13px] text-muted">{t("dataRetention.text")}</p>
      <form
        className="flex flex-col gap-3 rounded-2xl bg-surface px-5 py-4 shadow-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate({ personDays, auditDays }, { onSuccess: () => setTyped({}) });
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="retention-person" className="text-[13px] text-muted">{t("dataRetention.personBefore")}</label>
          <Input id="retention-person" type="number" min={1} max={MAX_DAYS} value={person} onChange={(e) => setTyped((s) => ({ ...s, person: e.target.value }))} aria-invalid={personDays === null} className="w-24" />
          <span className="text-[13px] text-muted">{t("dataRetention.personAfter")}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="retention-audit" className="text-[13px] text-muted">{t("dataRetention.auditBefore")}</label>
          <Input id="retention-audit" type="number" min={1} max={MAX_DAYS} value={audit} onChange={(e) => setTyped((s) => ({ ...s, audit: e.target.value }))} aria-invalid={auditDays === null} className="w-24" />
          <span className="text-[13px] text-muted">{t("dataRetention.auditAfter")}</span>
        </div>
        <div>
          <Button type="submit" variant="outline" disabled={!changed || save.isPending}>
            {t("dataRetention.save")}
          </Button>
        </div>
        {!valid && (
          <p role="alert" className="text-[13px] text-danger">
            {t("dataRetention.range", { min: format.number(1), max: format.number(MAX_DAYS) })}
          </p>
        )}
        {save.error && (
          <p role="alert" className="text-[13px] text-danger">
            {save.error.message}
          </p>
        )}
      </form>
    </section>
  );
}
