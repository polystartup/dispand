import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Search } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { List } from "../components/settings/parts.tsx";
import { PluginInstallSheet, pluginTabs, refusal } from "../components/settings/PluginInstallSheet.tsx";
import { Tabs } from "../components/settings/Tabs.tsx";
import { PageHeader } from "../components/Placeholder.tsx";
import { orpc } from "../lib/api.ts";

export const Route = createFileRoute("/_app/settings/plugins/")({ component: Discover });

/** At most this many results are shown; a search narrows them. */
const SHOWN = 100;

function Discover() {
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query.trim());
  const results = useQuery({ ...orpc.plugins.discover.queryOptions({ input: { query: deferred || undefined } }), placeholderData: (prev) => prev });
  const [installing, setInstalling] = useState<{ marketplaceId: string; entryName: string } | null>(null);

  return (
    <>
      <Tabs tabs={pluginTabs} />
      <PageHeader title="Discover" subtitle="Plugins from your marketplaces: skills, tools and agents others have made." />

      <div className="relative mb-4">
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
        <Input
          aria-label="Search plugins"
          placeholder="Search plugins"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          maxLength={200}
          className="h-10 rounded-xl bg-surface pl-9 text-[14px]"
        />
      </div>

      {results.error && !results.data && (
        <p role="alert" className="text-[14px] text-danger">
          Could not load the plugins.
        </p>
      )}
      {results.data?.length === 0 && (
        <p className="mb-8 rounded-2xl bg-surface px-5 py-8 text-center text-[14px] text-muted shadow-card">
          {deferred ? "No plugin matches." : "No plugin yet: sync a marketplace below to see its plugins."}
        </p>
      )}
      {results.data && results.data.length > 0 && (
        <div className="mb-10">
          <List>
            {results.data.slice(0, SHOWN).map((r) => (
              <li key={`${r.marketplaceId}/${r.entry.name}`} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4">
                <div className="min-w-0 flex-1 basis-60">
                  <p className="truncate text-[15px] font-medium">{r.entry.name}</p>
                  <p className="line-clamp-2 text-[13px] text-muted">
                    <span className="text-faint">{r.marketplace}</span>
                    {r.entry.description ? ` · ${r.entry.description}` : ""}
                  </p>
                </div>
                {r.installed ? (
                  <span className="shrink-0 text-[13px] text-muted">Installed</span>
                ) : r.entry.source.supported ? (
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Install ${r.entry.name}`}
                    onClick={() => setInstalling({ marketplaceId: r.marketplaceId, entryName: r.entry.name })}
                  >
                    Install
                  </Button>
                ) : (
                  <span className="max-w-60 shrink-0 text-[12px] text-faint" title={r.entry.source.reason}>
                    Unsupported source: {r.entry.source.reason}
                  </span>
                )}
              </li>
            ))}
          </List>
          {results.data.length > SHOWN && (
            <p className="mt-2 text-[13px] text-faint">
              Showing {SHOWN} of {results.data.length}. Search to narrow them down.
            </p>
          )}
        </div>
      )}

      <Marketplaces />
      {installing && <PluginInstallSheet key={`${installing.marketplaceId}/${installing.entryName}`} {...installing} onClose={() => setInstalling(null)} />}
    </>
  );
}

function syncedLabel(m: { syncedAt: Date | null; syncError: string | null; plugins: number }) {
  if (!m.syncedAt) return "Not synced yet";
  return `${m.plugins} ${m.plugins === 1 ? "plugin" : "plugins"} · synced ${new Date(m.syncedAt).toLocaleString()}`;
}

function Marketplaces() {
  const queryClient = useQueryClient();
  const markets = useQuery(orpc.marketplaces.list.queryOptions());
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.marketplaces.key() }),
      // Discover and every cached preview: a sync may change what an entry holds.
      queryClient.invalidateQueries({ queryKey: orpc.plugins.key() }),
    ]);
  const add = useMutation(orpc.marketplaces.add.mutationOptions({ onSuccess: refresh }));
  const sync = useMutation(orpc.marketplaces.sync.mutationOptions({ onSuccess: refresh }));
  const remove = useMutation(orpc.marketplaces.remove.mutationOptions({ onSuccess: refresh }));
  const [url, setUrl] = useState("");
  const [kind, setKind] = useState<"git" | "well-known">("git");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    try {
      await add.mutateAsync({ url: url.trim(), kind });
      setUrl("");
    } catch (e) {
      setError(refusal(e, "Could not add the marketplace."));
    }
  }

  async function drop(id: string) {
    setError(null);
    try {
      await remove.mutateAsync({ id });
    } catch (e) {
      setError(refusal(e, "Could not remove the marketplace."));
    }
  }

  return (
    <section aria-labelledby="marketplaces" className="space-y-3">
      <div>
        <h2 id="marketplaces" className="text-[17px] font-semibold tracking-tight">
          Marketplaces
        </h2>
        <p className="text-[13px] text-muted">Where plugins and skills come from: Git repositories with a .claude-plugin/marketplace.json or a skills/ folder (by https:// URL or GitHub owner/repo), and sites that publish /.well-known/skills/.</p>
      </div>
      {markets.data && (
        <List>
          {markets.data.map((m) => {
            const syncing = sync.isPending && sync.variables?.id === m.id;
            return (
              <li key={m.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
                <div className="min-w-0 flex-1 basis-60">
                  <p className="truncate text-[15px] font-medium">
                    {m.name}
                    {m.builtIn && <span className="ml-2 text-[12px] font-normal text-faint">Built in</span>}
                    {m.kind !== "marketplace" && (
                      <span className="ml-2 text-[12px] font-normal text-faint">{m.kind === "well-known" ? "Skill site" : "Skill repository"}</span>
                    )}
                  </p>
                  <p className="truncate font-mono text-[12px] text-faint">{m.url}</p>
                  <p className="text-[13px] text-muted">{syncedLabel(m)}</p>
                  {m.syncError && (
                    <p role="status" className="text-[13px] text-danger">
                      Last sync failed: {m.syncError}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button size="sm" variant="ghost" aria-label={`Sync ${m.name}`} disabled={syncing} onClick={() => sync.mutate({ id: m.id })}>
                    <RefreshCw className={syncing ? "animate-spin" : undefined} /> {syncing ? "Syncing…" : "Sync"}
                  </Button>
                  {!m.builtIn && (
                    <Button size="sm" variant="ghost" className="text-danger" aria-label={`Remove ${m.name}`} onClick={() => void drop(m.id)}>
                      Remove
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </List>
      )}
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <select
          aria-label="Kind of source"
          value={kind}
          onChange={(e) => setKind(e.target.value as "git" | "well-known")}
          className="h-9 rounded-lg border border-input bg-surface px-2 text-[14px]"
        >
          <option value="git">Git repository</option>
          <option value="well-known">Skill site</option>
        </select>
        <Input
          aria-label={kind === "git" ? "Marketplace Git URL" : "Skill site address"}
          placeholder={kind === "git" ? "owner/repo or https://…/marketplace.git" : "https://example.com"}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          maxLength={2000}
          className="h-9 min-w-0 flex-1 basis-64 rounded-lg bg-surface text-[14px]"
        />
        <Button type="submit" disabled={add.isPending || !url.trim()}>
          {add.isPending ? "Adding…" : kind === "git" ? "Add marketplace" : "Add skill site"}
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
