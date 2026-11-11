/** A proposal as the server gives it to its owner: every write, and a name for each id a write points at. */
export type ProposalView = {
  id: string;
  status: "draft" | "asked" | "approved" | "declined";
  /** `refs`: the keys of the input that hold ids of the owner's things, read by name. */
  items: { tool: string; input: unknown; used: boolean; refs: string[] }[];
  names: Record<string, { kind: string; name: string; detail?: string }>;
};

const TITLES: Record<string, string> = {
  agents_create: "Create an agent",
  agents_update: "Change an agent",
  agents_set_tool_ask: "Change whether an action asks before use",
  tables_delete: "Delete a table, with its rows",
  fields_delete: "Delete a field, with its values",
};
/** What a key is called, by tool where one name isn't enough. */
const LABELS_OF: Record<string, Record<string, string>> = {
  tables_delete: { id: "Table" },
  fields_delete: { id: "Field" },
  agents_set_tool_ask: { agentId: "Agent", toolId: "Tool", action: "Action", ask: "Asks before use" },
};
const LABELS: Record<string, string> = {
  id: "Agent",
  name: "Name",
  harnessId: "Harness",
  systemPrompt: "Instructions",
  model: "Model",
  skillPackageIds: "Skills",
  toolIds: "Tools",
  bundles: "What its Jobs may do",
  dataTables: "Tables",
};
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

function Value({ value, names, isRef }: { value: unknown; names: ProposalView["names"]; isRef: boolean }) {
  const list = Array.isArray(value) ? value : null;
  // Read by name, never taken on trust ("all" tables is not an id).
  if (isRef && value !== "all") {
    const ids = (list ?? [value]).filter((v): v is string => typeof v === "string");
    if (ids.length === 0) return <span className="text-faint">none</span>;
    return (
      <span className="flex flex-col">
        {ids.map((id) => (
          <Ref key={id} id={id} names={names} />
        ))}
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
            {TITLES[item.tool] ?? item.tool}
            {item.used && <span className="ml-2 text-[12px] font-normal text-faint">done</span>}
          </p>
          <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-[13px]">
            {Object.entries((item.input ?? {}) as Record<string, unknown>).map(([name, value]) => (
              <div key={name} className="contents">
                <dt className="text-muted">{LABELS_OF[item.tool]?.[name] ?? LABELS[name] ?? name}</dt>
                <dd className="min-w-0">
                  <Value value={value} names={proposal.names} isRef={item.refs.includes(name)} />
                </dd>
              </div>
            ))}
          </dl>
        </li>
      ))}
    </ol>
  );
}
