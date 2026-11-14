import type { PrimitiveDefinition } from "./definitions.ts";

// A plugin's table belongs to both sides: the plugin defines fields, the owner adds their own and
// fills the rows. So an update doesn't override a table: it compares the definition the table
// was last merged with to the new one, and lists each difference with a box the owner ticks.
// What adds starts ticked; what deletes values, or changes which rows the table accepts, doesn't.

/** The table as it is now: its fields in order (each with the plugin field it was made from), its primitive flag and its parent field's name and requirement. */
export type ActualTable = {
  primitive: boolean;
  parentField: string | null;
  parentRequired: boolean;
  fields: { id: string; name: string; type: string; choices: { id: string; label: string }[]; pluginField: string | null }[];
};

export type TableChange = {
  /** What the update is told to apply, among the table's: `<kind>:<field>` or `<kind>`. */
  key: string;
  kind: "add" | "remove" | "retype" | "choices" | "move" | "primitive" | "parent";
  field?: string;
  ticked: boolean;
  /** The rows whose values it would take away. */
  loses?: number;
  /** Why it can't be applied: the owner changed what it would change, or it isn't an operation this screen has. */
  stale?: string;
  /** The table it names that isn't there yet: offered again once it is. */
  waiting?: string;
};

type Field = PrimitiveDefinition["fields"][number];
const lower = (s: string) => s.toLowerCase();
const find = (fields: Field[], name: string) => fields.find((f) => lower(f.name) === lower(name));
/** Choices as the cells hold them: an id with its label. */
const choiceKeys = (choices: { id: string; label: string }[] | undefined) => (choices ?? []).map((c) => `${c.id}\u0000${c.label}`);
const sameChoices = (a: { id: string; label: string }[] | undefined, b: { id: string; label: string }[] | undefined) => choiceKeys(a).join("\n") === choiceKeys(b).join("\n");

const OWNER_FIELD = "You changed this field";
const UNSUPPORTED = "It can't be applied here: change the field by hand";

/**
 * The differences between `kept` (the definition the table was last merged with) and `next`,
 * each with its starting tick, in the order they apply. What the owner changed since `kept` is
 * stale for every kind of change: its box can't be ticked.
 */
export function tableChanges(kept: PrimitiveDefinition, next: PrimitiveDefinition, actual: ActualTable, rows: number, tableExists: (name: string) => boolean): TableChange[] {
  const changes: TableChange[] = [];
  const mine = (name: string) => actual.fields.find((f) => f.pluginField !== null && lower(f.pluginField) === lower(name));
  const loses = rows > 0 ? { loses: rows } : {};
  /** Whether the owner changed this plugin field since `kept`: its type or its choices. */
  const ownerChanged = (was: Field) => {
    const field = mine(was.name);
    return field !== undefined && (field.type !== was.type || !sameChoices(field.choices, was.choices));
  };

  for (const f of next.fields.filter((f) => !find(kept.fields, f.name))) {
    const at = { key: `add:${f.name}`, kind: "add" as const, field: f.name };
    if (f.references && !tableExists(f.references)) changes.push({ ...at, ticked: false, waiting: f.references });
    else if (actual.fields.some((a) => lower(a.name) === lower(f.name))) changes.push({ ...at, ticked: false, stale: "A field of yours is called so" });
    else changes.push({ ...at, ticked: true });
  }
  for (const f of kept.fields.filter((f) => !find(next.fields, f.name))) {
    // Already gone: there is nothing to remove.
    if (!mine(f.name)) continue;
    changes.push({ key: `remove:${f.name}`, kind: "remove", field: f.name, ticked: false, ...(ownerChanged(f) ? { stale: OWNER_FIELD } : loses) });
  }
  for (const was of kept.fields) {
    const now = find(next.fields, was.name);
    if (!now || !mine(was.name)) continue;
    const at = { field: was.name, ticked: false };
    if (now.type !== was.type || (now.references ?? null) !== (was.references ?? null)) {
      // A reference's target isn't something a type change can set.
      const unsupported = now.type === "reference" || was.type === "reference";
      changes.push({ key: `retype:${was.name}`, kind: "retype", ...at, ...(unsupported ? { stale: UNSUPPORTED } : ownerChanged(was) ? { stale: OWNER_FIELD } : loses) });
    } else if (!sameChoices(now.choices, was.choices)) {
      const onlyAdded = choiceKeys(was.choices).every((c) => choiceKeys(now.choices).includes(c));
      if (ownerChanged(was)) changes.push({ key: `choices:${was.name}`, kind: "choices", ...at, stale: OWNER_FIELD });
      else changes.push({ key: `choices:${was.name}`, kind: "choices", field: was.name, ticked: onlyAdded, ...(onlyAdded ? {} : loses) });
    }
  }
  // The order of the fields both versions define; the owner's own order of them counts as theirs.
  const both = (n: string) => find(kept.fields, n) && find(next.fields, n);
  const order = (fields: { name: string }[]) => fields.map((f) => lower(f.name)).filter(both);
  if (order(kept.fields).join("\n") !== order(next.fields).join("\n")) {
    const actualOrder = actual.fields.flatMap((f) => (f.pluginField !== null && both(f.pluginField) ? [lower(f.pluginField)] : []));
    const moved = actualOrder.join("\n") !== order(kept.fields).filter((n) => mine(n)).join("\n");
    changes.push({ key: "move", kind: "move", ticked: !moved, ...(moved ? { stale: "You changed the order" } : {}) });
  }
  if (kept.primitive !== next.primitive) changes.push({ key: "primitive", kind: "primitive", ticked: false, ...(actual.primitive !== kept.primitive ? { stale: "You changed it" } : {}) });
  const parent = (p: { field: string; required: boolean } | null | undefined) => (p ? `${lower(p.field)}:${p.required}` : "");
  if (parent(kept.parent) !== parent(next.parent)) {
    const actualParent = actual.parentField === null ? null : { field: actual.fields.find((f) => f.name === actual.parentField)?.pluginField ?? actual.parentField, required: actual.parentRequired };
    const references = next.parent ? find(next.fields, next.parent.field)?.references : undefined;
    changes.push({
      key: "parent",
      kind: "parent",
      ticked: false,
      ...(parent(actualParent) !== parent(kept.parent) ? { stale: "You changed it" } : references && !tableExists(references) ? { waiting: references } : {}),
    });
  }
  return changes;
}
