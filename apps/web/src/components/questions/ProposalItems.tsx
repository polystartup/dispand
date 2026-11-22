import type { Text } from "@dispand/domain";
import { Trans, useTranslation } from "react-i18next";
import { useFormat } from "../../lib/format.ts";
import { lineDiff } from "../../lib/line-diff.ts";
import { useText } from "../../lib/message.ts";
import { PluginInstallItem } from "./PluginInstallItem.tsx";
import { useFieldTypeLabel } from "../data/field-types.ts";
import type { FieldType } from "@dispand/domain/data/fields";

/** A proposal as the server gives it to its owner: every write, and a name for each id a write points at. */
export type ProposalView = {
  id: string;
  status: "draft" | "asked" | "approved" | "declined";
  /**
   * `refs`: the keys of the input that hold ids of the owner's things, read by name. An input may
   * hold `{ "$item": n }` where an id goes: what item `n` creates (`creates`), once made
   * `createdId`; `failed` when its call was refused.
   */
  items: { tool: string; input: unknown; used: boolean; pending?: boolean; refs: string[]; creates?: string | null; createdId?: string | null; failed?: boolean; tools?: { toolId: string | { $item: number }; runs: string[] }[]; shown?: unknown; /** An agent update's fields as they are now. */ before?: Record<string, unknown> }[];
  names: Record<string, { kind: string; name: string; detail?: Text }>;
  /** The generated plugin ("Generated: <business name>") that records what the items create. */
  plugin?: string | null;
};

/** The writes that can't be undone: their item says so. */
const IRREVERSIBLE = new Set(["tables_delete", "fields_delete", "fields_retype", "tools_delete", "agents_delete"]);

/** The text of `key` in the questions namespace when there is one (an unknown tool or field shows as it is named). */
function useWord() {
  const { t, i18n } = useTranslation("questions");
  return (key: string, fallback: string, values?: Record<string, unknown>) => (i18n.exists(`questions:${key}`) ? String(t(key as never, values as never)) : fallback);
}

/** What naming an agent on another's consult list gives each of them (`ConsultList` says it too; its own translation will read `questions:consultLine`). */

/** An agent's consult entries: each agent by name, whether it asks first, and what the pair can do. */
function Consults({ value, items, names }: { value: unknown; items: Items; names: ProposalView["names"] }) {
  const { t } = useTranslation("questions");
  const entries = Array.isArray(value) ? value.filter((e): e is { agentId: unknown } => typeof e === "object" && e !== null) : [];
  if (entries.length === 0) return <span className="text-faint">{t("proposal.none")}</span>;
  return (
    <span className="flex flex-col gap-1">
      {entries.map((e, i) => (
        <span key={i}>
          <Id value={e.agentId} items={items} names={names} />
        </span>
      ))}
      <span className="text-muted">{t("consultLine")}</span>
    </span>
  );
}
type Items = ProposalView["items"];

/** An agent's consult mode in words: auto grants every same-side agent, so it says so. */
function ConsultMode({ value }: { value: unknown }) {
  const word = useWord();
  return <span>{word(`proposal.consultModes.${String(value)}`, String(value))}</span>;
}

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
  const job = config.tableId === "job";
  const words = interaction ? "interactionOperations" : job ? "jobOperations" : "operations";
  const operations = Array.isArray(config.operations) ? config.operations.map((o) => word(`proposal.${words}.${String(o)}`, String(o))) : [];
  const fields = Array.isArray(config.fields) ? config.fields.filter((f) => typeof f === "string" || isItemRef(f)) : null;
  return (
    <span className="flex flex-col gap-1">
      <span>
        {interaction ? (
          t("proposal.interaction")
        ) : job ? (
          t("proposal.job")
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

/** The sentence each kind of item reads as, with its variant: whole, with values interpolated (`proposal.sentences`). */
function variantOf(item: Items[number]): string {
  const input = (item.input ?? {}) as Record<string, unknown>;
  if (item.tool === "tables_set_primitive") return input.primitive ? "_on" : "_off";
  if (item.tool === "agents_set_tool_permission") return `_${String(input.permission)}`;
  if (item.tool === "fields_create") return input.referencesTableId ? "_names" : "";
  if (item.tool === "plugins_add_server") return input.url ? "" : "_runner";
  if (item.tool === "memory_add" || item.tool === "memory_update") return input.tableId ? "_table" : "";
  return "";
}

/** What an item does, in one sentence: references by name (`<0/>`, `<1/>`, in the order of the item's `refs`), the rest as values. */
function Sentence({ item, items, names }: { item: Items[number]; items: Items; names: ProposalView["names"] }) {
  const { t, i18n } = useTranslation("questions");
  const fieldType = useFieldTypeLabel();
  const key = `proposal.sentences.${item.tool}${variantOf(item)}`;
  const count = typeof (item.input as { maxWorking?: unknown } | null)?.maxWorking === "number" ? (item.input as { maxWorking: number }).maxWorking : undefined;
  if (!i18n.exists(`questions:${key}`, { count })) return null;
  const input = (item.input ?? {}) as Record<string, unknown>;
  const ids = item.refs.filter((k) => typeof input[k] === "string" || isItemRef(input[k]));
  const values: Record<string, unknown> = { ...input, ...(item.tool === "marketplaces_add" && (item.shown as { url?: string } | undefined)?.url ? { url: (item.shown as { url: string }).url } : {}) };
  if (typeof input.type === "string" && item.tool.startsWith("fields_")) values.type = fieldType(input.type as FieldType);
  return <p className="mt-1 text-[13px]"><Trans t={t} i18nKey={key as never} count={count} values={values} components={ids.map((k) => <Id value={input[k]} items={items} names={names} />)} /></p>;
}

/** A change to an agent's text: every line, only the lines that changed marked. */
function LineDiff({ lines }: { lines: NonNullable<ReturnType<typeof lineDiff>> }) {
  const { t } = useTranslation("questions");
  return (
    <div className="rounded-lg bg-hover p-2 font-sans text-[13px]">
      {lines.map((l, i) => (
        <div key={i} data-change={l.kind} className={`whitespace-pre-wrap break-words before:mr-1.5 before:select-none ${l.kind === "add" ? "bg-green-500/15 before:content-['+']" : l.kind === "del" ? "bg-red-500/15 line-through before:content-['−']" : "text-muted before:content-['_'] before:invisible"}`}>
          {l.kind !== "same" && <span className="sr-only">{t(l.kind === "add" ? "proposal.added" : "proposal.removed")}</span>}
          {l.line}
        </div>
      ))}
    </div>
  );
}

/** A field of an agent that an update gives, as it is now and as it becomes (kept visible when equal: nothing is hidden by comparing with the live row). */
function Change({ before, after, ...rest }: { before: unknown; after: unknown; name: string; items: Items; names: ProposalView["names"]; isRef: boolean }) {
  const { t } = useTranslation("questions");
  const diff = typeof before === "string" && typeof after === "string" && (before.includes("\n") || after.includes("\n") || before.length > 80 || after.length > 80) ? lineDiff(before, after) : null;
  if (diff) return <LineDiff lines={diff} />;
  const show = (value: unknown) => (rest.name === "selfLearning" ? <Targets value={value} /> : rest.name === "consultMode" ? <ConsultMode value={value} /> : <Value {...rest} value={value} address={false} />);
  return (
    <span className="flex flex-col gap-1">
      <span><span className="text-muted">{t("proposal.was")} </span>{show(before)}</span>
      <span><span className="text-muted">{t("proposal.becomes")} </span>{show(after)}</span>
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
  const fieldType = useFieldTypeLabel();
  return (
    <>
      {proposal.plugin && (
        <p className="mb-2 text-[13px] text-muted [overflow-wrap:anywhere]">
          <Trans t={t} i18nKey="proposal.recorded" values={{ plugin: proposal.plugin }} components={[<span className="font-medium text-fg" />]} />
        </p>
      )}
    <ol aria-label={t("proposal.label")} className="min-w-0 space-y-3 [overflow-wrap:anywhere]">
      {proposal.items.map((item, i) => (
        <li key={i} className="rounded-xl border border-line p-3">
          <p className="text-[14px] font-medium">
            <span className="mr-1.5 text-faint">{i + 1}.</span>
            {word(`proposal.titles.${item.tool}`, item.tool)}
            {item.used && !item.pending && <span className={`ml-2 text-[12px] font-normal ${item.failed ? "text-danger" : "text-faint"}`}>{item.failed ? t("proposal.refused") : t("proposal.done")}</span>}
          </p>
          <Sentence item={item} items={proposal.items} names={proposal.names} />
          {IRREVERSIBLE.has(item.tool) && <p className="mt-1 text-[13px] font-medium text-danger">{t("proposal.undone")}</p>}
          {item.tool === "plugins_install" ? (
            <PluginInstallItem input={item.input as never} shown={item.shown as never} />
          ) : (
          <dl className="mt-2 grid grid-cols-[fit-content(40%)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
            {Object.entries((item.input ?? {}) as Record<string, unknown>).filter(([name]) => !(item.tools && name === "toolPermissions") && !(item.tool === "fields_retype" && name === "dryRun")).map(([name, value]) => (
              <div key={name} className="contents">
                <dt className="text-muted">{word(`proposal.labelsOf.${item.tool}.${name}`, word(`proposal.labels.${name}`, name))}</dt>
                <dd className="min-w-0">
                  {(proposal.status === "draft" || proposal.status === "asked") && item.before && name in item.before ? (
                    <Change name={name} before={item.before[name]} after={value} items={proposal.items} names={proposal.names} isRef={item.refs.includes(name)} />
                  ) : name === "toolIds" && item.tools && item.tools.length > 0 ? (
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
                  ) : item.tool.startsWith("agents_") && name === "consultMode" ? (
                    <ConsultMode value={value} />
                  ) : item.tool.startsWith("agents_") && name === "selfLearning" ? (
                    <Targets value={value} />
                  ) : item.tool.startsWith("fields_") && name === "type" && typeof value === "string" ? (
                    <span>{fieldType(value as FieldType)}</span>
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
