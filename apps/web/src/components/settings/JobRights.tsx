import type { Bundle, TableScope } from "@dispand/domain/platform/bundles";
import { Lock } from "lucide-react";

/** What an agent's Jobs may do through Dispand's own tools, and on which tables. */
export type Rights = { bundles: Bundle[]; dataTables: TableScope };

export const BUNDLE_TEXT: [Bundle, string, string][] = [
  ["data", "Work on data", "Its Jobs can read, add, change and delete rows."],
  ["configure", "Change tables and fields", "Its Jobs can create tables, change what they are called, and add, change and order their fields. Deleting stays yours."],
  ["inbox", "Answer Questions", "Its Jobs can be started by Questions other agents' Jobs ask on its tables. Approvals, and Questions of Jobs that change tables, stay yours."],
];

const box = "mt-1 size-4 accent-[var(--color-accent)]";

/** The agent's bundles and, once it has one, the tables they apply to: all of them or a chosen list. `locked`: why they can't change. */
export function JobRights({ rights, tables, onChange, locked }: { rights: Rights; tables: { id: string; name: string }[]; onChange: (rights: Rights) => void; locked?: string }) {
  const { bundles, dataTables } = rights;
  const toggleBundle = (bundle: Bundle, on: boolean) =>
    onChange({ ...rights, bundles: BUNDLE_TEXT.map(([b]) => b).filter((b) => (b === bundle ? on : bundles.includes(b))) });
  const listed = dataTables === "all" ? [] : dataTables;
  // A listed table that was deleted since stays visible, so the owner can untick it.
  const gone = listed.filter((id) => !tables.some((t) => t.id === id));
  const toggleTable = (id: string, on: boolean) => onChange({ ...rights, dataTables: on ? [...listed, id] : listed.filter((t) => t !== id) });
  return (
    <fieldset className="space-y-3" disabled={locked !== undefined}>
      <legend className="mb-1.5 text-[13px] font-medium text-muted">What its Jobs may do</legend>
      {locked && (
        <p className="flex items-center gap-1.5 text-[13px] text-muted">
          <Lock aria-hidden className="size-3.5" />
          {locked}
        </p>
      )}
      {BUNDLE_TEXT.map(([bundle, label, text]) => (
        <label key={bundle} className="flex items-start gap-3 text-[14px]">
          <input type="checkbox" className={box} checked={bundles.includes(bundle)} onChange={(e) => toggleBundle(bundle, e.target.checked)} />
          <span>
            {label}
            <span className="block text-[12px] text-faint">{text}</span>
          </span>
        </label>
      ))}
      {bundles.length > 0 && (
        <div className="ml-7 space-y-2 text-[14px]">
          <label className="flex items-center gap-2">
            <input type="radio" name="job-tables" className="size-4 accent-[var(--color-accent)]" checked={dataTables === "all"} onChange={() => onChange({ ...rights, dataTables: "all" })} />
            All tables
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="job-tables" className="size-4 accent-[var(--color-accent)]" checked={dataTables !== "all"} onChange={() => onChange({ ...rights, dataTables: listed })} />
            Only these tables
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
                  A deleted table
                </label>
              ))}
              {tables.length === 0 && gone.length === 0 && <p className="text-[13px] text-muted">No table yet.</p>}
            </div>
          )}
        </div>
      )}
    </fieldset>
  );
}
