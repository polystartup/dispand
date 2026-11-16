import type { TFunction } from "i18next";
import type { Text as Said } from "@dispand/domain";
import { useTranslation } from "react-i18next";
import { useText } from "../../lib/message.ts";
import { useFormat } from "../../lib/format.ts";

type At = { key: string; kind: "agent" | "tool" | "trigger" | "skill"; id: string; name: string; field: string };
export type UpdateChange = At & { class: "widening" | "wording" | "silent"; before: unknown; after: unknown; reaches?: string[]; gained?: { name: string; files: { path: string; text: string | null }[] }[] };
export type UpdateConflict = At & { old: unknown; mine: unknown; next: unknown; reaches?: string[] };
export type UpdateAddition = { key: string; kind: "primitive" | "agent" | "trigger" | "server"; name: string; detail: Said };
type Names = Record<string, string>;

/** Whether an update stops on its screen: a field of the owner's the plugin changed, a change that gives more, or a change of wording. */
export const needsReview = (plan: { conflicts: UpdateConflict[]; changes: UpdateChange[]; additions?: UpdateAddition[]; removals?: unknown[]; tables?: unknown[]; native?: NativeInstalls }) =>
  plan.conflicts.length > 0 || plan.changes.some((c) => c.class !== "silent") || (plan.additions?.length ?? 0) > 0 || (plan.removals?.length ?? 0) > 0 || (plan.tables?.length ?? 0) > 0 || (plan.native?.harnesses.length ?? 0) > 0;

export type NativeInstalls = { harnesses: { id: string; name: string }[]; unchecked: { name: string; disabled?: true }[] };

/** Where the plugin is installed natively: each install moves to the new version with the update. */
export function NativeMoves({ native }: { native: NativeInstalls }) {
  const { t } = useTranslation("plugins");
  const { list } = useFormat();
  if (!native.harnesses.length && !native.unchecked.length) return null;
  return (
    <section aria-labelledby="update-native" className="space-y-1 text-[13px]">
      <h3 id="update-native" className="font-medium text-muted">
        {t("update.nativeTitle")}
      </h3>
      {native.harnesses.length > 0 && <p>{t("update.nativeMoves", { harnesses: list(native.harnesses.map((h) => h.name)) })}</p>}
      {native.unchecked.length > 0 && <p className="text-muted">{t("update.nativeStays", { harnesses: list(native.unchecked.map((u) => (u.disabled ? t("update.disabledThere", { name: u.name }) : u.name))) })}</p>}
    </section>
  );
}

type T = TFunction<"plugins">;

/** A field as its form names it (`plugins:update.field.<field>`), a file by its path. */
const label = (t: T, field: string) => (field.startsWith("file:") ? field.slice("file:".length) : t(`update.field.${field}`, { defaultValue: field }));

/** A value as plain text: ids read by name, lists by their entries, a config as its JSON. Never markup. */
function shown(t: T, value: unknown, names: Names): string {
  if (value === null || value === undefined) return t("update.none");
  if (typeof value === "string") return names[value] ?? value;
  if (Array.isArray(value)) return value.length ? value.map((v) => shown(t, v, names)).join(", ") : t("update.none");
  if (typeof value === "object" && "agentId" in value) {
    const { agentId, ask } = value as { agentId: string; ask?: boolean };
    const agent = names[agentId] ?? agentId;
    return ask ? t("update.asksFirst", { agent }) : agent;
  }
  return typeof value === "object" ? JSON.stringify(value, (_k, v: unknown) => (typeof v === "string" ? (names[v] ?? v) : v)) : String(value);
}

function Text({ title, value, names }: { title: string; value: unknown; names: Names }) {
  const { t } = useTranslation("plugins");
  return (
    <div>
      <p className="text-[12px] text-faint">{title}</p>
      <p className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-hover px-2 py-1 text-[13px]">{shown(t, value, names)}</p>
    </div>
  );
}

const CHOICES = ["mine", "plugin"] as const;
const STEM = ["stem"] as const;

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
  stem = [],
  onStem,
  additions = [],
}: {
  conflicts: UpdateConflict[];
  changes: UpdateChange[];
  names: Names;
  take: string[];
  busy: boolean;
  onTake: (key: string, taken: boolean) => void;
  /** The conflicts handed to Stem: it decides them after the update, and they stay yours until it does. */
  stem?: string[];
  onStem?: (key: string, handed: boolean) => void;
  /** What this version adds: named here, made afterwards from the plugin's Set up. */
  additions?: UpdateAddition[];
}) {
  const { t } = useTranslation(["plugins", "messages"]);
  const { list } = useFormat();
  const text = useText();
  const assistant = t("messages:agent.assistant.name");
  const of = (kind: UpdateChange["class"]) => changes.filter((c) => c.class === kind);
  const [widening, wording, silent] = [of("widening"), of("wording"), of("silent")];
  return (
    <div className="space-y-5 text-[13px]">
      {conflicts.length > 0 && (
        <section aria-labelledby="update-conflicts" className="space-y-3">
          <h3 id="update-conflicts" className="font-medium text-muted">
            {t("update.conflicts")}
          </h3>
          {conflicts.map((c) => (
            <fieldset key={c.key} aria-label={t("update.fieldOf", { name: c.name, field: label(t, c.field) })} className="space-y-2 rounded-xl border border-border p-3">
              <p>
                <span className="font-medium text-fg">{c.name}</span> <span className="text-faint">{t("update.dotField", { field: label(t, c.field) })}</span>
              </p>
              {c.reaches && <p className="text-muted">{c.reaches.length ? t("update.reaches", { agents: list(c.reaches) }) : t("update.noAgent")}</p>}
              <Text title={t("update.before")} value={c.old} names={names} />
              <Text title={t("update.yours")} value={c.mine} names={names} />
              <Text title={t("update.now")} value={c.next} names={names} />
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {[...CHOICES, ...(onStem && c.kind !== "skill" ? STEM : [])].map((choice) => (
                  <label key={choice} className="flex items-center gap-2">
                    <input
                      type="radio"
                      name={`conflict-${c.key}`}
                      className="size-4 accent-[var(--color-accent)]"
                      checked={(take.includes(c.key) ? "plugin" : stem.includes(c.key) ? "stem" : "mine") === choice}
                      disabled={busy}
                      onChange={() => {
                        onTake(c.key, choice === "plugin");
                        onStem?.(c.key, choice === "stem");
                      }}
                    />
                    {choice === "plugin" ? t("update.take") : choice === "stem" ? t("update.delegate", { assistant }) : t("update.keep")}
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
            {t("update.widening")}
          </h3>
          <ul aria-labelledby="update-widening" className="space-y-1">
            {widening.map((c) => (
              <li key={c.key}>
                <span className="font-medium text-fg">{c.name}</span> {t("update.dotField", { field: label(t, c.field) })}: {t("update.change", { from: shown(t, c.before, names), to: shown(t, c.after, names) })}
                {c.kind === "tool" && (c.field === "url" || c.field === "transport") && <span className="block text-muted">{t("update.clearsSignIn")}</span>}
                {c.gained?.map((g) => (
                  <details key={g.name} className="mt-1">
                    <summary className="cursor-pointer text-muted">{t("update.skillTells", { name: g.name, count: g.files.length })}</summary>
                    {g.files.map((f) => (
                      <Text key={f.path} title={f.path} value={f.text} names={names} />
                    ))}
                  </details>
                ))}
              </li>
            ))}
          </ul>
        </section>
      )}
      {additions.length > 0 && (
        <section aria-labelledby="update-additions" className="space-y-2">
          <h3 id="update-additions" className="font-medium text-muted">
            {t("update.additions")}
          </h3>
          <p className="text-muted">{t("update.additionsNote")}</p>
          <ul aria-labelledby="update-additions" className="space-y-1">
            {additions.map((a) => (
              <li key={a.key}>
                <span className="font-medium text-fg">{a.name}</span> <span className="text-faint">{t("update.dotKind", { kind: t(`update.added.${a.kind}`) })}</span>
                {text(a.detail) && <span className="block text-muted">{text(a.detail)}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {wording.length > 0 && (
        <details>
          <summary className="cursor-pointer font-medium text-muted">
            {t("update.wording", { count: wording.length })}
          </summary>
          <div className="mt-2 space-y-3">
            {wording.map((c) => (
              <div key={c.key} className="space-y-1 rounded-xl border border-border p-3">
                <p>
                  <span className="font-medium text-fg">{c.name}</span> <span className="text-faint">{t("update.dotField", { field: label(t, c.field) })}</span>
                </p>
                {c.reaches && <p className="text-muted">{c.reaches.length ? t("update.reaches", { agents: list(c.reaches) }) : t("update.noAgent")}</p>}
                <Text title={t("update.wordingBefore")} value={c.before} names={names} />
                <Text title={t("update.wordingAfter")} value={c.after} names={names} />
              </div>
            ))}
          </div>
        </details>
      )}
      {silent.length > 0 && (
        <p className="text-muted">
          {t("update.silent", { count: silent.length })}
        </p>
      )}
    </div>
  );
}

export type UpdateReleaseNotes = { from: string | null; to: string; version: string | null; text: string | null };

/** What the plugin says of the version it goes to, from its changelog, as plain text; the two commits when it says nothing. */
export function ReleaseNotes({ notes }: { notes: UpdateReleaseNotes }) {
  const { t } = useTranslation("plugins");
  if (!notes.text) {
    return <p className="text-[13px] text-muted">{t("update.noNotes", { from: notes.from?.slice(0, 7) ?? t("update.installedVersion"), to: notes.to.slice(0, 7) })}</p>;
  }
  return (
    <details className="text-[13px]">
      <summary className="cursor-pointer font-medium text-muted">{t("update.notes", { version: notes.version })}</summary>
      <p className="mt-2 max-h-60 overflow-y-auto whitespace-pre-wrap rounded-lg bg-hover px-2 py-1">{notes.text}</p>
    </details>
  );
}

export type UpdateTableChange = { key: string; kind: "add" | "remove" | "retype" | "choices" | "move" | "primitive" | "parent"; field?: string; ticked: boolean; loses?: number; stale?: Said; waiting?: string; stops?: string[] };
export type UpdateTable = { tableId: string; name: string; changes: UpdateTableChange[] };

/** What a table change does, in words. */
export const says = (t: T, c: UpdateTableChange) => t(`update.says.${c.kind}`, { field: c.field ?? "" });

/** The keys ticked to start with, for each table. */
export const startingTicks = (tables: UpdateTable[]) => Object.fromEntries(tables.map((table) => [table.tableId, table.changes.filter((c) => c.ticked && !c.stale && !c.waiting).map((c) => c.key)]));

/**
 * The changes of each of the plugin's tables, as boxes: what adds starts ticked, what takes values
 * away doesn't and says how many rows, and one that can't apply (the owner changed it, or it waits
 * for a table not made yet) says why and can't be ticked. With `onStem`, a table can be handed to
 * Stem instead: its boxes are then left to it.
 */
export function TableChanges({ tables, ticked, busy, onTick, stem = [], onStem }: { tables: UpdateTable[]; ticked: Record<string, string[]>; busy: boolean; onTick: (tableId: string, key: string) => void; /** The tables handed to Stem, as `table:<id>`. */ stem?: string[]; onStem?: (tableId: string, handed: boolean) => void }) {
  const { t } = useTranslation(["plugins", "messages"]);
  const assistant = t("messages:agent.assistant.name");
  const { list } = useFormat();
  const text = useText();
  return (
    <div className="space-y-3 text-[13px]">
      {tables.map((table) => (
        <fieldset key={table.tableId} aria-label={table.name} className="space-y-1.5 rounded-xl border border-border p-3">
          <p className="font-medium text-fg">{table.name}</p>
          {onStem && (
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-accent)]" checked={stem.includes(`table:${table.tableId}`)} disabled={busy} onChange={(e) => onStem(table.tableId, e.target.checked)} />
              <span>
                {t("update.delegate", { assistant })}
                {stem.includes(`table:${table.tableId}`) && <span className="block text-muted">{t("update.stemTable", { assistant })}</span>}
              </span>
            </label>
          )}
          {table.changes.map((c) => {
            const blocked = c.stale ? text(c.stale) : (c.waiting ? t("update.waits", { table: c.waiting }) : undefined);
            const handed = stem.includes(`table:${table.tableId}`);
            return (
              <label key={c.key} className="flex items-start gap-2">
                <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-accent)]" checked={!handed && (ticked[table.tableId] ?? []).includes(c.key)} disabled={busy || handed || blocked !== undefined} onChange={() => onTick(table.tableId, c.key)} />
                <span>
                  {says(t, c)}
                  {c.loses ? <span className="block text-danger">{t("update.loses", { count: c.loses })}</span> : null}
                  {c.stops?.length ? <span className="block text-danger">{t(c.kind === "retype" ? "update.mayStop" : "update.stops", { count: c.stops.length, workflows: list(c.stops) })}</span> : null}
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
