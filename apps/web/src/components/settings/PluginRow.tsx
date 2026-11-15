import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { Text } from "@dispand/domain";
import { useFormat } from "../../lib/format.ts";
import { useText } from "../../lib/message.ts";
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
  const { t } = useTranslation("plugins");
  const { list } = useFormat();
  const text = useText();
  const queryClient = useQueryClient();
  const refresh = () =>
    Promise.all(
      [orpc.plugins, orpc.skills, orpc.tools, orpc.agents, orpc.tables, orpc.triggers].map((procedures) => queryClient.invalidateQueries({ queryKey: procedures.key() })),
    );
  const update = useMutation(orpc.plugins.update.mutationOptions({ onSuccess: refresh }));
  // An update that needs the owner's eyes: what it would change, shown before it is applied.
  const [reviewing, setReviewing] = useState<UpdatePreview | null>(null);
  const [looking, setLooking] = useState(false);
  const updated = (result: { sha: string; failed?: { name: string; reason: Text }[]; leftBehind?: { name: string; reason: Text }[] }) => {
    void refresh();
    // What an element's own checks refused is said, not hidden.
    const sha = result.sha.slice(0, 7);
    const item = (f: { name: string; reason: Text }) => t("row.failedItem", { name: f.name, reason: text(f.reason) });
    const done = result.failed?.length ? t("row.updatedExcept", { sha, failed: list(result.failed.map(item)) }) : result.sha === p.sha ? t("row.upToDate") : t("row.updated", { sha });
    // A native install that didn't move: finished from its harness's workspace skills.
    const native = result.leftBehind?.length ? t("row.leftBehind", { harnesses: list(result.leftBehind.map(item)) }) : "";
    setNote(native ? [done, native] : [done]);
  };
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string[] | null>(null);
  const [settingUp, setSettingUp] = useState(false);
  const busy = update.isPending || looking;
  const available = [
    ...p.available.skills.map((s) => t("row.availableSkill", { name: s.name })),
    ...p.available.mcpServers.map((s) => t("row.availableServer", { name: s.name })),
    ...p.available.agents.map((a) => t("row.availableAgent", { name: a.name })),
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
              t("row.generated")
            ) : (
              <Trans t={t} i18nKey="row.from" values={{ marketplace: p.marketplace, sha: p.sha.slice(0, 7) }} components={[<span className="font-mono" />]} />
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {(p.definitions.primitives.length > 0 || p.definitions.agents.length > 0 || p.available.mcpServers.some((s) => s.type === "http" && s.settings.length === 0)) && (
            <Button size="sm" variant="ghost" aria-label={t("row.setUpLabel", { name: p.name })} disabled={busy} onClick={() => setSettingUp(true)}>
              {t("row.setUp")}
            </Button>
          )}
          {p.sha !== null && (
            <Button
              size="sm"
              variant="ghost"
              aria-label={t("row.updateLabel", { name: p.name })}
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
                }, t("row.updateFailed"))
              }
            >
              {update.isPending || looking ? t("row.updating") : t("row.update")}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="text-danger"
            aria-label={t("row.removeLabel", { name: p.name })}
            disabled={busy}
            onClick={() => setRemoving(true)}
          >
            {t("row.remove")}
          </Button>
        </div>
      </div>
      {p.sha !== null && (
        <p className="text-[13px]">
          <span className="text-muted">{t("row.skills")}</span>
          <span className="font-mono">{p.skills.map((s) => s.name).join(", ") || t("row.none")}</span>
        </p>
      )}
      {(
        [
          [t("row.tables"), p.tables],
          [t("row.fields"), p.fields],
        ] as const
      ).map(([label, named]) =>
        named.length > 0 ? (
          <p key={label} className="text-[13px]">
            <span className="text-muted">{label}</span>
            {named.map((n) => n.name).join(", ")}
          </p>
        ) : null,
      )}
      {p.tools.length > 0 && (
        <p className="text-[13px]">
          <span className="text-muted">{t("row.tools")}</span>
          {p.tools.map((tool) => tool.name).join(", ")}
        </p>
      )}
      {p.agents.length > 0 && (
        <p className="text-[13px]">
          <span className="text-muted">{t("row.agents")}</span>
          {p.agents.map((a) => a.name).join(", ")}
        </p>
      )}
      {p.triggers.length > 0 && (
        <p className="text-[13px]">
          <span className="text-muted">{t("row.triggers")}</span>
          {p.triggers.map((trigger) => trigger.name).join(", ")}
        </p>
      )}
      {(
        [
          [t("row.tableDefs"), p.definitions.primitives],
          [t("row.agentDefs"), p.definitions.agents],
          [t("row.triggerDefs"), p.definitions.triggers],
        ] as const
      ).map(([label, defs]) =>
        defs.length > 0 ? (
          <p key={label} className="text-[13px]">
            <span className="text-muted">{label}</span>
            {defs.map((d) => (d.setUp ? t("row.isSetUp", { name: d.name }) : d.name)).join(", ")}
          </p>
        ) : null,
      )}
      {available.length > 0 && (
        <p className="text-[13px]">
          <span className="text-muted">{t("row.available")}</span>
          {available.join(", ")}
        </p>
      )}
      {p.notImported.length > 0 && (
        <p className="text-[13px] text-faint">
          {t("row.neverImported", { count: p.notImported.length, components: list([...new Set(p.notImported.map((n) => n.component))]) })}
        </p>
      )}
      {note && (
        <div role="status" className="space-y-1 text-[13px] text-muted">
          {note.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
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
