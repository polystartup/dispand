import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { orpc } from "../../lib/api.ts";
import { selectClass } from "../data/NewFieldPopover.tsx";
import { FormField } from "../settings/parts.tsx";

/** A poll's settings as the sheet edits them: the arguments as the JSON text typed. */
export type PollForm = { toolId: string; action: string; arguments: string; itemsPath: string; idPath: string; interval: number };
type PollItem = { itemId: string; status: string; runId?: string; message?: string };
export type PollRecord = { at: Date; status: string; found: number; fresh: number; message?: string; items: PollItem[] };

const pollText: Record<string, (p: PollRecord) => string> = {
  calling: () => "Calling the tool…",
  baseline: (p) => `First poll: ${p.found} item(s) recorded, no Job${p.message ? ` (${p.message})` : ""}`,
  polled: (p) => `${p.found} item(s), ${p.fresh} new${p.message ? ` (${p.message})` : ""}`,
  skipped: (p) => `Skipped: ${p.message ?? ""}`,
  failed: (p) => `Failed: ${p.message ?? ""}`,
};

const itemText: Record<string, string> = {
  started: "Started a Job",
  deferred: "Waiting: the hour's cap is reached, or a Job is still going",
  "out-of-scope": "Skipped: the agent may no longer read this action",
  refused: "Refused",
};

const when = (date: Date) => new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(date);

/**
 * A poll trigger's settings: the tool and one of its actions a poll may read, the arguments
 * (`{{lastPoll}}` for "newer than"), where the items and their ids are, how often, how many Jobs
 * an hour at most, and what its latest polls found.
 */
export function PollTriggerPanel({
  agentId,
  config,
  rateCap,
  polls,
  onChange,
  onRateCap,
}: {
  agentId: string;
  config: PollForm;
  rateCap: number;
  polls: PollRecord[];
  onChange: (config: PollForm) => void;
  onRateCap: (cap: number) => void;
}) {
  // The agent's own tools, chosen or through its skills: a poll reads no more than its agent may.
  const agent = useQuery(orpc.agents.get.queryOptions({ input: { id: agentId } }));
  const actions = useQuery({ ...orpc.tools.pollable.queryOptions({ input: { id: config.toolId } }), enabled: !!config.toolId });
  // Only what a poll may read now, and the action already chosen (the server says why it no longer may).
  const pollable = (actions.data ?? []).filter((a) => a.pollable || a.name === config.action);

  return (
    <>
      <FormField label="Tool" htmlFor="trigger-tool" hint="One of the agent's tools: the trigger calls it on its own, outside any Job.">
        <select id="trigger-tool" className={selectClass} value={config.toolId} onChange={(e) => onChange({ ...config, toolId: e.target.value, action: "" })}>
          <option value="">Pick a tool</option>
          {(agent.data?.tools ?? []).map((t) => (
            <option key={t.toolId} value={t.toolId}>
              {t.name}
            </option>
          ))}
        </select>
      </FormField>
      {config.toolId && (
        <FormField
          label="Action"
          htmlFor="trigger-action"
          hint={actions.isSuccess && pollable.length === 0 ? "No action of this tool may be read by a poll: let polls read one on the tool's page." : "Only actions polls may read: read-only, and no agent asks before using them."}
        >
          <select id="trigger-action" className={selectClass} value={config.action} onChange={(e) => onChange({ ...config, action: e.target.value })}>
            <option value="">Pick an action</option>
            {pollable.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
              </option>
            ))}
          </select>
        </FormField>
      )}
      <FormField label="Arguments (JSON)" htmlFor="trigger-arguments" hint="{{lastPoll}} in a value stands for when the newest item was found.">
        <Textarea id="trigger-arguments" rows={3} className="font-mono text-[13px]" value={config.arguments} onChange={(e) => onChange({ ...config, arguments: e.target.value })} />
      </FormField>
      <FormField label="Items at" htmlFor="trigger-items-path" hint="Where the list is in the result, keys between dots (value, data.items); empty when the result is the list.">
        <Input id="trigger-items-path" value={config.itemsPath} maxLength={200} onChange={(e) => onChange({ ...config, itemsPath: e.target.value })} />
      </FormField>
      <FormField label="Item id at" htmlFor="trigger-id-path" hint="What identifies an item, within it (id).">
        <Input id="trigger-id-path" value={config.idPath} maxLength={200} onChange={(e) => onChange({ ...config, idPath: e.target.value })} />
      </FormField>
      <FormField label="Every (minutes)" htmlFor="trigger-interval">
        <Input id="trigger-interval" type="number" min={1} max={1440} value={config.interval / 60} onChange={(e) => onChange({ ...config, interval: Math.round(Number(e.target.value) * 60) })} />
      </FormField>
      <FormField label="At most, Jobs an hour" htmlFor="trigger-rate-cap" hint="Past it, new items wait their turn: none is lost.">
        <Input id="trigger-rate-cap" type="number" min={1} max={1000} value={rateCap} onChange={(e) => onRateCap(Number(e.target.value))} />
      </FormField>
      {polls.length > 0 && (
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-muted">Latest polls</p>
          <ul aria-label="Latest polls" className="space-y-2 text-[14px]">
            {polls.map((p) => (
              <li key={p.at.toISOString()}>
                <div className="flex flex-wrap justify-between gap-x-3">
                  <span className="text-muted">{when(p.at)}</span>
                  <span className={p.status === "failed" || p.status === "skipped" ? "text-danger" : undefined}>{pollText[p.status]?.(p) ?? p.status}</span>
                </div>
                {p.items.length > 0 && p.status === "polled" && (
                  <ul className="mt-1 space-y-0.5 pl-4 text-[13px]">
                    {p.items.map((i) => (
                      <li key={i.itemId} className="flex flex-wrap justify-between gap-x-3">
                        <span className="truncate font-mono">{i.itemId}</span>
                        {i.status === "started" && i.runId ? (
                          <a href={`/settings/workflows/runs/${i.runId}`}>{itemText.started}</a>
                        ) : (
                          <span className={i.status === "deferred" ? undefined : "text-danger"}>{i.message && i.status !== "deferred" ? `${itemText[i.status] ?? i.status}: ${i.message}` : itemText[i.status]}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
