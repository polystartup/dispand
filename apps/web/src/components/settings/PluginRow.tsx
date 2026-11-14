import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { refusal } from "./PluginInstallSheet.tsx";
import { PluginRemoveSheet } from "./PluginRemoveSheet.tsx";
import { PluginSetupSheet } from "./PluginSetupSheet.tsx";
import { api, orpc } from "../../lib/api.ts";
import { needsReview } from "./PluginUpdate.tsx";
import { PluginUpdateSheet, type UpdatePreview } from "./PluginUpdateSheet.tsx";

type Plugin = Awaited<ReturnType<typeof api.plugins.list>>[number];

/** Installed components are removed only through the explicit checklist; generated items stay. */
export function PluginRow({ plugin: p }: { plugin: Plugin }) {
  const queryClient = useQueryClient();
  const refresh = () =>
    Promise.all(
      [orpc.plugins, orpc.skills, orpc.tools, orpc.agents, orpc.tables, orpc.triggers].map((procedures) => queryClient.invalidateQueries({ queryKey: procedures.key() })),
    );
  const update = useMutation(orpc.plugins.update.mutationOptions({ onSuccess: refresh }));
  // An update that needs the owner's eyes: what it would change, shown before it is applied.
  const [reviewing, setReviewing] = useState<UpdatePreview | null>(null);
  const [looking, setLooking] = useState(false);
  const updated = (result: { sha: string; failed?: { name: string; reason: string }[] }) => {
    void refresh();
    // What an element's own checks refused is said, not hidden.
    setNote(
      result.failed?.length
        ? `Updated to ${result.sha.slice(0, 7)}, except ${result.failed.map((f) => `${f.name} (${f.reason})`).join("; ")}.`
        : result.sha === p.sha
          ? "Already up to date."
          : `Updated to ${result.sha.slice(0, 7)}.`,
    );
  };
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [settingUp, setSettingUp] = useState(false);
  const busy = update.isPending || looking;
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
                From {p.marketplace} · <span className="font-mono">{p.sha.slice(0, 7)}</span>. Choose what to remove; items you keep stay in your workspace
              </>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {(p.definitions.primitives.length > 0 || p.definitions.agents.length > 0 || p.available.mcpServers.some((s) => s.type === "http" && s.settings.length === 0)) && (
            <Button size="sm" variant="ghost" aria-label={`Set up ${p.name}`} disabled={busy} onClick={() => setSettingUp(true)}>
              Set up
            </Button>
          )}
          {p.sha !== null && (
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Update ${p.name}`}
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setLooking(true);
                  try {
                    const preview = await api.plugins.updatePreview({ id: p.id });
                    if (needsReview(preview)) setReviewing(preview);
                    else updated(await update.mutateAsync({ id: p.id, reviewed: preview.reviewed }));
                  } finally {
                    setLooking(false);
                  }
                }, "Could not update the plugin.")
              }
            >
              {update.isPending || looking ? "Updating…" : "Update"}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="text-danger"
            aria-label={`Remove ${p.name}`}
            disabled={busy}
            onClick={() => setRemoving(true)}
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
      {(
        [
          ["Table definitions", p.definitions.primitives],
          ["Agent definitions", p.definitions.agents],
          ["Trigger definitions", p.definitions.triggers],
        ] as const
      ).map(([label, defs]) =>
        defs.length > 0 ? (
          <p key={label} className="text-[13px]">
            <span className="text-muted">{label}: </span>
            {defs.map((d) => (d.setUp ? `${d.name} (set up)` : d.name)).join(", ")}
          </p>
        ) : null,
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
      {removing && <PluginRemoveSheet id={p.id} name={p.name} onClose={() => setRemoving(false)} />}
      {settingUp && <PluginSetupSheet plugin={p} onClose={() => setSettingUp(false)} />}
      {reviewing && (
        <PluginUpdateSheet
          id={p.id}
          name={p.name}
          preview={reviewing}
          onClose={() => setReviewing(null)}
          onUpdated={(result) => {
            updated(result);
            // What the version adds is made from Set up, which shows what each would be allowed to do: opened once the row holds the new definitions.
            if (reviewing.additions.length) void refresh().then(() => setSettingUp(true));
          }}
        />
      )}
    </li>
  );
}
