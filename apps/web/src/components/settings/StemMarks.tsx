import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { orpc } from "../../lib/api.ts";
import { refusal } from "./PluginInstallSheet.tsx";

/** A value as plain text: a text as it is, anything else as JSON. */
const shown = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 2));

/**
 * On a plugin's agent, tool or trigger: each field an update changed that the owner had changed
 * too and handed to Stem. Stem is looking; or its merged value waits for the owner's yes; or the
 * field is theirs to decide again, with the three choices of the update's screen.
 */
export function StemMarks({ kind, id, labels, onResolved }: { kind: "agent" | "tool" | "trigger"; id: string; labels: Record<string, string>; /** The field may have changed: the page starts over from the saved element. */ onResolved: () => void }) {
  const { t } = useTranslation("agents");
  const { t: tm } = useTranslation("messages");
  const assistant = tm("agent.assistant.name");
  const queryClient = useQueryClient();
  // While Stem is looking, asked again until it is done.
  const conflicts = useQuery({ ...orpc.plugins.conflicts.queryOptions({ input: { kind, id } }), refetchInterval: (q) => (q.state.data?.some((c) => c.status === "stem") ? 3000 : false) });
  const refresh = () => Promise.all([orpc.plugins, orpc.agents, orpc.tools, orpc.triggers].map((p) => queryClient.invalidateQueries({ queryKey: p.key() })));
  const resolve = useMutation(
    orpc.plugins.resolveConflict.mutationOptions({
      // The saved element first, then the editor starts over from it.
      onSuccess: async () => {
        await refresh();
        onResolved();
      },
      onError: () => refresh(),
    }),
  );
  if (!conflicts.data?.length) return null;
  const busy = resolve.isPending;
  const choose = (conflictId: string, choice: "accept" | "decline" | "mine" | "plugin" | "stem") => resolve.mutate({ id: conflictId, choice, reviewed: conflicts.data!.find((c) => c.id === conflictId)!.reviewed });
  return (
    <ul aria-label={t("stem.label")} className="space-y-2 text-[13px]">
      {conflicts.data.map((c) => {
        const label = labels[c.field] ?? c.field;
        return (
          <li key={c.id} className="space-y-1 rounded-xl border border-border p-3">
            <p>
              <span className="font-medium text-fg">{label}</span>{" "}
              <span className="text-muted">{c.status === "stem" ? t("stem.looking", { assistant }) : c.status === "approval" ? t("stem.approval", { assistant }) : t("stem.open")}</span>
            </p>
            {c.status === "approval" && (
              <>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-2 text-[12px]">{shown(c.merged)}</pre>
                <div className="flex gap-2">
                  <Button type="button" size="sm" disabled={busy} onClick={() => choose(c.id, "accept")}>{t("stem.accept", { assistant })}</Button>
                  <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => choose(c.id, "decline")}>{t("stem.keepMine")}</Button>
                </div>
              </>
            )}
            {c.status === "open" && (
              <>
                <details>
                  <summary className="cursor-pointer text-muted">{t("stem.compare")}</summary>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-2 text-[12px]">{shown(c.mine)}</pre>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-2 text-[12px]">{shown(c.next)}</pre>
                </details>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => choose(c.id, "mine")}>{t("stem.keepMine")}</Button>
                  <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => choose(c.id, "plugin")}>{t("stem.takePlugin")}</Button>
                  <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => choose(c.id, "stem")}>{t("stem.delegate", { assistant })}</Button>
                </div>
              </>
            )}
          </li>
        );
      })}
      {resolve.error && <li role="alert" className="text-danger">{refusal(resolve.error, t("stem.failed"))}</li>}
    </ul>
  );
}
