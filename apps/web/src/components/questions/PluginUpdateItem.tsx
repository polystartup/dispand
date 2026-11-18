import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { orpc } from "../../lib/api.ts";
import { refusal } from "../../lib/refusal.ts";
import { label, says, type UpdateTableChange } from "../settings/PluginUpdate.tsx";
import type { InboxEntry } from "./InboxItem.tsx";
import { useText } from "../../lib/message.ts";

/** A value as plain text: a text as it is, anything else as JSON. */
const shown = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 2));

type Item = NonNullable<InboxEntry["update"]>["items"][number];

/** A table's changes Stem picked that remove values, each with the field's values now (what it may remove), as plain text. */
function TableRemovals({ item }: { item: Item }) {
  const { t } = useTranslation(["questions", "plugins"]);
  const { t: tp } = useTranslation("plugins");
  const held = item.merged as { keys: string[]; values: Record<string, { count: number; shown: [string, unknown][] }> };
  const changes = (item.next as { changes: UpdateTableChange[] }).changes.filter((c) => held.keys.includes(c.key));
  return (
    <ul className="space-y-2">
      {changes.map((c) => {
        const values = held.values[c.key] ?? { count: 0, shown: [] };
        return (
          <li key={c.key} className="space-y-1">
            <p>{says(tp, c)}</p>
            <p className="text-danger">{values.count ? t("update.removes", { count: values.count }) : t("update.removesNone")}</p>
            {values.count > 0 && <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-2 text-[12px]">{values.shown.map(([, v]) => shown(v)).join("\n")}</pre>}
            {values.count > values.shown.length && <p className="text-muted">{t("update.moreValues", { count: values.count - values.shown.length })}</p>}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A plugin update's Approval: each value Stem merged for it, answered on its own; for a table,
 * its changes that remove values, with those values. A yes applies
 * it while the field is still as the owner had it; a no keeps theirs. Until answered, theirs stays.
 */
export function PluginUpdateItem({ update, onNotices }: { update: NonNullable<InboxEntry["update"]>; /** What an answer couldn't make, said by the Inbox item, which outlives this. */ onNotices?: (notices: string[]) => void }) {
  const { t } = useTranslation(["questions", "agents", "plugins", "messages"]);
  const assistant = t("messages:agent.assistant.name");
  const queryClient = useQueryClient();
  const refresh = () => Promise.all([orpc.questions, orpc.plugins, orpc.agents, orpc.tools, orpc.triggers].map((p) => queryClient.invalidateQueries({ queryKey: p.key() })));
  const { t: tp } = useTranslation("plugins");
  const text = useText();
  const answer = useMutation(
    orpc.plugins.resolveConflict.mutationOptions({
      onSettled: refresh,
      // A table's change that went stale or was refused wasn't made: each said in a sentence.
      onSuccess: (result, input) => {
        const changes = (update.items.find((i) => i.id === input.id)?.next as { changes?: UpdateTableChange[] } | null)?.changes ?? [];
        const named = (key: string) => {
          const c = changes.find((c) => c.key === key);
          return c ? says(tp, c) : key;
        };
        onNotices?.([...(result.refused ?? []).map((r) => t("update.refusedChange", { change: named(r.key), reason: text(r.reason) })), ...(result.stale ?? []).map((key) => t("update.staleChange", { change: named(key) }))]);
      },
    }),
  );
  const field = (name: string) => label(tp, name);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[15px]">{update.plugin ? t("update.intro", { assistant, plugin: update.plugin.name }) : t("update.introUnnamed", { assistant })}</p>
      <ul className="space-y-2 text-[13px]">
        {update.items.map((c) => (
          <li key={c.id} aria-label={t("plugins:update.fieldOf", { name: c.name ?? c.kind, field: field(c.field) })} className="space-y-1 rounded-xl border border-border p-3">
            <p>
              <span className="font-medium text-fg">{c.name ?? c.kind}</span> <span className="text-faint">{t("plugins:update.dotField", { field: field(c.field) })}</span>
            </p>
            {c.kind === "table" ? (
              <TableRemovals item={c} />
            ) : (
              <>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-2 text-[12px]">{shown(c.merged)}</pre>
                <details>
                  <summary className="cursor-pointer text-muted">{t("agents:stem.compare")}</summary>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-2 text-[12px]">{shown(c.mine)}</pre>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-2 text-[12px]">{shown(c.next)}</pre>
                </details>
              </>
            )}
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
