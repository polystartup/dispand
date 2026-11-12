import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Search } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { api } from "../../lib/api.ts";
import { orpc } from "../../lib/api.ts";
import { FormField } from "./parts.tsx";
import type { Tool } from "./ToolSheet.tsx";

type Entry = Awaited<ReturnType<typeof api.tools.catalog>>[number];

type Props = {
  onClose: () => void;
  /** An HTTP entry was installed: the new tool. */
  onInstalled: (tool: Tool) => void;
  /** A runner entry's snippet is in a runner's config: pick that runner. */
  onPickRunner: (suggested: { name: string; runnerTool: string; catalogId: string }) => void;
};

/** "Browse catalog": search the built-in entries, then install one. Mount it only while open. */
export function ToolCatalog({ onClose, onInstalled, onPickRunner }: Props) {
  const [query, setQuery] = useState("");
  const [entry, setEntry] = useState<Entry | null>(null);
  const entries = useQuery(orpc.tools.catalog.queryOptions({ input: { query } }));

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto bg-surface sm:max-w-lg">
        <SheetHeader className="px-6 pt-6">
          <SheetTitle className="text-[20px] tracking-tight">{entry ? entry.name : "Tool catalog"}</SheetTitle>
          <SheetDescription>{entry ? entry.description : "Ready-made MCP servers. Pick one to set it up."}</SheetDescription>
        </SheetHeader>
        <div className="px-6 pb-6">
          {entry ? (
            <div className="space-y-5">
              <Button type="button" variant="ghost" size="sm" onClick={() => setEntry(null)}>
                <ArrowLeft /> All tools
              </Button>
              {entry.kind === "http" ? <InstallHttp entry={entry} onInstalled={onInstalled} /> : <InstallRunner entry={entry} onPickRunner={onPickRunner} />}
              {entry.docs && (
                <p className="text-[13px] text-muted">
                  Set-up steps: <code className="font-mono text-[12.5px]">{entry.docs}</code> in Dispand&apos;s repository.
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="relative">
                <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
                <Input aria-label="Search the catalog" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} maxLength={100} className="pl-9" />
              </div>
              <ul className="divide-y divide-line rounded-xl border border-line">
                {entries.data?.map((e) => (
                  <li key={e.id}>
                    <button type="button" onClick={() => setEntry(e)} className="w-full px-4 py-3 text-left transition hover:bg-hover">
                      <span className="block text-[15px] font-medium">{e.name}</span>
                      <span className="block text-[13px] text-muted">{e.description}</span>
                      <span className="mt-1 block text-[12px] text-faint">{e.kind === "http" ? "Over HTTP" : "On a runner"}</span>
                    </button>
                  </li>
                ))}
                {entries.data?.length === 0 && <li className="px-4 py-3 text-[13px] text-muted">Nothing matches “{query}”.</li>}
              </ul>
              {entries.error && (
                <p role="alert" className="text-[13px] text-danger">
                  Could not load the catalog.
                </p>
              )}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function InstallHttp({ entry, onInstalled }: { entry: Extract<Entry, { kind: "http" }>; onInstalled: (tool: Tool) => void }) {
  const [name, setName] = useState(entry.name);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const install = useMutation(orpc.tools.installFromCatalog.mutationOptions({ onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.tools.key() }) }));

  async function submit() {
    setError(null);
    try {
      const result = await install.mutateAsync({ catalogId: entry.id, name, settings });
      if ("tool" in result) onInstalled(result.tool);
    } catch (e) {
      const known = typeof e === "object" && e !== null && "code" in e && (e.code === "BAD_REQUEST" || e.code === "CONFLICT") && "message" in e;
      setError(known && String(e.message) !== "Input validation failed" ? String(e.message) : "Could not install the tool.");
    }
  }

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <FormField label="Name" htmlFor="catalog-name">
        <Input id="catalog-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
      </FormField>
      {entry.settings.map((s) => (
        <FormField key={s.key} label={s.label} htmlFor={`catalog-${s.key}`} hint={`${s.help} Stored encrypted; it is never shown again.`}>
          <Input
            id={`catalog-${s.key}`}
            type="password"
            autoComplete="off"
            value={settings[s.key] ?? ""}
            onChange={(e) => setSettings((v) => ({ ...v, [s.key]: e.target.value }))}
            maxLength={4000}
            required
          />
        </FormField>
      ))}
      {entry.oauth && (
        <p className="text-[14px]">
          It signs in with OAuth. Once it is installed, enter your OAuth client&apos;s id and secret on its page, then Connect. The sign-in asks for{" "}
          {entry.oauth.scopes.map((s) => s.split("/").at(-1)).join(" and ")} only.
        </p>
      )}
      <p className="break-all text-[12px] text-faint">Calls {entry.url}</p>
      {error && (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}
      <Button type="submit" disabled={install.isPending || !name.trim()}>
        Install
      </Button>
    </form>
  );
}

function InstallRunner({ entry, onPickRunner }: { entry: Extract<Entry, { kind: "runner" }>; onPickRunner: Props["onPickRunner"] }) {
  const install = useQuery({ ...orpc.tools.installFromCatalog.queryOptions({ input: { catalogId: entry.id, settings: {} } }), staleTime: Infinity });
  const snippet = install.data && "runnerSnippet" in install.data ? install.data.runnerSnippet : null;
  return (
    <div className="space-y-3">
      <p className="text-[14px]">
        {entry.name} runs on your own machine. Add this under <code className="font-mono text-[13px]">mcpServers</code> in the runner&apos;s{" "}
        <code className="font-mono text-[13px]">config.json</code> there
        {entry.server.env.length > 0 ? ", with your key in place of “<your key>”: it stays on that machine" : ""}, then restart the runner.
      </p>
      {snippet && (
        <pre aria-label={`Runner config for ${entry.name}`} className="overflow-x-auto whitespace-pre rounded-lg border border-line bg-bg p-3 font-mono text-[12.5px]">
          {snippet}
        </pre>
      )}
      {snippet && (
        <Button type="button" variant="ghost" size="sm" onClick={() => void navigator.clipboard?.writeText(snippet)}>
          Copy
        </Button>
      )}
      <p className="text-[13px] text-muted">Once the runner is restarted, pick it: agents on its harnesses can then use {entry.name}.</p>
      <Button type="button" onClick={() => onPickRunner({ name: entry.name, runnerTool: entry.id, catalogId: entry.id })}>
        Pick the runner
      </Button>
    </div>
  );
}
