import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { orpc } from "../../lib/api.ts";

/**
 * Strict permissions (design 6.6): on, a remembered choice holds only for the versions of the
 * tool, plugin, skill and agent it was given for; off, for the tool's address and transport.
 */
export function StrictPermissions() {
  const { t } = useTranslation("harnesses");
  const queryClient = useQueryClient();
  const current = useQuery(orpc.workspace.strictPermissions.queryOptions());
  const save = useMutation(orpc.workspace.setStrictPermissions.mutationOptions({ onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.workspace.strictPermissions.key() }) }));
  if (!current.data) return null;
  return (
    <section aria-labelledby="strict-permissions" className="mt-8">
      <h2 id="strict-permissions" className="text-[17px] font-medium tracking-tight">
        {t("strict.title")}
      </h2>
      <div className="rounded-2xl bg-surface px-5 py-4 shadow-card">
        <label className="flex items-start gap-3 text-[14px]">
          <input type="checkbox" className="mt-1 size-4 accent-[var(--color-accent)]" checked={current.data.strict} disabled={save.isPending} onChange={(e) => save.mutate({ strict: e.target.checked })} />
          <span>
            {t("strict.label")}
            <span className="block text-[12px] text-faint">{t("strict.off")}</span>
            <span className="block text-[12px] text-faint">{t("strict.on")}</span>
          </span>
        </label>
        {save.error && (
          <p role="alert" className="mt-2 text-[13px] text-danger">
            {save.error.message}
          </p>
        )}
      </div>
    </section>
  );
}
