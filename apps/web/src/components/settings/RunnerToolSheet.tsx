import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { orpc } from "../../lib/api.ts";
import { FormField } from "./parts.tsx";
import { PollableActions } from "./PollableActions.tsx";
import { ActionItem, errorMessage, type Tool } from "./ToolSheet.tsx";

type Props = {
  /** The runner tool being edited; absent when adding one. */
  tool?: Tool;
  /** When adding: the name and the server to preselect, and the catalog entry they come from. */
  suggested?: { name: string; runnerTool: string; catalogId?: string };
  onClose: () => void;
  onSaved: (tool: Tool) => void;
};

/**
 * "Add runner tool": one of the MCP servers a runner's own config names, picked by its runner.
 * Dispand never learns its command or keys. Mount it only while open.
 */
export function RunnerToolSheet({ tool, suggested, onClose, onSaved }: Props) {
  const { t } = useTranslation("tools");
  const runners = useQuery(orpc.runners.list.queryOptions({ refetchInterval: 5000 }));
  const [name, setName] = useState(tool?.name ?? suggested?.name ?? "");
  const [runnerId, setRunnerId] = useState(tool?.runnerId ?? "");
  const [runnerTool, setRunnerTool] = useState(tool?.runnerTool ?? suggested?.runnerTool ?? "");
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState(tool);

  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: orpc.tools.key() });
  const create = useMutation(orpc.tools.create.mutationOptions({ onSuccess: invalidate }));
  const update = useMutation(orpc.tools.update.mutationOptions({ onSuccess: invalidate }));
  const refresh = useMutation(orpc.tools.refresh.mutationOptions({ onSuccess: invalidate }));
  const del = useMutation(orpc.tools.delete.mutationOptions({ onSuccess: invalidate }));
  const actionEnabled = useMutation(orpc.tools.setActionEnabled.mutationOptions({
    onSuccess: async (saved) => {
      setCurrent(saved);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: orpc.tools.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.agents.key() }),
      ]);
    },
    onError: (e) => setError(errorMessage(e, t("sheet.actionFailed"))),
  }));
  const busy = actionEnabled.isPending || create.isPending || update.isPending || del.isPending || refresh.isPending;

  const runner = runners.data?.find((r) => r.id === runnerId);
  // The servers the picked runner reports, and the saved one even if it no longer does.
  const servers = [...new Set([...(runner?.tools ?? []), ...(current && current.runnerId === runnerId && current.runnerTool ? [current.runnerTool] : [])])];

  async function save() {
    setError(null);
    try {
      const saved = current
        ? await update.mutateAsync({ id: current.id, name, runnerId, runnerTool })
        : await create.mutateAsync({ kind: "runner", name, runnerId, runnerTool, ...(suggested?.catalogId ? { catalogId: suggested.catalogId } : {}) });
      onSaved(saved);
    } catch (e) {
      setError(errorMessage(e, t("sheet.saveFailed")));
    }
  }

  async function reload() {
    if (!current) return;
    setError(null);
    try {
      setCurrent(await refresh.mutateAsync({ id: current.id }));
    } catch {
      setError(t("sheet.refreshFailed"));
    }
  }

  async function remove() {
    if (!current) return;
    setError(null);
    try {
      await del.mutateAsync({ id: current.id });
      onClose();
    } catch (e) {
      setError(errorMessage(e, t("sheet.deleteFailed")));
    }
  }

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto bg-surface sm:max-w-lg">
        <SheetHeader className="px-6 pt-6">
          <SheetTitle className="text-[20px] tracking-tight">{current ? current.name : t("runnerSheet.add")}</SheetTitle>
          <SheetDescription>{t("runnerSheet.description")}</SheetDescription>
        </SheetHeader>
        <div className="space-y-8 px-6 pb-6">
          <form
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <FormField label={t("sheet.name")} htmlFor="runner-tool-name">
              <Input id="runner-tool-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required autoFocus={!current} />
            </FormField>
            <FormField label={t("runnerSheet.runner")} htmlFor="runner-tool-runner">
              <Select
                value={runnerId}
                onValueChange={(v) => {
                  setRunnerId(v);
                  if (!runners.data?.find((r) => r.id === v)?.tools.includes(runnerTool)) setRunnerTool(suggested?.runnerTool ?? "");
                }}
              >
                <SelectTrigger id="runner-tool-runner" className="w-full">
                  <SelectValue placeholder={t("runnerSheet.pickRunner")} />
                </SelectTrigger>
                <SelectContent>
                  {runners.data?.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField
              label={t("runnerSheet.server")}
              htmlFor="runner-tool-server"
              hint={
                runner && servers.length === 0
                  ? t("runnerSheet.noServer")
                  : runner && suggested && !servers.includes(suggested.runnerTool)
                    ? t("runnerSheet.notReported", { server: suggested.runnerTool })
                    : t("runnerSheet.serverHint")
              }
            >
              <Select value={runnerTool} onValueChange={setRunnerTool} disabled={!runner}>
                <SelectTrigger id="runner-tool-server" className="w-full">
                  <SelectValue placeholder={t("runnerSheet.pickServer")} />
                </SelectTrigger>
                <SelectContent>
                  {servers.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            {error && (
              <p role="alert" className="text-[13px] text-danger">
                {error}
              </p>
            )}
            <div className="flex items-center gap-2 pt-1">
              <Button type="submit" disabled={busy || !name.trim() || !runnerId || !servers.includes(runnerTool)}>
                {current ? t("sheet.save") : t("runnerSheet.addTool")}
              </Button>
              <Button type="button" variant="ghost" onClick={onClose}>
                {current ? t("sheet.close") : t("sheet.cancel")}
              </Button>
              {current && !current.plugin && (
                <Button type="button" variant="ghost" className="ml-auto text-danger" disabled={busy} onClick={() => void remove()}>
                  {t("sheet.delete")}
                </Button>
              )}
            </div>
          </form>

          {current && (
            <section aria-labelledby="runner-tool-actions" className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h2 id="runner-tool-actions" className="text-[15px] font-medium">
                  {t("sheet.actions", { count: current.actions.length })}
                </h2>
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void reload()}>
                  <RefreshCw /> {t("sheet.refresh")}
                </Button>
              </div>
              {current.actionsError && (
                <p role="status" className="text-[13px] text-danger">
                  {current.actionsError}
                </p>
              )}
              <p className="text-[13px] text-muted">{t("sheet.actionsNote")}</p>
              <ul className="divide-y divide-line rounded-xl border border-line">
                {current.actions.map((a) => (
                  <ActionItem key={a.name} action={a} tool={current.name} enabled={!current.disabled.includes(a.name)} busy={busy} onChange={(enabled) => actionEnabled.mutate({ toolId: current.id, action: a.name, enabled })} />
                ))}
                {current.actions.length === 0 && <li className="px-4 py-3 text-[13px] text-muted">{t("sheet.noAction")}</li>}
              </ul>
            </section>
          )}
          {current && <PollableActions toolId={current.id} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}
