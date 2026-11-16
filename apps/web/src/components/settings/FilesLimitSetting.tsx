import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { orpc } from "../../lib/api.ts";
import { useFormat } from "../../lib/format.ts";

/**
 * The install's limit on its files, in MiB: past it, a tool result's files are refused whole
 * (`keepJobFiles`). Files already kept stay.
 */
export function FilesLimitSetting() {
  const { t } = useTranslation("harnesses");
  const format = useFormat();
  const queryClient = useQueryClient();
  const current = useQuery(orpc.workspace.filesLimit.queryOptions());
  // What is typed, while editing; otherwise the field follows the setting (another tab).
  const [typed, setTyped] = useState<string | null>(null);
  const save = useMutation(orpc.workspace.setFilesLimit.mutationOptions({ onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.workspace.filesLimit.key() }) }));
  if (!current.data) return null;
  const value = typed ?? String(current.data.mib);
  const n = Number(value);
  const valid = Number.isInteger(n) && n >= 1 && n <= 1_048_576;
  return (
    <section aria-labelledby="files-limit" className="mt-8">
      <h2 id="files-limit" className="text-[17px] font-medium tracking-tight">
        {t("filesLimit.title")}
      </h2>
      <p className="mb-3 text-[13px] text-muted">{t("filesLimit.text")}</p>
      <form
        className="flex flex-wrap items-center gap-2 rounded-2xl bg-surface px-5 py-4 shadow-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate({ mib: n }, { onSuccess: () => setTyped(null) });
        }}
      >
        <label htmlFor="files-limit-mib" className="text-[13px] text-muted">
          {t("filesLimit.before")}
        </label>
        <Input
          id="files-limit-mib"
          type="number"
          min={1}
          max={1048576}
          value={value}
          onChange={(e) => setTyped(e.target.value)}
          aria-invalid={!valid}
          className="w-32"
        />
        <span className="text-[13px] text-muted">{t("filesLimit.after")}</span>
        <Button type="submit" variant="outline" disabled={!valid || n === current.data.mib || save.isPending}>
          {t("filesLimit.save")}
        </Button>
        {!valid && (
          <p role="alert" className="w-full text-[13px] text-danger">
            {t("filesLimit.range", { min: format.number(1), max: format.number(1_048_576) })}
          </p>
        )}
        {save.error && (
          <p role="alert" className="w-full text-[13px] text-danger">
            {save.error.message}
          </p>
        )}
      </form>
    </section>
  );
}
