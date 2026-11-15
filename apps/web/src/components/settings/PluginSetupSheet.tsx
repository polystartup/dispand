import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ProposalItems } from "../questions/ProposalItems.tsx";
import { type api, orpc } from "../../lib/api.ts";
import { Check, refusal, Section, toggled } from "./PluginInstallSheet.tsx";
import { useDefinitionPicks } from "./PluginDefinitionPicks.tsx";

type Plugin = Awaited<ReturnType<typeof api.plugins.list>>[number];
type Outcome = Awaited<ReturnType<typeof api.plugins.setUp>>["outcomes"][number];

/** What an item is made from, in words: `primitive:Matters` is the table Matters. */
function madeFrom(t: TFunction<"plugins">, o: Outcome): string {
  if (o.from?.startsWith("primitive:")) return t("setup.table", { name: o.from.slice("primitive:".length) });
  if (o.from?.startsWith("field:")) return t("setup.field", { name: o.from.slice("field:".length) });
  if (o.from?.startsWith("agent:")) return t("setup.agent", { name: o.from.slice("agent:".length) });
  return o.tool === "tables_set_primitive" ? t("setup.primitive") : o.tool;
}

/**
 * Sets a workspace up from a plugin's definitions: the owner ticks its tables and agents (each on a
 * harness), reads the items that will be made (as an Approval shows a proposal's), and makes them.
 * A run that stops keeps what it made; setting up again resumes. Mount it only while open.
 */
export function PluginSetupSheet({ plugin, onClose }: { plugin: Plugin; onClose: () => void }) {
  const { t } = useTranslation("plugins");
  const queryClient = useQueryClient();
  const harnesses = useQuery(orpc.harnesses.list.queryOptions());
  const definitions = useDefinitionPicks(plugin.definitions, harnesses.data);
  // The plugin's servers that aren't tools yet and can be added as they are: over HTTP, with no setting to enter. Ticked by the owner, once they see where its calls go.
  const servers = (plugin.available?.mcpServers ?? []).filter((s) => s.type === "http" && s.settings.length === 0);
  const [pickedServers, setPickedServers] = useState(() => new Set<string>());
  const serverPicks = servers.filter((s) => pickedServers.has(s.name)).map((s) => ({ name: s.name }));
  const pick = { ...definitions.pick, ...(serverPicks.length ? { servers: serverPicks } : {}) };
  const any = definitions.any || serverPicks.length > 0;
  const preview = useQuery({ ...orpc.plugins.setupPreview.queryOptions({ input: { id: plugin.id, pick } }), enabled: any, retry: false });
  const setUp = useMutation(
    orpc.plugins.setUp.mutationOptions({
      onSettled: () => Promise.all([orpc.plugins, orpc.tables, orpc.agents].map((procedures) => queryClient.invalidateQueries({ queryKey: procedures.key() }))),
    }),
  );
  const [error, setError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);

  async function submit() {
    if (!preview.data) return;
    setError(null);
    try {
      setOutcomes((await setUp.mutateAsync({ id: plugin.id, pick, reviewed: preview.data.reviewed })).outcomes);
    } catch (e) {
      setError(refusal(e, t("setup.failed")));
    }
  }

  const items = preview.data?.items ?? [];
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto bg-surface sm:max-w-lg">
        <SheetHeader className="px-6 pt-6">
          <SheetTitle className="text-[20px] tracking-tight">{t("setup.title", { name: plugin.name })}</SheetTitle>
          <SheetDescription>{t("setup.description")}</SheetDescription>
        </SheetHeader>
        <div className="space-y-6 px-6 pb-6">
          {outcomes ? (
            <Section id="setup-outcomes" title={t("setup.made")}>
              {outcomes.length === 0 ? (
                <p className="text-[13px] text-muted">{t("setup.allDone")}</p>
              ) : (
                <ol className="space-y-1 text-[13px]">
                  {outcomes.map((o) => (
                    <li key={o.$item}>
                      <Trans t={t} i18nKey="setup.line" values={{ item: madeFrom(t, o), outcome: t(`setup.outcome.${o.outcome}`) }} components={[<span className={o.outcome === "refused" ? "text-danger" : o.outcome === "made" ? "" : "text-faint"} />]} />
                      {o.error && <span className="block text-danger">{o.error}</span>}
                    </li>
                  ))}
                </ol>
              )}
              {outcomes.some((o) => o.outcome === "refused") && <p className="text-[13px] text-muted">{t("setup.stopped")}</p>}
              <Button type="button" variant="ghost" onClick={onClose}>
                {t("setup.close")}
              </Button>
            </Section>
          ) : (
            <>
              {definitions.sections}
              {servers.length > 0 && (
                <Section id="setup-servers" title={t("setup.tools")}>
                  <ul className="space-y-2">
                    {servers.map((s) => (
                      <li key={s.name}>
                        <Check checked={pickedServers.has(s.name)} onChange={() => setPickedServers((prev) => toggled(prev, s.name))} label={s.name} detail={t("setup.server", { url: s.url ?? "" })} />
                      </li>
                    ))}
                  </ul>
                </Section>
              )}
              {any && (
                <Section id="setup-items" title={t("setup.willMake")}>
                  {preview.error ? (
                    <p role="alert" className="text-[13px] text-danger">
                      {refusal(preview.error, t("setup.previewFailed"))}
                    </p>
                  ) : !preview.data ? (
                    <p className="text-[13px] text-muted">{t("setup.reading")}</p>
                  ) : items.length === 0 ? (
                    <p className="text-[13px] text-muted">{t("setup.nothing")}</p>
                  ) : (
                    <ProposalItems proposal={{ id: "", status: "draft", items, names: preview.data.names }} />
                  )}
                  {preview.data && preview.data.waiting.length > 0 && (
                    <ul aria-label={t("setup.notMade")} className="space-y-1 text-[13px]">
                      {preview.data.waiting.map((w, i) => (
                        <li key={i}>
                          <span className="font-medium">{w.definition}</span> <span className="text-muted">{w.reason}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>
              )}
              {error && (
                <p role="alert" className="text-[13px] text-danger">
                  {error}
                </p>
              )}
              <div className="flex items-center gap-2">
                <Button type="button" disabled={setUp.isPending || preview.isFetching || items.length === 0} onClick={() => void submit()}>
                  {setUp.isPending ? t("setup.settingUp") : t("setup.submit")}
                </Button>
                <Button type="button" variant="ghost" onClick={onClose}>
                  {t("setup.cancel")}
                </Button>
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
