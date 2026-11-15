import { useTranslation } from "react-i18next";
import { useFormat } from "../../lib/format.ts";

export type RemovalElement = { key: string; kind: "agent" | "skill" | "tool" | "table" | "trigger"; id: string; name: string; reasons: string[]; needs: string[]; keepOnly: string | null };
export type RemovalChoice = "keep" | "delete";
export type RemovalPlan = {
  /** The elements asked about for a reason of their own. */
  asked: RemovalElement[];
  /** The others a kept element needs, with who needs each. */
  needed: { element: RemovalElement; by: string[] }[];
  /** How many elements go with the plugin without a question. */
  gone: number;
  /** A stated choice for everything shown: what the removal is sent with. */
  choices: Record<string, RemovalChoice>;
};

/**
 * What the removal screen shows for the choices made so far. An element asked about, or needed
 * by a kept one, starts kept; what a kept element needs is listed with it, all the way down;
 * everything else goes with the plugin.
 */
export function removalPlan(elements: RemovalElement[], state: Record<string, RemovalChoice>): RemovalPlan {
  const byKey = new Map(elements.map((e) => [e.key, e]));
  const choiceOf = (e: RemovalElement): RemovalChoice => (e.keepOnly ? "keep" : (state[e.key] ?? "keep"));
  const asked = elements.filter((e) => e.reasons.length > 0);
  const by = new Map<string, string[]>();
  const seen = new Set<string>();
  const queue = [...asked];
  while (queue.length) {
    const e = queue.shift()!;
    if (seen.has(e.key)) continue;
    seen.add(e.key);
    if (choiceOf(e) !== "keep") continue;
    for (const key of e.needs) {
      const need = byKey.get(key);
      if (!need) continue;
      by.set(key, [...(by.get(key) ?? []), e.name]);
      queue.push(need);
    }
  }
  const needed = elements.filter((e) => by.has(e.key) && e.reasons.length === 0).map((element) => ({ element, by: by.get(element.key)! }));
  const shown = [...asked, ...needed.map((n) => n.element)];
  return { asked, needed, gone: elements.length - shown.length, choices: Object.fromEntries(shown.map((e) => [e.key, choiceOf(e)])) };
}

const CHOICES = ["keep", "delete"] as const;

// Each kind is named by `plugins:removal.kind.<kind>`, and what deleting one takes with it, said
// before the choice, by `removal.loses.<kind>`.
function Choice({ element, why, choice, busy, onChange }: { element: RemovalElement; why: string[]; choice: RemovalChoice; busy: boolean; onChange: (key: string, choice: RemovalChoice) => void }) {
  const { t } = useTranslation("plugins");
  return (
    <fieldset aria-label={element.name} className="space-y-1.5 rounded-xl border border-border p-3 text-[13px]">
      <p>
        <span className="font-medium text-fg">{element.name}</span> <span className="text-faint">{t("removal.kindOf", { kind: t(`removal.kind.${element.kind}`) })}</span>
      </p>
      <ul className="text-muted">
        {why.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      {element.keepOnly ? (
        <p className="text-muted">{t("removal.stays")}</p>
      ) : (
        <>
          <div className="flex gap-4">
            {CHOICES.map((value) => (
              <label key={value} className="flex items-center gap-2">
                <input type="radio" name={`removal-${element.key}`} className="size-4 accent-[var(--color-accent)]" checked={choice === value} disabled={busy} onChange={() => onChange(element.key, value)} />
                {value === "keep" ? t("removal.keep") : t("removal.delete")}
              </label>
            ))}
          </div>
          {choice === "delete" && <p className="text-danger">{t(`removal.loses.${element.kind}`)}</p>}
        </>
      )}
    </fieldset>
  );
}

/** The one screen of a plugin's removal: every element in use with its reasons and its two choices, and what a kept one needs. */
export function RemovalChoices({ plan, busy, onChange }: { plan: RemovalPlan; busy: boolean; onChange: (key: string, choice: RemovalChoice) => void }) {
  const { t } = useTranslation("plugins");
  const { list } = useFormat();
  const total = plan.asked.length + plan.needed.length + plan.gone;
  if (total === 0) return <p className="text-[13px] text-muted">{t("removal.nothing")}</p>;
  if (plan.asked.length === 0) return <p className="text-[13px] text-muted">{t("removal.unused", { count: total })}</p>;
  return (
    <div className="space-y-3">
      {plan.asked.map((e) => (
        <Choice key={e.key} element={e} why={e.reasons} choice={plan.choices[e.key]!} busy={busy} onChange={onChange} />
      ))}
      {plan.needed.map(({ element, by }) => (
        <Choice key={element.key} element={element} why={[t("removal.neededBy", { names: list(by) })]} choice={plan.choices[element.key]!} busy={busy} onChange={onChange} />
      ))}
      {plan.gone > 0 && (
        <p className="text-[13px] text-muted">
          {t("removal.others", { count: plan.gone })}
        </p>
      )}
    </div>
  );
}
