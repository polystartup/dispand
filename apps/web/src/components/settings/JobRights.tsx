import type { Bundle, TableScope } from "@dispand/domain/platform/bundles";
import { Lock } from "lucide-react";
import { useTranslation } from "react-i18next";

/** What an agent's Jobs may do through Dispand's own tools, and on which tables. */
export type Rights = { bundles: Bundle[]; dataTables: TableScope };

/** The bundles in the order the form shows them; each is named by `agents:rights.<bundle>.label` and `.text`. */
export const BUNDLES: Bundle[] = ["data", "configure"];

const box = "mt-1 size-4 accent-[var(--color-accent)]";

/** The agent's bundles and, once it has one, the tables they apply to: all of them or a chosen list. `locked`: why they can't change. */
export function JobRights({ rights, tables, onChange, locked }: { rights: Rights; tables: { id: string; name: string }[]; onChange: (rights: Rights) => void; locked?: string }) {
  const { t } = useTranslation("agents");
  const { bundles, dataTables } = rights;
  const toggleBundle = (bundle: Bundle, on: boolean) =>
    onChange({ ...rights, bundles: BUNDLES.filter((b) => (b === bundle ? on : bundles.includes(b))) });
  const listed = dataTables === "all" ? [] : dataTables;
  // A listed table that was deleted since stays visible, so the owner can untick it.
  const gone = listed.filter((id) => !tables.some((t) => t.id === id));
  const toggleTable = (id: string, on: boolean) => onChange({ ...rights, dataTables: on ? [...listed, id] : listed.filter((t) => t !== id) });
  return (
    <fieldset className="space-y-3" disabled={locked !== undefined}>
      <legend className="mb-1.5 text-[13px] font-medium text-muted">{t("rights.title")}</legend>
      {locked && (
        <p className="flex items-center gap-1.5 text-[13px] text-muted">
          <Lock aria-hidden className="size-3.5" />
          {locked}
        </p>
      )}
      {BUNDLES.map((bundle) => (
        <label key={bundle} className="flex items-start gap-3 text-[14px]">
          <input type="checkbox" className={box} checked={bundles.includes(bundle)} onChange={(e) => toggleBundle(bundle, e.target.checked)} />
          <span>
            {t(`rights.${bundle}.label`)}
            <span className="block text-[12px] text-faint">{t(`rights.${bundle}.text`)}</span>
          </span>
        </label>
      ))}
      {bundles.length > 0 && (
        <div className="ml-7 space-y-2 text-[14px]">
          <label className="flex items-center gap-2">
            <input type="radio" name="job-tables" className="size-4 accent-[var(--color-accent)]" checked={dataTables === "all"} onChange={() => onChange({ ...rights, dataTables: "all" })} />
            {t("rights.allTables")}
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="job-tables" className="size-4 accent-[var(--color-accent)]" checked={dataTables !== "all"} onChange={() => onChange({ ...rights, dataTables: listed })} />
            {t("rights.someTables")}
          </label>
          {dataTables !== "all" && (
            <div className="ml-6 space-y-1.5">
              {tables.map((t) => (
                <label key={t.id} className="flex items-center gap-2">
                  <input type="checkbox" className="size-4 accent-[var(--color-accent)]" checked={listed.includes(t.id)} onChange={(e) => toggleTable(t.id, e.target.checked)} />
                  {t.name}
                </label>
              ))}
              {gone.map((id) => (
                <label key={id} className="flex items-center gap-2 text-muted">
                  <input type="checkbox" className="size-4 accent-[var(--color-accent)]" checked onChange={() => toggleTable(id, false)} />
                  {t("rights.deletedTable")}
                </label>
              ))}
              {tables.length === 0 && gone.length === 0 && <p className="text-[13px] text-muted">{t("rights.noTable")}</p>}
            </div>
          )}
        </div>
      )}
    </fieldset>
  );
}
