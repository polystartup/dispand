import type { Text } from "@dispand/domain";
import { Trans, useTranslation } from "react-i18next";
import { useFormat } from "../../lib/format.ts";
import { useText } from "../../lib/message.ts";
import { PluginInstallItem } from "./PluginInstallItem.tsx";

/** A proposal as the server gives it to its owner: every write, and a name for each id a write points at. */
export type ProposalView = {
  id: string;
  status: "draft" | "asked" | "approved" | "declined";
  /**
   * `refs`: the keys of the input that hold ids of the owner's things, read by name. An input may
   * hold `{ "$item": n }` where an id goes: what item `n` creates (`creates`), once made
   * `createdId`; `failed` when its call was refused.
   */
  items: { tool: string; input: unknown; used: boolean; refs: string[]; creates?: string | null; createdId?: string | null; failed?: boolean; tools?: { toolId: string | { $item: number }; runs: string[] }[]; shown?: unknown }[];
  names: Record<string, { kind: string; name: string; detail?: Text }>;
  /** The generated plugin ("Generated: <business name>") that records what the items create. */
  plugin?: string | null;
};

/** The text of `key` in the questions namespace when there is one (an unknown tool or field shows as it is named). */
function useWord() {
  const { t, i18n } = useTranslation("questions");
  return (key: string, fallback: string, values?: Record<string, unknown>) => (i18n.exists(`questions:${key}`) ? String(t(key as never, values as never)) : fallback);
}

/** What naming an agent on another's consult list gives each of them (`ConsultList` says it too; its own translation will read `questions:consultLine`). */
export const CONSULT_LINE = "It can steer this agent with its questions, and its answers may quote what it reads in tables this agent can't.";

/** An agent's consult entries: each agent by name, whether it asks first, and what the pair can do. */
function Consults({ value, items, names }: { value: unknown; items: Items; names: ProposalView["names"] }) {
  const { t } = useTranslation("questions");
  const entries = Array.isArray(value) ? value.filter((e): e is { agentId: unknown; ask?: unknown } => typeof e === "object" && e !== null) : [];
  if (entries.length === 0) return <span className="text-faint">{t("proposal.none")}</span>;
  return (
    <span className="flex flex-col gap-1">
      {entries.map((e, i) => (
        <span key={i}>
          <Id value={e.agentId} items={items} names={names} />
          {e.ask === true ? ` ${t("proposal.asksBeforeUse")}` : ""}
        </span>
      ))}
      <span className="text-muted">{t("consultLine")}</span>
    </span>
  );
}
type Items = ProposalView["items"];

/** An agent's self-learning targets in words; writing the workspace's memory says what it does. */
function Targets({ value }: { value: unknown }) {
  const { t } = useTranslation("questions");
  const word = useWord();
  const targets = Array.isArray(value) ? value : [];
  if (targets.length === 0) return <span className="text-faint">{t("proposal.nothing")}</span>;
  return (
    <span className="flex flex-col gap-1">
      {targets.map((target, i) => (
        <span key={i}>{word(`proposal.targets.${String(target)}`, String(target))}</span>
      ))}
      {targets.includes("workspace") && <span className="text-muted">{t("proposal.workspaceLine")}</span>}
    </span>
  );
}

/** `{ "$item": n }`: what item `n` of the same proposal creates. */
const isItemRef = (value: unknown): value is { $item: number } => typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { $item?: unknown }).$item === "number";

/** A reference to an earlier item, read as what it creates, and by name once made. */
function ItemRef({ at, items, names }: { at: number; items: Items; names: ProposalView["names"] }) {
  const { t } = useTranslation("questions");
  const word = useWord();
  const item = items[at];
  const what = word(`proposal.itemRef.${item?.creates}`, t("proposal.itemRef.thing", { n: at + 1 }), { n: at + 1 });
  return <span>{item?.createdId ? <Trans t={t} i18nKey="proposal.itemRefMade" values={{ what }} components={[<Ref id={item.createdId} names={names} />]} /> : what}</span>;
}

/** An id, or a reference to an earlier item where an id goes. */
function Id({ value, items, names }: { value: unknown; items: Items; names: ProposalView["names"] }) {
  return isItemRef(value) ? <ItemRef at={value.$item} items={items} names={names} /> : <Ref id={String(value)} names={names} />;
}

function Ref({ id, names }: { id: string; names: ProposalView["names"] }) {
  const text = useText();
  const { t } = useTranslation("questions");
  const found = names[id];
  if (!found) {
    return (
      <span role="alert" className="font-medium text-danger">
        {t("proposal.notYours", { id })}
      </span>
    );
  }
  return (
    <span>
      {found.name}
      {found.detail ? ` (${text(found.detail)})` : ""} <span className="font-mono text-[12px] text-faint">{id}</span>
    </span>
  );
}

/** A table-change trigger's config in words, its table and fields read by name. */
function ChangeConfig({ config, items, names }: { config: { tableId?: unknown; operations?: unknown; fields?: unknown }; items: Items; names: ProposalView["names"] }) {
  const { t } = useTranslation("questions");
  const word = useWord();
  const format = useFormat();
  const interaction = config.tableId === "interaction";
  const operations = Array.isArray(config.operations) ? config.operations.map((o) => word(`proposal.${interaction ? "interactionOperations" : "operations"}.${String(o)}`, String(o))) : [];
  const fields = Array.isArray(config.fields) ? config.fields.filter((f) => typeof f === "string" || isItemRef(f)) : null;
  return (
    <span className="flex flex-col gap-1">
      <span>
        {interaction ? (
          t("proposal.interaction")
        ) : (
          // A reference already says what it is ("the table item 1 creates"): "the table" isn't said twice.
          <Trans t={t} i18nKey={isItemRef(config.tableId) ? "proposal.changeRef" : "proposal.changeTable"} components={[<Id value={config.tableId} items={items} names={names} />]} />
        )}
      </span>
      <span>{operations.length ? t("proposal.when", { what: format.listOr(operations) }) : t("proposal.whenNothing")}</span>
      {fields && operations.length > 0 && (config.operations as unknown[]).includes("updated") && (
        <span className="flex flex-col">
          {t("proposal.onlyWhen")}
          {fields.map((id, i) => (
            <Id key={i} value={id} items={items} names={names} />
          ))}
        </span>
      )}
    </span>
  );
}

function Value({ name, value, items, names, isRef, address }: { name: string; value: unknown; items: Items; names: ProposalView["names"]; isRef: boolean; address: boolean }) {
  const { t } = useTranslation("questions");
  const word = useWord();
  const format = useFormat();
  const list = Array.isArray(value) ? value : null;
  if (isItemRef(value)) return <ItemRef at={value.$item} items={items} names={names} />;
  // Read by name, never taken on trust ("all" tables is not an id).
  if (isRef && value !== "all") {
    const ids = (list ?? [value]).filter((v) => typeof v === "string" || isItemRef(v));
    if (ids.length === 0) return <span className="text-faint">{t("proposal.none")}</span>;
    return (
      <span className="flex flex-col">
        {ids.map((id, i) => (
          <Id key={i} value={id} items={items} names={names} />
        ))}
      </span>
    );
  }
  if (typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "primitive") return <ChangeConfig config={value as never} items={items} names={names} />;
  // A poll's tool read by name, or as the item that adds it; the rest of its config as it is.
  if (typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "poll") {
    const { toolId, ...rest } = value as { toolId: unknown };
    return (
      <span className="flex flex-col gap-1">
        <span>
          <Trans t={t} i18nKey="proposal.polls" components={[<Id value={toolId} items={items} names={names} />]} />
        </span>
        <pre className="whitespace-pre-wrap break-words rounded-lg bg-hover p-2 font-mono text-[12.5px]">{JSON.stringify(rest, null, 2)}</pre>
      </span>
    );
  }
  // A primitive table's parent: a table, and whether every row must name one.
  if (typeof value === "object" && value !== null && "tableId" in value && "required" in value) {
    const parent = value as { tableId: unknown; required: unknown };
    return (
      <span>
        {parent.required === true ? <Trans t={t} i18nKey="proposal.parentRequired" components={[<Id value={parent.tableId} items={items} names={names} />]} /> : <Id value={parent.tableId} items={items} names={names} />}
      </span>
    );
  }
  if (name === "rateCap" && typeof value === "number") return <span>{t("proposal.rateCap", { value: format.number(value) })}</span>;
  if (name === "concurrency" && typeof value === "string") return <span>{word(`proposal.concurrency.${value}`, value)}</span>;
  if (name === "kind" && typeof value === "string") return <span>{word(`proposal.marketKinds.${value}`, value)}</span>;
  // A choice field's choices by their labels, never as JSON.
  if (name === "choices" && list && list.every((v) => typeof v === "object" && v !== null && typeof (v as { label?: unknown }).label === "string")) {
    return <span>{list.length ? format.list(list.map((c) => (c as { label: string }).label)) : <span className="text-faint">{t("proposal.none")}</span>}</span>;
  }
  if (address && typeof value === "string") {
    // The whole address, and the host it reaches set apart: that is where calls will go.
    const host = URL.parse(value)?.host;
    return (
      <span className="flex flex-col">
        <span className="break-all font-mono text-[12.5px]">{value}</span>
        <span>
          <Trans t={t} i18nKey="proposal.callsGo" values={{ host: host ?? t("proposal.unreadable") }} components={[<span className="font-medium" />]} />
        </span>
      </span>
    );
  }
  if (typeof value === "string") {
    // Shown whole, however long: this is what the owner approves.
    return value.includes("\n") || value.length > 80 ? <pre className="whitespace-pre-wrap break-words rounded-lg bg-hover p-2 font-sans text-[13px]">{value}</pre> : <span>{value === "" ? <span className="text-faint">{t("proposal.empty")}</span> : value}</span>;
  }
  if (typeof value === "boolean") return <span>{value ? t("proposal.yes") : t("proposal.no")}</span>;
  if (list && list.every((v) => typeof v === "string")) return <span>{list.length ? format.list(list) : <span className="text-faint">{t("proposal.none")}</span>}</span>;
  return <pre className="whitespace-pre-wrap break-words rounded-lg bg-hover p-2 font-mono text-[12.5px]">{JSON.stringify(value, null, 2)}</pre>;
}

/** The writes of a proposal, each whole: what the owner approves, read from the server and not from the agent's words. */
export function ProposalItems({ proposal }: { proposal: ProposalView }) {
  const { t } = useTranslation("questions");
  const word = useWord();
  const format = useFormat();
  return (
    <>
      {proposal.plugin && (
        <p className="mb-2 text-[13px] text-muted">
          <Trans t={t} i18nKey="proposal.recorded" values={{ plugin: proposal.plugin }} components={[<span className="font-medium text-fg" />]} />
        </p>
      )}
    <ol aria-label={t("proposal.label")} className="space-y-3">
      {proposal.items.map((item, i) => (
        <li key={i} className="rounded-xl border border-line p-3">
          <p className="text-[14px] font-medium">
            <span className="mr-1.5 text-faint">{i + 1}.</span>
            {word(`proposal.titles.${item.tool}`, item.tool)}
            {item.used && <span className={`ml-2 text-[12px] font-normal ${item.failed ? "text-danger" : "text-faint"}`}>{item.failed ? t("proposal.refused") : t("proposal.done")}</span>}
          </p>
          {item.tool === "plugins_install" ? (
            <PluginInstallItem input={item.input as never} shown={item.shown as never} />
          ) : (
          <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-[13px]">
            {Object.entries((item.input ?? {}) as Record<string, unknown>).filter(([name]) => !(item.tools && name === "toolPermissions")).map(([name, value]) => (
              <div key={name} className="contents">
                <dt className="text-muted">{word(`proposal.labelsOf.${item.tool}.${name}`, word(`proposal.labels.${name}`, name))}</dt>
                <dd className="min-w-0">
                  {name === "toolIds" && item.tools && item.tools.length > 0 ? (
                    <div className="space-y-2">
                      {item.tools.map((tool, index) => (
                        <div key={index} className="flex flex-col gap-1">
                          <Id value={tool.toolId} items={proposal.items} names={proposal.names} />
                          <span>{t("proposal.runsWithout", { runs: tool.runs.length ? format.list(tool.runs) : t("proposal.none") })}</span>
                          <span className="text-muted">{t("proposal.othersAsk")}</span>
                        </div>
                      ))}
                    </div>
                  ) : item.tool.startsWith("agents_") && name === "consults" ? (
                    <Consults value={value} items={proposal.items} names={proposal.names} />
                  ) : item.tool.startsWith("agents_") && name === "selfLearning" ? (
                    <Targets value={value} />
                  ) : (
                    <Value
                      name={name}
                      // A marketplace's address as the server will read it (GitHub's owner/repo made whole).
                      value={item.tool === "marketplaces_add" && name === "url" ? ((item.shown as { url?: string } | undefined)?.url ?? value) : value}
                      items={proposal.items}
                      names={proposal.names}
                      isRef={item.refs.includes(name)}
                      address={(item.tool === "tools_add" || item.tool === "plugins_add_server" || item.tool === "marketplaces_add") && name === "url"}
                    />
                  )}
                </dd>
              </div>
            ))}
          </dl>
          )}
        </li>
      ))}
    </ol>
    </>
  );
}
