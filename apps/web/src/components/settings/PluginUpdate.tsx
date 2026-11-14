type At = { key: string; kind: "agent" | "tool" | "trigger" | "skill"; id: string; name: string; field: string };
export type UpdateChange = At & { class: "widening" | "wording" | "silent"; before: unknown; after: unknown };
export type UpdateConflict = At & { old: unknown; mine: unknown; next: unknown };
export type UpdateAddition = { key: string; kind: "primitive" | "agent" | "trigger" | "server"; name: string; detail: string };
type Names = Record<string, string>;

/** Whether an update stops on its screen: a field of the owner's the plugin changed, a change that gives more, or a change of wording. */
export const needsReview = (plan: { conflicts: UpdateConflict[]; changes: UpdateChange[]; additions?: UpdateAddition[]; removals?: unknown[]; tables?: unknown[] }) =>
  plan.conflicts.length > 0 || plan.changes.some((c) => c.class !== "silent") || (plan.additions?.length ?? 0) > 0 || (plan.removals?.length ?? 0) > 0 || (plan.tables?.length ?? 0) > 0;

const ADDED = { primitive: "Table", agent: "Agent", trigger: "Trigger", server: "Tool" };

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
}: {
  conflicts: UpdateConflict[];
  changes: UpdateChange[];
  names: Names;
  take: string[];
  busy: boolean;
  onTake: (key: string, taken: boolean) => void;
  /** What this version adds: named here, made afterwards from the plugin's Set up. */
  additions?: UpdateAddition[];
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
        <section aria-labelledby="update-additions" className="space-y-2">
          <h3 id="update-additions" className="font-medium text-muted">
            New in this version
          </h3>
          <p className="text-muted">The update makes none of these. Set up opens afterwards: it shows what each would be allowed to do, and makes the ones you pick.</p>
          <ul aria-labelledby="update-additions" className="space-y-1">
            {additions.map((a) => (
              <li key={a.key}>
                <span className="font-medium text-fg">{a.name}</span> <span className="text-faint">· {ADDED[a.kind]}</span>
                {a.detail && <span className="block text-muted">{a.detail}</span>}
              </li>
            ))}
          </ul>
        </section>
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

export type UpdateReleaseNotes = { from: string | null; to: string; version: string | null; text: string | null };

/** What the plugin says of the version it goes to, from its changelog, as plain text; the two commits when it says nothing. */
export function ReleaseNotes({ notes }: { notes: UpdateReleaseNotes }) {
  if (!notes.text) {
    return (
      <p className="text-[13px] text-muted">
        No release notes: from {notes.from?.slice(0, 7) ?? "the installed version"} to {notes.to.slice(0, 7)}.
      </p>
    );
  }
  return (
    <details className="text-[13px]">
      <summary className="cursor-pointer font-medium text-muted">Release notes for {notes.version}</summary>
      <p className="mt-2 max-h-60 overflow-y-auto whitespace-pre-wrap rounded-lg bg-hover px-2 py-1">{notes.text}</p>
    </details>
  );
}

export type UpdateTableChange = { key: string; kind: "add" | "remove" | "retype" | "choices" | "move" | "primitive" | "parent"; field?: string; ticked: boolean; loses?: number; stale?: string; waiting?: string };
export type UpdateTable = { tableId: string; name: string; changes: UpdateTableChange[] };

/** What a table change does, in words. */
function says(c: UpdateTableChange): string {
  const field = c.field ?? "";
  return {
    add: `Add the field ${field}`,
    remove: `Remove the field ${field}`,
    retype: `Change the type of ${field}`,
    choices: `Change the choices of ${field}`,
    move: "Put the plugin's fields in its new order",
    primitive: "Change whether it records each change of its rows",
    parent: "Change its parent table",
  }[c.kind];
}

/** The keys ticked to start with, for each table. */
export const startingTicks = (tables: UpdateTable[]) => Object.fromEntries(tables.map((t) => [t.tableId, t.changes.filter((c) => c.ticked && !c.stale && !c.waiting).map((c) => c.key)]));

/**
 * The changes of each of the plugin's tables, as boxes: what adds starts ticked, what takes values
 * away doesn't and says how many rows, and one that can't apply (the owner changed it, or it waits
 * for a table not made yet) says why and can't be ticked.
 */
export function TableChanges({ tables, ticked, busy, onTick }: { tables: UpdateTable[]; ticked: Record<string, string[]>; busy: boolean; onTick: (tableId: string, key: string) => void }) {
  return (
    <div className="space-y-3 text-[13px]">
      {tables.map((t) => (
        <fieldset key={t.tableId} aria-label={t.name} className="space-y-1.5 rounded-xl border border-border p-3">
          <p className="font-medium text-fg">{t.name}</p>
          {t.changes.map((c) => {
            const blocked = c.stale ?? (c.waiting ? `Waits for the table ${c.waiting}: offered again once it is made` : undefined);
            return (
              <label key={c.key} className="flex items-start gap-2">
                <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-accent)]" checked={(ticked[t.tableId] ?? []).includes(c.key)} disabled={busy || blocked !== undefined} onChange={() => onTick(t.tableId, c.key)} />
                <span>
                  {says(c)}
                  {c.loses ? <span className="block text-danger">Ticked, it removes the values of {c.loses} {c.loses === 1 ? "row" : "rows"}.</span> : null}
                  {blocked && <span className="block text-muted">{blocked}</span>}
                </span>
              </label>
            );
          })}
        </fieldset>
      ))}
    </div>
  );
}
