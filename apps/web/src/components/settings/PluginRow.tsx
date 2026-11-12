import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { refusal } from "./PluginInstallSheet.tsx";
import { type api, orpc } from "../../lib/api.ts";

type Plugin = Awaited<ReturnType<typeof api.plugins.list>>[number];

/**
 * An installed plugin: where it came from and what it added, with Update and Remove. Removing
 * one keeps its agents and tools; a generated one lists what approved proposals created, which
 * removing it keeps too.
 */
export function PluginRow({ plugin: p }: { plugin: Plugin }) {
  const queryClient = useQueryClient();
  const refresh = () =>
    Promise.all(
      [orpc.plugins, orpc.skills, orpc.tools, orpc.agents].map((procedures) => queryClient.invalidateQueries({ queryKey: procedures.key() })),
    );
  const update = useMutation(orpc.plugins.update.mutationOptions({ onSuccess: refresh }));
  const uninstall = useMutation(orpc.plugins.uninstall.mutationOptions({ onSuccess: refresh }));
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const busy = update.isPending || uninstall.isPending;
  const available = [
    ...p.available.skills.map((s) => `${s.name} (skill)`),
    ...p.available.mcpServers.map((s) => `${s.name} (MCP server)`),
    ...p.available.agents.map((a) => `${a.name} (agent)`),
  ];

  async function run(action: () => Promise<unknown>, fallback: string) {
    setError(null);
    setNote(null);
    try {
      await action();
    } catch (e) {
      setError(refusal(e, fallback));
    }
  }

  return (
    <li className="space-y-2 px-5 py-4" aria-label={p.name}>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-60">
          <p className="truncate text-[15px] font-medium">{p.name}</p>
          <p className="text-[13px] text-muted">
            {p.sha === null ? (
              "Generated in this workspace: it lists what approved proposals created, and removing it keeps them"
            ) : (
              <>
                From {p.marketplace} · <span className="font-mono">{p.sha.slice(0, 7)}</span>. Removing it: its agents, tools and what it set up stay in your
                workspace
              </>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {p.sha !== null && (
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Update ${p.name}`}
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const { sha } = await update.mutateAsync({ id: p.id });
                  setNote(sha === p.sha ? "Already up to date." : `Updated to ${sha.slice(0, 7)}.`);
                }, "Could not update the plugin.")
              }
            >
              {update.isPending ? "Updating…" : "Update"}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="text-danger"
            aria-label={`Remove ${p.name}`}
            disabled={busy}
            onClick={() => void run(() => uninstall.mutateAsync({ id: p.id }), "Could not remove the plugin.")}
          >
            Remove
          </Button>
        </div>
      </div>
      {p.sha !== null && (
        <p className="text-[13px]">
          <span className="text-muted">Skills: </span>
          <span className="font-mono">{p.skills.map((s) => s.name).join(", ") || "none"}</span>
        </p>
      )}
      {(
        [
          ["Tables", p.tables],
          ["Fields", p.fields],
        ] as const
      ).map(([label, named]) =>
        named.length > 0 ? (
          <p key={label} className="text-[13px]">
            <span className="text-muted">{label}: </span>
            {named.map((n) => n.name).join(", ")}
          </p>
        ) : null,
      )}
      {p.tools.length > 0 && (
        <p className="text-[13px]">
          <span className="text-muted">Tools: </span>
          {p.tools.map((t) => t.name).join(", ")}
        </p>
      )}
      {p.agents.length > 0 && (
        <p className="text-[13px]">
          <span className="text-muted">Agents: </span>
          {p.agents.map((a) => a.name).join(", ")}
        </p>
      )}
      {p.triggers.length > 0 && (
        <p className="text-[13px]">
          <span className="text-muted">Triggers: </span>
          {p.triggers.map((t) => t.name).join(", ")}
        </p>
      )}
      {available.length > 0 && (
        <p className="text-[13px]">
          <span className="text-muted">Available, not imported: </span>
          {available.join(", ")}
        </p>
      )}
      {p.notImported.length > 0 && (
        <p className="text-[13px] text-faint">
          Never imported: {p.notImported.length} {p.notImported.length === 1 ? "item" : "items"} (
          {[...new Set(p.notImported.map((n) => n.component))].join(", ")})
        </p>
      )}
      {note && (
        <p role="status" className="text-[13px] text-muted">
          {note}
        </p>
      )}
      {error && (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}
    </li>
  );
}
