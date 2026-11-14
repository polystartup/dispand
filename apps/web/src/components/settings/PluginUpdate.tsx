type At = { key: string; kind: "agent" | "tool" | "trigger" | "skill"; id: string; name: string; field: string };
export type UpdateChange = At & { class: "widening" | "wording" | "silent"; before: unknown; after: unknown };
export type UpdateConflict = At & { old: unknown; mine: unknown; next: unknown };
export type UpdateAddition = { key: string; kind: "primitive" | "agent" | "trigger" | "server" | "skill"; name: string; detail: string; harness?: "cli" | "cloud" };
type Harness = { id: string; name: string; type: string };
type Names = Record<string, string>;

/** Whether an update stops on its screen: a field of the owner's the plugin changed, a change that gives more, or a change of wording. */
export const needsReview = (plan: { conflicts: UpdateConflict[]; changes: UpdateChange[]; additions?: UpdateAddition[] }) =>
  plan.conflicts.length > 0 || plan.changes.some((c) => c.class !== "silent") || (plan.additions?.length ?? 0) > 0;

/** The harness an added agent runs on: the one picked, else the first of the kind it is written for, else the first. */
const harnessFor = (a: UpdateAddition, picked: Record<string, string>, harnesses: Harness[]) => picked[a.name] ?? (harnesses.find((h) => h.type === a.harness) ?? harnesses[0])?.id;

/** What the update is sent with for the additions ticked, by kind; undefined when none is. An agent with no harness to run on is left out. */
export function addOf(additions: UpdateAddition[], picked: Set<string>, harnessOf: Record<string, string>, harnesses: Harness[]) {
  const of = (kind: UpdateAddition["kind"]) => additions.filter((a) => a.kind === kind && picked.has(a.key));
  const agents = of("agent").flatMap((a) => {
    const harnessId = harnessFor(a, harnessOf, harnesses);
    return harnessId ? [{ name: a.name, harnessId }] : [];
  });
  const add = {
    ...(of("primitive").length ? { primitives: of("primitive").map((a) => a.name) } : {}),
    ...(agents.length ? { agents } : {}),
    ...(of("trigger").length ? { triggers: of("trigger").map((a) => a.name) } : {}),
    ...(of("server").length ? { servers: of("server").map((a) => ({ name: a.name })) } : {}),
    ...(of("skill").length ? { skills: of("skill").map((a) => a.name) } : {}),
  };
  return Object.keys(add).length ? add : undefined;
}

const ADDED = { primitive: "Table", agent: "Agent", trigger: "Trigger", server: "Tool", skill: "Skill" };

const LABELS: Record<string, string> = {
  name: "Name",
  description: "Description",
  systemPrompt: "Instructions",
  bundles: "What its Jobs may do",
  dataTables: "Tables",
  selfLearning: "Learns",
  skillPackageIds: "Skills",
  toolIds: "Tools",
  consults: "May consult",
  url: "URL",
  transport: "Transport",
  instructions: "What the agent is told",
  config: "When it fires",
  concurrency: "Jobs at once",
  rateCap: "Jobs an hour",
};
const label = (field: string) => (field.startsWith("file:") ? field.slice("file:".length) : (LABELS[field] ?? field));

/** A value as plain text: ids read by name, lists by their entries, a config as its JSON. Never markup. */
function shown(value: unknown, names: Names): string {
  if (value === null || value === undefined) return "none";
  if (typeof value === "string") return names[value] ?? value;
  if (Array.isArray(value)) return value.length ? value.map((v) => shown(v, names)).join(", ") : "none";
  if (typeof value === "object" && "agentId" in value) {
    const { agentId, ask } = value as { agentId: string; ask?: boolean };
    return `${names[agentId] ?? agentId}${ask ? " (asks first)" : ""}`;
  }
  return typeof value === "object" ? JSON.stringify(value, (_k, v: unknown) => (typeof v === "string" ? (names[v] ?? v) : v)) : String(value);
}

function Text({ title, value, names }: { title: string; value: unknown; names: Names }) {
  return (
    <div>
      <p className="text-[12px] text-faint">{title}</p>
      <p className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-hover px-2 py-1 text-[13px]">{shown(value, names)}</p>
    </div>
  );
}

/**
 * What an update of a plugin changes, for its owner to see before it is applied: the fields they
 * changed that the plugin changed too, each kept as theirs unless they take the plugin's; the
 * changes that give an agent more or move a tool's calls; the changes of wording, on one line
 * that opens; and how many others simply follow. Every value is shown as plain text.
 */
export function UpdatePlan({
  conflicts,
  changes,
  names,
  take,
  busy,
  onTake,
  additions = [],
  picked = new Set(),
  harnessOf = {},
  harnesses = [],
  onPick = () => {},
  onHarness = () => {},
}: {
  conflicts: UpdateConflict[];
  changes: UpdateChange[];
  names: Names;
  take: string[];
  busy: boolean;
  onTake: (key: string, taken: boolean) => void;
  /** What this version adds, the ones ticked, and the harness picked for each added agent. */
  additions?: UpdateAddition[];
  picked?: Set<string>;
  harnessOf?: Record<string, string>;
  harnesses?: Harness[];
  onPick?: (key: string) => void;
  onHarness?: (agent: string, harnessId: string) => void;
}) {
  const of = (kind: UpdateChange["class"]) => changes.filter((c) => c.class === kind);
  const [widening, wording, silent] = [of("widening"), of("wording"), of("silent")];
  return (
    <div className="space-y-5 text-[13px]">
      {conflicts.length > 0 && (
        <section aria-labelledby="update-conflicts" className="space-y-3">
          <h3 id="update-conflicts" className="font-medium text-muted">
            You changed these, and so did the plugin
          </h3>
          {conflicts.map((c) => (
            <fieldset key={c.key} aria-label={`${c.name}: ${label(c.field)}`} className="space-y-2 rounded-xl border border-border p-3">
              <p>
                <span className="font-medium text-fg">{c.name}</span> <span className="text-faint">· {label(c.field)}</span>
              </p>
              <Text title="The plugin's, before" value={c.old} names={names} />
              <Text title="Yours" value={c.mine} names={names} />
              <Text title="The plugin's, now" value={c.next} names={names} />
              <div className="flex gap-4">
                {([false, true] as const).map((taken) => (
                  <label key={String(taken)} className="flex items-center gap-2">
                    <input type="radio" name={`conflict-${c.key}`} className="size-4 accent-[var(--color-accent)]" checked={take.includes(c.key) === taken} disabled={busy} onChange={() => onTake(c.key, taken)} />
                    {taken ? "Take the plugin's" : "Keep mine"}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </section>
      )}
      {widening.length > 0 && (
        <section aria-labelledby="update-widening" className="space-y-2">
          <h3 id="update-widening" className="font-medium text-muted">
            Changes that give more
          </h3>
          <ul aria-labelledby="update-widening" className="space-y-1">
            {widening.map((c) => (
              <li key={c.key}>
                <span className="font-medium text-fg">{c.name}</span> · {label(c.field)}: {shown(c.before, names)} → {shown(c.after, names)}
              </li>
            ))}
          </ul>
        </section>
      )}
      {additions.length > 0 && (
        <fieldset aria-label="New in this version" className="space-y-2">
          <p className="font-medium text-muted">New in this version</p>
          <p className="text-muted">Ticked, it is made as the plugin's; unticked, it stays available from the plugin's row. A new skill reaches every agent that uses the plugin's skills.</p>
          {additions.map((a) => (
            <div key={a.key} className="space-y-1">
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-accent)]" checked={picked.has(a.key)} disabled={busy} onChange={() => onPick(a.key)} />
                <span>
                  <span className="font-medium text-fg">{a.name}</span> <span className="text-faint">· {ADDED[a.kind]}</span>
                  {a.detail && <span className="block text-muted">{a.detail}</span>}
                </span>
              </label>
              {a.kind === "agent" && picked.has(a.key) && (harnesses.length ? (
                <select aria-label={`Harness of ${a.name}`} className="ml-6 rounded-lg border border-border bg-surface px-2 py-1" value={harnessFor(a, harnessOf, harnesses) ?? ""} disabled={busy} onChange={(e) => onHarness(a.name, e.target.value)}>
                  {harnesses.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="ml-6 text-faint">Add a harness first: an agent needs one to run on.</p>
              ))}
            </div>
          ))}
        </fieldset>
      )}
      {wording.length > 0 && (
        <details>
          <summary className="cursor-pointer font-medium text-muted">
            {wording.length} wording {wording.length === 1 ? "change" : "changes"}
          </summary>
          <div className="mt-2 space-y-3">
            {wording.map((c) => (
              <div key={c.key} className="space-y-1 rounded-xl border border-border p-3">
                <p>
                  <span className="font-medium text-fg">{c.name}</span> <span className="text-faint">· {label(c.field)}</span>
                </p>
                <Text title="Before" value={c.before} names={names} />
                <Text title="After" value={c.after} names={names} />
              </div>
            ))}
          </div>
        </details>
      )}
      {silent.length > 0 && (
        <p className="text-muted">
          {silent.length} other {silent.length === 1 ? "change follows" : "changes follow"} the plugin.
        </p>
      )}
    </div>
  );
}
