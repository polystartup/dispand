import { useQuery } from "@tanstack/react-query";
import { orpc } from "../../lib/api.ts";
import { AgentRights } from "../settings/PluginDefinitionPicks.tsx";

type Input = { marketplaceId?: string; entryName?: string; reviewed?: string; skills?: string[]; setup?: { primitives?: string[]; agents?: { name: string; harnessId: string }[]; triggers?: string[] } };

/**
 * A proposed plugin install as its owner reads it: the entry, what it brings in, and what each
 * of its agents may do, read from the plugin as it is now. When it changed since it was
 * proposed, approving installs nothing: the install carries the token of what was read.
 */
export function PluginInstallItem({ input }: { input: Input }) {
  const ref = { marketplaceId: input.marketplaceId ?? "", entryName: input.entryName ?? "" };
  const preview = useQuery({ ...orpc.plugins.preview.queryOptions({ input: ref }), retry: false, staleTime: Infinity });
  const harnesses = useQuery(orpc.harnesses.list.queryOptions());
  const setup = input.setup ?? {};
  const agents = (setup.agents ?? []).map((a) => ({ ...a, definition: preview.data?.definitions.agents.find((d) => d.name.toLowerCase() === a.name.toLowerCase()) }));
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
              {a.definition && <AgentRights d={a.definition} />}
            </li>
          ))}
        </ul>
      )}
      <p className="text-muted">Every tool its agents get asks before each action; its servers and native install are yours to add.</p>
      {preview.error && <p className="text-danger">The plugin couldn't be read: approving may install nothing.</p>}
      {preview.data && preview.data.reviewed !== input.reviewed && <p role="alert" className="text-danger">The plugin changed since this was proposed: approving installs nothing. Ask for it to be proposed again.</p>}
    </div>
  );
}
