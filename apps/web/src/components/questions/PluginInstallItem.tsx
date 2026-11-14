import { useQuery } from "@tanstack/react-query";
import { orpc } from "../../lib/api.ts";
import { AgentRights } from "../settings/PluginDefinitionPicks.tsx";

type Input = { marketplaceId?: string; entryName?: string; reviewed?: string; skills?: string[]; setup?: { primitives?: string[]; agents?: { name: string; harnessId: string }[]; triggers?: string[] } };

type Shown = { agents?: Parameters<typeof AgentRights>[0]["d"][] };

/**
 * A proposed plugin install as its owner reads it: the entry, what it brings in, and what each
 * agent it makes may do, as the server read the plugin when it was proposed. The install carries
 * that read's token, so a plugin changed since installs nothing.
 */
export function PluginInstallItem({ input, shown }: { input: Input; shown: Shown | undefined }) {
  const harnesses = useQuery(orpc.harnesses.list.queryOptions());
  const setup = input.setup ?? {};
  const agents = (setup.agents ?? []).map((a) => ({ ...a, definition: shown?.agents?.find((d) => d.name.toLowerCase() === a.name.toLowerCase()) }));
  const lines: [string, string][] = [
    ["Plugin", input.entryName ?? ""],
    ["Skills", (input.skills ?? []).join(", ") || "none"],
    ["Tables", (setup.primitives ?? []).join(", ") || "none"],
    ["Triggers", (setup.triggers ?? []).join(", ") || "none"],
  ];
  return (
    <div className="mt-2 space-y-2 text-[13px]">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5">
        {lines.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className="min-w-0">{value}</dd>
          </div>
        ))}
      </dl>
      {agents.length > 0 && (
        <ul aria-label="Agents it makes" className="space-y-2">
          {agents.map((a) => (
            <li key={a.name}>
              <span className="font-medium">{a.name}</span> <span className="text-muted">on {harnesses.data?.find((h) => h.id === a.harnessId)?.name ?? "a harness"}</span>
              {a.definition ? <AgentRights d={a.definition} /> : <p className="ml-7 text-[12px] text-danger">What it may do wasn't read: decline, and ask for it to be proposed again.</p>}
            </li>
          ))}
        </ul>
      )}
      <p className="text-muted">Every tool its agents get asks before each action; its servers and native install are yours to add. A plugin changed since it was proposed installs nothing.</p>
    </div>
  );
}
