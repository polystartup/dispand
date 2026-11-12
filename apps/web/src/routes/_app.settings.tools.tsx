import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LayoutGrid, Plus, RefreshCw, Server } from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Empty, List } from "../components/settings/parts.tsx";
import { RunnerToolSheet } from "../components/settings/RunnerToolSheet.tsx";
import { ToolCatalog } from "../components/settings/ToolCatalog.tsx";
import { ToolSheet, type Tool } from "../components/settings/ToolSheet.tsx";
import { PageHeader } from "../components/Placeholder.tsx";
import { orpc } from "../lib/api.ts";

// `tool`: the tool whose sheet opens, with its settings or Connect: as an OAuth sign-in comes back
// to it, and as an agent links to it (a tool's `signInPath`).
export const Route = createFileRoute("/_app/settings/tools")({ component: Tools, validateSearch: z.object({ tool: z.string().max(100).optional() }) });

function Tools() {
  const tools = useQuery(orpc.tools.list.queryOptions());
  // `n` remounts the sheet with what the server saved. `runner`: a runner tool's sheet.
  const [sheet, setSheet] = useState<{ tool?: Tool; n: number; runner?: boolean; suggested?: { name: string; runnerTool: string; catalogId?: string } } | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const queryClient = useQueryClient();
  const refresh = useMutation(orpc.tools.refresh.mutationOptions({ onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.tools.key() }) }));
  const { tool: back } = Route.useSearch();
  const navigate = Route.useNavigate();
  useEffect(() => {
    const tool = back ? tools.data?.find((t) => t.id === back) : undefined;
    if (!back || !tools.data) return;
    // A tool made since the list was cached (by an agent's proposal): wait for the fresh list.
    if (!tool && tools.isFetching) return;
    if (tool) setSheet({ tool, n: 0, runner: tool.kind === "runner" });
    void navigate({ search: {}, replace: true });
  }, [back, tools.data, tools.isFetching, navigate]);

  const add = (
    <div className="flex flex-wrap gap-2">
      <Button onClick={() => setBrowsing(true)}>
        <LayoutGrid /> Browse catalog
      </Button>
      <Button variant="ghost" onClick={() => setSheet({ n: 0 })}>
        <Plus /> Add MCP server
      </Button>
      <Button variant="ghost" onClick={() => setSheet({ n: 0, runner: true })}>
        <Server /> Add runner tool
      </Button>
    </div>
  );

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <PageHeader title="Tools" subtitle="MCP servers your agents and workflows may call." />
        {tools.data && tools.data.length > 0 && add}
      </div>

      {tools.error && !tools.data && (
        <p role="alert" className="text-[14px] text-danger">
          Could not load the tools.
        </p>
      )}
      {tools.data?.length === 0 && (
        <Empty title="No tool yet" text="Pick one from the catalog, or add an MCP server by its URL with the headers it needs (such as a token). Its actions are listed for you.">
          {add}
        </Empty>
      )}
      {tools.data && tools.data.length > 0 && (
        <List>
          {tools.data.map((t) => (
            <li key={t.id} className="flex items-center gap-2 pr-3">
              <button
                type="button"
                onClick={() => setSheet({ tool: t, n: 0, runner: t.kind === "runner" })}
                className="flex min-w-0 flex-1 items-center justify-between gap-4 px-5 py-4 text-left transition hover:bg-hover"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[15px] font-medium">{t.name}</span>
                  <span className="block truncate text-[13px] text-muted">
                    {t.kind === "runner" ? `Runner · ${t.runnerTool ?? "not on a runner yet"}` : `MCP · ${t.urlSet ? "secret URL" : hostOf(t.url ?? "")}`} ·{" "}
                    {t.actions.length === 1 ? "1 action" : `${t.actions.length} actions`}
                    {t.plugin && ` · from plugin ${t.plugin.name}`}
                  </span>
                  {t.oauthStatus === "authorize" && <span className="block truncate text-[13px] text-muted">Not connected yet</span>}
                  {t.signIn === "needed" && t.auth !== "oauth" && <span className="block truncate text-[13px] text-danger">Needs sign-in: enter its settings</span>}
                  {t.oauthStatus === "reauthorize" && <span className="block truncate text-[13px] text-danger">Re-authorize: its sign-in stopped working</span>}
                  {t.actionsError && t.oauthStatus !== "reauthorize" && <span className="block truncate text-[13px] text-danger">{t.actionsError}</span>}
                </span>
              </button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Refresh ${t.name}`}
                disabled={refresh.isPending && refresh.variables?.id === t.id}
                onClick={() => refresh.mutate({ id: t.id })}
              >
                <RefreshCw className={refresh.isPending && refresh.variables?.id === t.id ? "animate-spin" : undefined} />
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
