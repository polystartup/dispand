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

const KINDS = { agent: "Agent", skill: "Skill package", tool: "Tool", table: "Table", trigger: "Trigger" };
/** What deleting one takes with it, said before the choice. */
const LOSES = {
  agent: "Deleting it removes its triggers and stops its Jobs; their history stays.",
  skill: "Deleting it removes its files and takes it off the agents that use it.",
  tool: "Deleting it removes its saved headers and sign-in, and takes it off the agents and skills that use it.",
  table: "Deleting it removes its rows and its memory.",
  trigger: "Deleting it stops it starting Jobs; what it started stays.",
};

function Choice({ element, why, choice, busy, onChange }: { element: RemovalElement; why: string[]; choice: RemovalChoice; busy: boolean; onChange: (key: string, choice: RemovalChoice) => void }) {
  return (
    <fieldset aria-label={element.name} className="space-y-1.5 rounded-xl border border-border p-3 text-[13px]">
      <p>
        <span className="font-medium text-fg">{element.name}</span> <span className="text-faint">· {KINDS[element.kind]}</span>
      </p>
      <ul className="text-muted">
        {why.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      {element.keepOnly ? (
        <p className="text-muted">It stays, as yours.</p>
      ) : (
        <>
          <div className="flex gap-4">
            {(["keep", "delete"] as const).map((value) => (
              <label key={value} className="flex items-center gap-2">
                <input type="radio" name={`removal-${element.key}`} className="size-4 accent-[var(--color-accent)]" checked={choice === value} disabled={busy} onChange={() => onChange(element.key, value)} />
                {value === "keep" ? "Keep as yours" : "Delete"}
              </label>
            ))}
          </div>
          {choice === "delete" && <p className="text-danger">{LOSES[element.kind]}</p>}
        </>
      )}
    </fieldset>
  );
}

/** The one screen of a plugin's removal: every element in use with its reasons and its two choices, and what a kept one needs. */
export function RemovalChoices({ plan, busy, onChange }: { plan: RemovalPlan; busy: boolean; onChange: (key: string, choice: RemovalChoice) => void }) {
  const total = plan.asked.length + plan.needed.length + plan.gone;
  if (total === 0) return <p className="text-[13px] text-muted">Nothing in your workspace is the plugin's own: removing it removes nothing else.</p>;
  if (plan.asked.length === 0) return <p className="text-[13px] text-muted">Nothing of it is in use: its {total} {total === 1 ? "element goes" : "elements go"} with it.</p>;
  return (
    <div className="space-y-3">
      {plan.asked.map((e) => (
        <Choice key={e.key} element={e} why={e.reasons} choice={plan.choices[e.key]!} busy={busy} onChange={onChange} />
      ))}
      {plan.needed.map(({ element, by }) => (
        <Choice key={element.key} element={element} why={[`Needed by ${by.join(", ")} if you keep it`]} choice={plan.choices[element.key]!} busy={busy} onChange={onChange} />
      ))}
      {plan.gone > 0 && (
        <p className="text-[13px] text-muted">
          {plan.gone} other {plan.gone === 1 ? "element goes" : "elements go"} with the plugin.
        </p>
      )}
    </div>
  );
}
