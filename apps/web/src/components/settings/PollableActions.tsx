import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useFormat } from "../../lib/format.ts";
import { orpc } from "../../lib/api.ts";

/**
 * Which of a tool's actions a poll may read (design 6.7): the owner's choice, defaulting to what
 * the server marks read-only; an action an agent must ask before using is never polled, and says why.
 */
export function PollableActions({ toolId }: { toolId: string }) {
  const { t } = useTranslation("tools");
  const { list } = useFormat();
  const queryClient = useQueryClient();
  const actions = useQuery(orpc.tools.pollable.queryOptions({ input: { id: toolId } }));
  const save = useMutation(orpc.tools.setPollable.mutationOptions({ onSuccess: (data) => queryClient.setQueryData(orpc.tools.pollable.queryKey({ input: { id: toolId } }), data) }));
  if (!actions.data?.length) return null;
  const allowed = actions.data.filter((a) => a.allowed).map((a) => a.name);
  return (
    <section aria-labelledby="tool-pollable" className="space-y-2">
      <h2 id="tool-pollable" className="text-[15px] font-medium">
        {t("pollable.title")}
      </h2>
      <p className="text-[13px] text-muted">{t("pollable.text")}</p>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {actions.data.map((a) => (
          <li key={a.name} className="px-4 py-2.5">
            <label className="flex items-center gap-2 text-[13.5px]">
              <input
                type="checkbox"
                checked={a.allowed}
                disabled={save.isPending || a.disabled}
                onChange={(e) => save.mutate({ id: toolId, actions: e.target.checked ? [...allowed, a.name] : allowed.filter((n) => n !== a.name) })}
                className="size-4 accent-[var(--color-accent)]"
              />
              <span className="font-mono">{a.name}</span>
              {a.readOnly && <span className="text-[12px] text-faint">{t("pollable.readOnly")}</span>}
            </label>
            {a.disabled && <p className="mt-1 pl-6 text-[12px] text-muted">{t("pollable.disabled")}</p>}
            {!a.disabled && a.allowed && a.askedBy.length > 0 && (
              <p className="mt-1 pl-6 text-[12px] text-danger">{t("pollable.asked", { agents: list(a.askedBy) })}</p>
            )}
          </li>
        ))}
      </ul>
      {save.error && (
        <p role="alert" className="text-[13px] text-danger">
          {save.error.message}
        </p>
      )}
    </section>
  );
}
