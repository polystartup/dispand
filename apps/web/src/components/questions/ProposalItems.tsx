/** A proposal as the server gives it to its owner: every write, and a name for each id a write points at. */
export type ProposalView = {
  id: string;
  status: "draft" | "asked" | "approved" | "declined";
  /**
   * `refs`: the keys of the input that hold ids of the owner's things, read by name. An input may
   * hold `{ "$item": n }` where an id goes: what item `n` creates (`creates`), once made
   * `createdId`; `failed` when its call was refused.
   */
  items: { tool: string; input: unknown; used: boolean; refs: string[]; creates?: string | null; createdId?: string | null; failed?: boolean }[];
  names: Record<string, { kind: string; name: string; detail?: string }>;
};

const TITLES: Record<string, string> = {
  tables_create: "Create a table",
  tables_rename: "Rename a table",
  tables_set_primitive: "Make a table primitive, or not",
  fields_create: "Add a field to a table",
  fields_update: "Change a field",
  fields_reorder: "Reorder a table's fields",
  agents_create: "Create an agent",
  agents_update: "Change an agent",
  agents_set_tool_ask: "Change whether an action asks before use",
  harnesses_set_limit: "Change how many sessions of a harness work at once",
  tables_delete: "Delete a table, with its rows",
  fields_delete: "Delete a field, with its values",
  tools_add: "Add a tool: a server Dispand will call",
  tools_add_from_catalog: "Add a tool from the catalog: a server Dispand will call",
  tools_delete: "Delete a tool, with its saved headers",
  triggers_create: "Create a trigger: what starts an agent's Jobs",
  triggers_update: "Change a trigger",
  triggers_delete: "Delete a trigger",
};
/** What a key is called, by tool where one name isn't enough. */
const LABELS_OF: Record<string, Record<string, string>> = {
  tables_create: { name: "Name" },
  tables_rename: { id: "Table", name: "New name" },
  tables_set_primitive: { id: "Table", primitive: "Primitive", parent: "Parent table" },
  fields_create: { tableId: "Table", name: "Name", type: "Type", choices: "Choices", referencesTableId: "Names rows of" },
  fields_update: { id: "Field", name: "New name", choices: "Choices" },
  fields_reorder: { tableId: "Table", fieldIds: "Fields, in order" },
  tables_delete: { id: "Table" },
  fields_delete: { id: "Field" },
  triggers_create: { id: "Trigger", agentId: "Agent", instructions: "What the agent is told", config: "When it fires", concurrency: "Jobs at once", rateCap: "Jobs an hour", enabled: "On" },
  triggers_update: { id: "Trigger", agentId: "Agent", instructions: "What the agent is told", config: "When it fires", concurrency: "Jobs at once", rateCap: "Jobs an hour", enabled: "On" },
  triggers_delete: { id: "Trigger" },
  tools_add: { name: "Name", url: "Address", transport: "Transport" },
  tools_add_from_catalog: { catalogId: "Catalog entry", name: "Name" },
  tools_delete: { id: "Tool" },
  agents_set_tool_ask: { agentId: "Agent", toolId: "Tool", action: "Action", ask: "Asks before use" },
  harnesses_set_limit: { id: "Harness", maxWorking: "At most at once" },
};
/** A trigger's `concurrency` in words. */
const CONCURRENCY: Record<string, string> = { parallel: "Several at once", "one-at-a-time": "One at a time" };
const LABELS: Record<string, string> = {
  id: "Agent",
  name: "Name",
  description: "Description",
  harnessId: "Harness",
  systemPrompt: "Instructions",
  model: "Model",
  skillPackageIds: "Skills",
  toolIds: "Tools",
  bundles: "What its Jobs may do",
  dataTables: "Tables",
  consults: "May consult",
};

/** What naming an agent on another's consult list gives each of them (`ConsultList` says it too). */
export const CONSULT_LINE = "It can steer this agent with its questions, and its answers may quote what it reads in tables this agent can't.";

/** An agent's consult entries: each agent by name, whether it asks first, and what the pair can do. */
function Consults({ value, items, names }: { value: unknown; items: Items; names: ProposalView["names"] }) {
  const entries = Array.isArray(value) ? value.filter((e): e is { agentId: unknown; ask?: unknown } => typeof e === "object" && e !== null) : [];
  if (entries.length === 0) return <span className="text-faint">none</span>;
  return (
    <span className="flex flex-col gap-1">
      {entries.map((e, i) => (
        <span key={i}>
          <Id value={e.agentId} items={items} names={names} />
          {e.ask === true ? " (asks before use)" : ""}
        </span>
      ))}
      <span className="text-muted">{CONSULT_LINE}</span>
    </span>
  );
}
type Items = ProposalView["items"];

/** `{ "$item": n }`: what item `n` of the same proposal creates. */
const isItemRef = (value: unknown): value is { $item: number } => typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { $item?: unknown }).$item === "number";

/** A reference to an earlier item, read as what it creates, and by name once made. */
function ItemRef({ at, items, names }: { at: number; items: Items; names: ProposalView["names"] }) {
  const item = items[at];
  return (
    <span>
      the {item?.creates ?? "thing"} item {at + 1} creates
      {item?.createdId ? (
        <>
          : <Ref id={item.createdId} names={names} />
        </>
      ) : null}
    </span>
  );
}

/** An id, or a reference to an earlier item where an id goes. */
function Id({ value, items, names }: { value: unknown; items: Items; names: ProposalView["names"] }) {
  return isItemRef(value) ? <ItemRef at={value.$item} items={items} names={names} /> : <Ref id={String(value)} names={names} />;
}

function Ref({ id, names }: { id: string; names: ProposalView["names"] }) {
  const found = names[id];
  if (!found) {
    return (
      <span role="alert" className="font-medium text-danger">
        {id}: not one of yours
      </span>
    );
  }
  return (
    <span>
      {found.name}
      {found.detail ? ` (${found.detail})` : ""} <span className="font-mono text-[12px] text-faint">{id}</span>
    </span>
  );
}

const OPERATIONS: Record<string, string> = { created: "a row is created", updated: "a row is changed", deleted: "a row is deleted" };
const INTERACTION_OPERATIONS: Record<string, string> = { created: "one is asked", answered: "one is answered", expired: "one expires" };

/** A table-change trigger's config in words, its table and fields read by name. */
function ChangeConfig({ config, items, names }: { config: { tableId?: unknown; operations?: unknown; fields?: unknown }; items: Items; names: ProposalView["names"] }) {
  const interaction = config.tableId === "interaction";
  const words = interaction ? INTERACTION_OPERATIONS : OPERATIONS;
  const operations = Array.isArray(config.operations) ? config.operations.map((o) => words[String(o)] ?? String(o)) : [];
  const fields = Array.isArray(config.fields) ? config.fields.filter((f) => typeof f === "string" || isItemRef(f)) : null;
  return (
    <span className="flex flex-col gap-1">
      <span>
        {interaction ? (
          "A Question or an Approval of another agent's Job"
        ) : (
          // A reference already says what it is ("the table item 1 creates"): "the table" isn't said twice.
          <>A change to {isItemRef(config.tableId) ? "" : "the table "}<Id value={config.tableId} items={items} names={names} /></>
        )}
      </span>
      <span>When {operations.join(", or ") || "nothing"}</span>
      {fields && operations.length > 0 && (config.operations as unknown[]).includes("updated") && (
        <span className="flex flex-col">
          A changed row only when one of these changed:
          {fields.map((id, i) => (
            <Id key={i} value={id} items={items} names={names} />
          ))}
        </span>
      )}
    </span>
  );
}

function Value({ name, value, items, names, isRef, address }: { name: string; value: unknown; items: Items; names: ProposalView["names"]; isRef: boolean; address: boolean }) {
  const list = Array.isArray(value) ? value : null;
  if (isItemRef(value)) return <ItemRef at={value.$item} items={items} names={names} />;
  // Read by name, never taken on trust ("all" tables is not an id).
  if (isRef && value !== "all") {
    const ids = (list ?? [value]).filter((v) => typeof v === "string" || isItemRef(v));
    if (ids.length === 0) return <span className="text-faint">none</span>;
    return (
      <span className="flex flex-col">
        {ids.map((id, i) => (
          <Id key={i} value={id} items={items} names={names} />
        ))}
      </span>
    );
  }
  if (typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "primitive") return <ChangeConfig config={value as never} items={items} names={names} />;
  // A primitive table's parent: a table, and whether every row must name one.
  if (typeof value === "object" && value !== null && "tableId" in value && "required" in value) {
    const parent = value as { tableId: unknown; required: unknown };
    return (
      <span>
        <Id value={parent.tableId} items={items} names={names} />
        {parent.required === true ? ", which every row must name" : ""}
      </span>
    );
  }
  if (name === "rateCap" && typeof value === "number") return <span>At most {value} an hour</span>;
  if (name === "concurrency" && typeof value === "string" && value in CONCURRENCY) return <span>{CONCURRENCY[value]}</span>;
  // A choice field's choices by their labels, never as JSON.
  if (name === "choices" && list && list.every((v) => typeof v === "object" && v !== null && typeof (v as { label?: unknown }).label === "string")) {
    return <span>{list.length ? list.map((c) => (c as { label: string }).label).join(", ") : <span className="text-faint">none</span>}</span>;
  }
  if (address && typeof value === "string") {
    // The whole address, and the host it reaches set apart: that is where calls will go.
    const host = URL.parse(value)?.host;
    return (
      <span className="flex flex-col">
        <span className="break-all font-mono text-[12.5px]">{value}</span>
        <span>
          Calls go to <span className="font-medium">{host ?? "an address that can't be read"}</span>
        </span>
      </span>
    );
  }
  if (typeof value === "string") {
    // Shown whole, however long: this is what the owner approves.
    return value.includes("\n") || value.length > 80 ? <pre className="whitespace-pre-wrap break-words rounded-lg bg-hover p-2 font-sans text-[13px]">{value}</pre> : <span>{value === "" ? <span className="text-faint">empty</span> : value}</span>;
  }
  if (typeof value === "boolean") return <span>{value ? "yes" : "no"}</span>;
  if (list && list.every((v) => typeof v === "string")) return <span>{list.length ? list.join(", ") : <span className="text-faint">none</span>}</span>;
  return <pre className="whitespace-pre-wrap break-words rounded-lg bg-hover p-2 font-mono text-[12.5px]">{JSON.stringify(value, null, 2)}</pre>;
}

/** The writes of a proposal, each whole: what the owner approves, read from the server and not from the agent's words. */
export function ProposalItems({ proposal }: { proposal: ProposalView }) {
  return (
    <ol aria-label="What is proposed" className="space-y-3">
      {proposal.items.map((item, i) => (
        <li key={i} className="rounded-xl border border-line p-3">
          <p className="text-[14px] font-medium">
            <span className="mr-1.5 text-faint">{i + 1}.</span>
            {TITLES[item.tool] ?? item.tool}
            {item.used && <span className={`ml-2 text-[12px] font-normal ${item.failed ? "text-danger" : "text-faint"}`}>{item.failed ? "refused" : "done"}</span>}
          </p>
          <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-[13px]">
            {Object.entries((item.input ?? {}) as Record<string, unknown>).map(([name, value]) => (
              <div key={name} className="contents">
                <dt className="text-muted">{LABELS_OF[item.tool]?.[name] ?? LABELS[name] ?? name}</dt>
                <dd className="min-w-0">
                  {item.tool.startsWith("agents_") && name === "consults" ? (
                    <Consults value={value} items={proposal.items} names={proposal.names} />
                  ) : (
                    <Value name={name} value={value} items={proposal.items} names={proposal.names} isRef={item.refs.includes(name)} address={item.tool === "tools_add" && name === "url"} />
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </li>
      ))}
    </ol>
  );
}
