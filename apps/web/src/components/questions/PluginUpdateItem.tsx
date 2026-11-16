import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { orpc } from "../../lib/api.ts";
import { refusal } from "../settings/PluginInstallSheet.tsx";
import type { InboxEntry } from "./InboxItem.tsx";

/** A value as plain text: a text as it is, anything else as JSON. */
const shown = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 2));

/**
 * A plugin update's Approval: each value Stem merged for it, answered on its own. A yes applies
 * it while the field is still as the owner had it; a no keeps theirs. Until answered, theirs stays.
 */
export function PluginUpdateItem({ update }: { update: NonNullable<InboxEntry["update"]> }) {
  const { t } = useTranslation(["questions", "agents", "plugins", "messages"]);
  const assistant = t("messages:agent.assistant.name");
  const queryClient = useQueryClient();
  const refresh = () => Promise.all([orpc.questions, orpc.plugins, orpc.agents, orpc.tools, orpc.triggers].map((p) => queryClient.invalidateQueries({ queryKey: p.key() })));
  const answer = useMutation(orpc.plugins.resolveConflict.mutationOptions({ onSettled: refresh }));
  const field = (name: string) => t(`plugins:update.field.${name}` as "plugins:update.field.name", { defaultValue: name });
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[15px]">{update.plugin ? t("update.intro", { assistant, plugin: update.plugin.name }) : t("update.introUnnamed", { assistant })}</p>
      <ul className="space-y-2 text-[13px]">
        {update.items.map((c) => (
          <li key={c.id} aria-label={t("plugins:update.fieldOf", { name: c.name ?? c.kind, field: field(c.field) })} className="space-y-1 rounded-xl border border-border p-3">
            <p>
              <span className="font-medium text-fg">{c.name ?? c.kind}</span> <span className="text-faint">{t("plugins:update.dotField", { field: field(c.field) })}</span>
            </p>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-2 text-[12px]">{shown(c.merged)}</pre>
            <details>
              <summary className="cursor-pointer text-muted">{t("agents:stem.compare")}</summary>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-2 text-[12px]">{shown(c.mine)}</pre>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-2 text-[12px]">{shown(c.next)}</pre>
            </details>
            <div className="flex gap-2">
              <Button type="button" size="sm" disabled={answer.isPending} onClick={() => answer.mutate({ id: c.id, choice: "accept", reviewed: c.reviewed })}>
                {t("agents:stem.accept", { assistant })}
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={answer.isPending} onClick={() => answer.mutate({ id: c.id, choice: "decline", reviewed: c.reviewed })}>
                {t("agents:stem.keepMine")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {answer.error && (
        <p role="alert" className="text-[13px] text-danger">
          {refusal(answer.error, t("update.failed"))}
        </p>
      )}
    </div>
  );
}
