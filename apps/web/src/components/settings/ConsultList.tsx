import { X } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CONSULT_LINE } from "../questions/ProposalItems.tsx";

export type ConsultEntry = { agentId: string; ask: boolean };
type OtherAgent = { id: string; name: string; bundles: string[] };

const configures = (bundles: string[]) => bundles.includes("configure");

/**
 * The agents this one may consult, each with its "ask before use" switch. An agent that changes
 * the workspace and one that doesn't never consult each other: only agents on this one's side can
 * be added, and an entry a bundle change put on the other side since is shown inactive.
 */
export function ConsultList({
  agentId,
  bundles,
  entries,
  agents,
  onChange,
}: {
  /** This agent, absent while it is being created. */
  agentId?: string;
  /** This agent's bundles as the form holds them. */
  bundles: string[];
  entries: ConsultEntry[];
  agents: OtherAgent[];
  onChange: (entries: ConsultEntry[]) => void;
}) {
  const sameSide = (a: OtherAgent) => configures(a.bundles) === configures(bundles);
  const addable = agents.filter((a) => a.id !== agentId && sameSide(a) && !entries.some((e) => e.agentId === a.id));
  return (
    <section aria-labelledby="agent-consults" className="space-y-2">
      <h3 id="agent-consults" className="text-[13px] font-medium text-muted">
        May consult
      </h3>
      <p className="text-[12px] text-faint">{CONSULT_LINE}</p>
      {entries.length === 0 ? (
        <p className="text-[13px] text-faint">No agents.</p>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {entries.map((e) => {
            const agent = agents.find((a) => a.id === e.agentId);
            const name = agent?.name ?? e.agentId;
            const inactive = agent && !sameSide(agent);
            return (
              <li key={e.agentId} className="space-y-1 px-3 py-2 text-[14px]">
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate">{name}</span>
                  <span className="flex shrink-0 items-center gap-3">
                    <label className="flex items-center gap-2 text-[12px] text-muted">
                      Ask before use
                      <input
                        type="checkbox"
                        role="switch"
                        aria-label={`Ask before consulting ${name}`}
                        checked={e.ask}
                        onChange={(ev) => onChange(entries.map((x) => (x.agentId === e.agentId ? { ...x, ask: ev.target.checked } : x)))}
                        className="size-4 accent-[var(--color-accent)]"
                      />
                    </label>
                    <button
                      type="button"
                      aria-label={`Remove ${name}`}
                      className="rounded p-0.5 text-muted hover:bg-hover"
                      onClick={() => onChange(entries.filter((x) => x.agentId !== e.agentId))}
                    >
                      <X className="size-3.5" />
                    </button>
                  </span>
                </div>
                {inactive && (
                  <p className="text-[12px] text-danger">
                    Inactive: one of the two changes the workspace and the other doesn't, so they can't consult each other.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {addable.length > 0 && (
        <Select value="" onValueChange={(id) => onChange([...entries, { agentId: id, ask: false }])}>
          <SelectTrigger aria-label="Add an agent to consult" className="w-full">
            <SelectValue placeholder="Add an agent to consult" />
          </SelectTrigger>
          <SelectContent>
            {addable.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </section>
  );
}
