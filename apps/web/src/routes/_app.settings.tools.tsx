import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LayoutGrid, Plus, RefreshCw, Server } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Empty, List } from "../components/settings/parts.tsx";
import { RunnerToolSheet } from "../components/settings/RunnerToolSheet.tsx";
import { ToolCatalog } from "../components/settings/ToolCatalog.tsx";
import { ToolSheet, type Tool } from "../components/settings/ToolSheet.tsx";
import { PageHeader } from "../components/Placeholder.tsx";
import { orpc } from "../lib/api.ts";
import { qualifiedName } from "@dispand/domain/plugins/names";
import { useStored } from "@/lib/message";

// `tool`: the tool whose sheet opens, with its settings or Connect: as an OAuth sign-in comes back
// to it, and as an agent links to it (a tool's `signInPath`).
export const Route = createFileRoute("/_app/settings/tools")({ component: Tools, validateSearch: z.object({ tool: z.string().max(100).optional() }) });

function Tools() {
  const { t } = useTranslation("tools");
  const stored = useStored();
  const tools = useQuery(orpc.tools.list.queryOptions());
  // `n` remounts the sheet with what the server saved. `runner`: a runner tool's sheet.
  const [sheet, setSheet] = useState<{ tool?: Tool; n: number; runner?: boolean; suggested?: { name: string; runnerTool: string; catalogId?: string } } | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const queryClient = useQueryClient();
  const refresh = useMutation(orpc.tools.refresh.mutationOptions({ onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.tools.key() }) }));
  const { tool: back } = Route.useSearch();
  const navigate = Route.useNavigate();
  useEffect(() => {
    const tool = back ? tools.data?.find((row) => row.id === back) : undefined;
    if (!back || !tools.data) return;
    // A tool made since the list was cached (by an agent's proposal): wait for the fresh list.
    if (!tool && tools.isFetching) return;
    if (tool) setSheet({ tool, n: 0, runner: tool.kind === "runner" });
    void navigate({ search: {}, replace: true });
  }, [back, tools.data, tools.isFetching, navigate]);

  const add = (
    <div className="flex flex-wrap gap-2">
      <Button onClick={() => setBrowsing(true)}>
        <LayoutGrid /> {t("list.browse")}
      </Button>
      <Button variant="ghost" onClick={() => setSheet({ n: 0 })}>
        <Plus /> {t("list.addMcp")}
      </Button>
      <Button variant="ghost" onClick={() => setSheet({ n: 0, runner: true })}>
        <Server /> {t("list.addRunner")}
      </Button>
    </div>
  );

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <PageHeader title={t("list.title")} subtitle={t("list.subtitle")} />
        {tools.data && tools.data.length > 0 && add}
      </div>

      {tools.error && !tools.data && (
        <p role="alert" className="text-[14px] text-danger">
          {t("list.failed")}
        </p>
      )}
      {tools.data?.length === 0 && (
        <Empty title={t("list.emptyTitle")} text={t("list.emptyText")}>
          {add}
        </Empty>
      )}
      {tools.data && tools.data.length > 0 && (
        <List>
          {tools.data.map((tool) => (
            <li key={tool.id} className="flex items-center gap-2 pr-3">
              <button
                type="button"
                onClick={() => setSheet({ tool, n: 0, runner: tool.kind === "runner" })}
                className="flex min-w-0 flex-1 items-center justify-between gap-4 px-5 py-4 text-left transition hover:bg-hover"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[15px] font-medium">{qualifiedName(tool.plugin?.name ?? null, tool.name)}</span>
                  <span className="block truncate text-[13px] text-muted">
                    {t("list.line", {
                      where: tool.kind === "runner" ? (tool.runnerTool ? t("list.runner", { tool: tool.runnerTool }) : tool.pluginServer ? t("list.pluginRunner", { plugin: tool.pluginServer.plugin }) : t("list.noRunner")) : tool.urlSet ? t("list.secretUrl") : t("list.mcp", { host: hostOf(tool.url ?? "") }),
                      actions: t("list.actions", { count: tool.actions.length }),
                    })}
                  </span>
                  {tool.oauthStatus === "authorize" && <span className="block truncate text-[13px] text-muted">{t("list.notConnected")}</span>}
                  {tool.signIn === "needed" && tool.auth !== "oauth" && <span className="block truncate text-[13px] text-danger">{t("list.needsSignIn")}</span>}
                  {tool.oauthStatus === "reauthorize" && <span className="block truncate text-[13px] text-danger">{t("list.reauthorize")}</span>}
                  {tool.actionsError && tool.oauthStatus !== "reauthorize" && <span className="block truncate text-[13px] text-danger">{stored(tool.actionsError)}</span>}
                </span>
              </button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("list.refresh", { name: tool.name })}
                disabled={refresh.isPending && refresh.variables?.id === tool.id}
                onClick={() => refresh.mutate({ id: tool.id })}
              >
                <RefreshCw className={refresh.isPending && refresh.variables?.id === tool.id ? "animate-spin" : undefined} />
              </Button>
            </li>
          ))}
        </List>
      )}

      {browsing && (
        <ToolCatalog
          onClose={() => setBrowsing(false)}
          onInstalled={(tool) => {
            setBrowsing(false);
            setSheet({ tool, n: 0 });
          }}
          onPickRunner={(suggested) => {
            setBrowsing(false);
            setSheet({ n: 0, runner: true, suggested });
          }}
        />
      )}
      {sheet?.runner && (
        <RunnerToolSheet
          key={`${sheet.tool?.id ?? "new"}-${sheet.n}`}
          tool={sheet.tool}
          suggested={sheet.suggested}
          onClose={() => setSheet(null)}
          onSaved={(saved) => setSheet((s) => ({ tool: saved, n: (s?.n ?? 0) + 1, runner: true }))}
        />
      )}
      {sheet && !sheet.runner && (
        <ToolSheet
          key={`${sheet.tool?.id ?? "new"}-${sheet.n}`}
          tool={sheet.tool}
          onClose={() => setSheet(null)}
          onSaved={(saved) => setSheet((s) => ({ tool: saved, n: (s?.n ?? 0) + 1 }))}
        />
      )}
    </>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
