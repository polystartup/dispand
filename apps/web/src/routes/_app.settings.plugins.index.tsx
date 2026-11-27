import { marketplaceUrl } from "@dispand/domain/plugins/names";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { RefreshCw, Search } from "lucide-react";
import { useDeferredValue, useEffect, useId, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { List } from "../components/settings/parts.tsx";
import { PluginInstallSheet, pluginTabs } from "../components/settings/PluginInstallSheet.tsx";
import { refusal } from "../lib/refusal.ts";
import { Tabs } from "../components/settings/Tabs.tsx";
import { PageHeader } from "../components/Placeholder.tsx";
import { orpc } from "../lib/api.ts";
import { useFormat } from "../lib/format.ts";
import { useStored, useText } from "@/lib/message";
import { useWorkspaces } from "../lib/workspace.tsx";

const KINDS = ["git", "well-known"] as const;
type Kind = (typeof KINDS)[number];

export const Route = createFileRoute("/_app/settings/plugins/")({
  // A link's source (`?add=<source>&kind=`): untrusted, it only fills the form, as text. A value the form couldn't hold is dropped.
  validateSearch: z.object({ add: z.string().max(2000).optional().catch(undefined), kind: z.enum(KINDS).optional().catch(undefined) }),
  component: Discover,
});

/** At most this many results are shown; a search narrows them. */
const SHOWN = 100;

function Discover() {
  const { t } = useTranslation("plugins");
  const text = useText();
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query.trim());
  const results = useQuery({ ...orpc.plugins.discover.queryOptions({ input: { query: deferred || undefined } }), placeholderData: (prev) => prev });
  const [installing, setInstalling] = useState<{ marketplaceId: string; entryName: string } | null>(null);
  const { add, kind } = Route.useSearch();

  return (
    <>
      <Tabs tabs={pluginTabs.map((tab) => ({ ...tab, label: t(tab.label) }))} />
      <PageHeader title={t("discover.title")} subtitle={t("discover.subtitle")} />

      <div className="relative mb-4">
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
        <Input
          aria-label={t("discover.search")}
          placeholder={t("discover.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          maxLength={200}
          className="h-10 rounded-xl bg-surface pl-9 text-[14px]"
        />
      </div>

      {results.error && !results.data && (
        <p role="alert" className="text-[14px] text-danger">
          {t("discover.failed")}
        </p>
      )}
      {results.data?.length === 0 && (
        <p className="mb-8 rounded-2xl bg-surface px-5 py-8 text-center text-[14px] text-muted shadow-card">
          {deferred ? t("discover.noMatch") : t("discover.none")}
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
                  <span className="shrink-0 text-[13px] text-muted">{t("discover.installed")}</span>
                ) : r.entry.source.supported ? (
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={t("discover.installLabel", { name: r.entry.name })}
                    onClick={() => setInstalling({ marketplaceId: r.marketplaceId, entryName: r.entry.name })}
                  >
                    {t("discover.install")}
                  </Button>
                ) : (
                  <span className="max-w-60 shrink-0 text-[12px] text-faint" title={text(r.entry.source.reason)}>
                    {t("discover.unsupported", { reason: text(r.entry.source.reason) })}
                  </span>
                )}
              </li>
            ))}
          </List>
          {results.data.length > SHOWN && <p className="mt-2 text-[13px] text-faint">{t("discover.showing", { shown: SHOWN, count: results.data.length })}</p>}
        </div>
      )}

      {/* Another link fills the form anew. */}
      <Marketplaces key={`${kind}:${add}`} link={add?.trim() ? { source: add.trim(), kind: kind ?? "git" } : undefined} />
      {installing && <PluginInstallSheet key={`${installing.marketplaceId}/${installing.entryName}`} {...installing} onClose={() => setInstalling(null)} />}
    </>
  );
}

/**
 * The marketplaces, and the form that adds one. A link fills the form (a Git source as the server
 * reads it: `owner/repo` is GitHub's) and nothing more: the person adds it with the same button.
 */
function Marketplaces({ link }: { link?: { source: string; kind: Kind } }) {
  const { t } = useTranslation("plugins");
  const navigate = useNavigate({ from: Route.fullPath });
  const stored = useStored();
  const format = useFormat();
  const syncedLabel = (m: { syncedAt: Date | null; plugins: number }) =>
    m.syncedAt ? t("markets.synced", { count: m.plugins, when: format.dateTime(m.syncedAt) }) : t("markets.notSynced");
  const markets = useQuery(orpc.marketplaces.list.queryOptions());
  const add = useMutation(orpc.marketplaces.add.mutationOptions());
  const sync = useMutation(orpc.marketplaces.sync.mutationOptions());
  const remove = useMutation(orpc.marketplaces.remove.mutationOptions());
  const [url, setUrl] = useState(link ? (link.kind === "git" ? marketplaceUrl(link.source) : link.source) : "");
  const [kind, setKind] = useState<Kind>(link?.kind ?? "git");
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const noticeId = useId();
  // Once, as the page opens from a link: a link's object is new at every render.
  const linked = !!link;
  useEffect(() => {
    if (linked) field.current?.focus();
  }, [linked]);

  async function submit() {
    setError(null);
    try {
      await add.mutateAsync({ url: url.trim(), kind });
      setUrl("");
      // Added: a reload doesn't fill the form again.
      if (link) void navigate({ search: (prev) => ({ ...prev, add: undefined, kind: undefined }), replace: true });
    } catch (e) {
      setError(refusal(e, t("markets.addFailed")));
    }
  }

  async function drop(id: string) {
    setError(null);
    try {
      await remove.mutateAsync({ id });
    } catch (e) {
      setError(refusal(e, t("markets.removeFailed")));
    }
  }

  return (
    <section aria-labelledby="marketplaces" className="space-y-3">
      <div>
        <h2 id="marketplaces" className="text-[17px] font-semibold tracking-tight">
          {t("markets.title")}
        </h2>
        <p className="text-[13px] text-muted">{t("markets.text")}</p>
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
                    {m.builtIn && <span className="ml-2 text-[12px] font-normal text-faint">{t("markets.builtIn")}</span>}
                    {m.kind !== "marketplace" && (
                      <span className="ml-2 text-[12px] font-normal text-faint">
                        {m.kind === "well-known" ? t("markets.skillSite") : t("markets.skillRepo")}
                      </span>
                    )}
                  </p>
                  <p className="truncate font-mono text-[12px] text-faint">{m.url}</p>
                  <p className="text-[13px] text-muted">{syncedLabel(m)}</p>
                  {m.syncError && (
                    <p role="status" className="text-[13px] text-danger">
                      {t("markets.syncFailed", { error: stored(m.syncError) })}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t("markets.syncLabel", { name: m.name })}
                    disabled={syncing}
                    onClick={() => sync.mutate({ id: m.id })}
                  >
                    <RefreshCw className={syncing ? "animate-spin" : undefined} /> {syncing ? t("markets.syncing") : t("markets.sync")}
                  </Button>
                  {!m.builtIn && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-danger"
                      aria-label={t("markets.removeLabel", { name: m.name })}
                      onClick={() => void drop(m.id)}
                    >
                      {t("markets.remove")}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </List>
      )}
      {link && <FromLink id={noticeId} host={URL.parse(url.trim())?.host} />}
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <select
          aria-label={t("markets.kind")}
          value={kind}
          onChange={(e) => setKind(e.target.value as Kind)}
          className="h-9 rounded-lg border border-input bg-surface px-2 text-[14px]"
        >
          <option value="git">{t("markets.git")}</option>
          <option value="well-known">{t("markets.skillSite")}</option>
        </select>
        <Input
          ref={field}
          aria-label={kind === "git" ? t("markets.gitUrl") : t("markets.siteUrl")}
          aria-describedby={link ? noticeId : undefined}
          placeholder={kind === "git" ? t("markets.gitPlaceholder") : t("markets.sitePlaceholder")}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          maxLength={2000}
          className="h-9 min-w-0 flex-1 basis-64 rounded-lg bg-surface text-[14px]"
        />
        <Button type="submit" disabled={add.isPending || !url.trim()}>
          {add.isPending ? t("markets.adding") : kind === "git" ? t("markets.addGit") : t("markets.addSite")}
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

/**
 * Above a form a link filled: check before adding, and the host it is fetched from in ASCII (a
 * look-alike letter shows), in which workspace (a person in several picks it), or why they can't.
 */
function FromLink({ id, host }: { id: string; host: string | undefined }) {
  const { t } = useTranslation("plugins");
  const navigate = useNavigate({ from: Route.fullPath });
  const { workspaces, current } = useWorkspaces();
  if (!current) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-surface px-4 py-3 text-[13px] shadow-card">
      <p id={id} className={`min-w-0 flex-1 basis-60 ${current.role === "member" ? "text-danger" : "text-muted"}`}>
        {current.role === "member" ? t("markets.linkManagerOnly") : t("markets.fromLink")}
        {current.role !== "member" && host && (
          <>
            {" "}
            <Trans t={t} i18nKey="markets.fetchedFrom" values={{ host }} components={[<span className="font-medium text-fg" />]} />
          </>
        )}
      </p>
      {workspaces.length > 1 && (
        <label className="flex shrink-0 items-center gap-2 text-muted">
          {t("markets.linkWorkspace")}
          <select
            value={current.workspaceId}
            onChange={(e) => void navigate({ search: (prev) => ({ ...prev, w: e.target.value }) })}
            className="h-9 rounded-lg border border-input bg-surface px-2 text-[14px] text-fg"
          >
            {workspaces.map((x) => (
              <option key={x.workspaceId} value={x.workspaceId}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
