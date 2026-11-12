import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { api } from "../../lib/api.ts";
import { orpc } from "../../lib/api.ts";
import { FormField } from "./parts.tsx";
import { PollableActions } from "./PollableActions.tsx";
import { CatalogSettings } from "./CatalogSettings.tsx";
import { ToolSignIn } from "./ToolSignIn.tsx";

export type Tool = Awaited<ReturnType<typeof api.tools.list>>[number];
type Action = Tool["actions"][number];

export const transportLabels = { "streamable-http": "Streamable HTTP", sse: "SSE" } as const;
const signInLabels = { headers: "Headers", oauth: "OAuth sign-in" } as const;

/** A header row: a stored one (`stored`) shows "Set" until it is replaced or removed. */
type HeaderRow = { key: number; name: string; value: string; stored: boolean; removed: boolean };

type Props = {
  /** The tool being edited; absent when adding one. */
  tool?: Tool;
  onClose: () => void;
  onSaved: (tool: Tool) => void;
};

export function errorMessage(e: unknown, fallback: string): string {
  if (typeof e === "object" && e !== null && "code" in e && "message" in e && (e.code === "BAD_REQUEST" || e.code === "CONFLICT")) {
    const message = String(e.message);
    if (message !== "Input validation failed") return message;
  }
  return fallback;
}

/** "Add MCP server", or the editor of a tool with its actions. Mount it only while open. */
export function ToolSheet({ tool, onClose, onSaved }: Props) {
  const [name, setName] = useState(tool?.name ?? "");
  const [url, setUrl] = useState(tool?.url ?? "");
  const [transport, setTransport] = useState<keyof typeof transportLabels>(tool?.transport ?? "streamable-http");
  const [signIn, setSignIn] = useState<keyof typeof signInLabels>(tool?.auth === "oauth" ? "oauth" : "headers");
  const [headers, setHeaders] = useState<HeaderRow[]>(
    tool?.headerNames.map((n, i) => ({ key: i, name: n, value: "", stored: true, removed: false })) ?? [],
  );
  const [nextKey, setNextKey] = useState(headers.length);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState(tool);
  const [askClient, setAskClient] = useState(false);

  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: orpc.tools.key() });
  const create = useMutation(orpc.tools.create.mutationOptions({ onSuccess: invalidate }));
  const update = useMutation(orpc.tools.update.mutationOptions({ onSuccess: invalidate }));
  const refresh = useMutation(orpc.tools.refresh.mutationOptions({ onSuccess: invalidate }));
  const del = useMutation(orpc.tools.delete.mutationOptions({ onSuccess: invalidate }));
  const authorize = useMutation(orpc.tools.authorize.mutationOptions({ onSuccess: invalidate }));
  const busy = create.isPending || update.isPending || del.isPending || refresh.isPending || authorize.isPending;

  // Saved headers are for the server they were entered for: another origin or transport starts without them.
  const origin = (value: string) => {
    try {
      return new URL(value).origin;
    } catch {
      return "";
    }
  };
  const elsewhere = current?.kind === "http" && (origin(url.trim()) !== origin(current.url ?? "") || transport !== current.transport);
  const unsavedTarget = current?.kind === "http" && (url.trim() !== (current.url ?? "") || transport !== current.transport);
  const setRow = (key: number, patch: Partial<HeaderRow>) => setHeaders((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  async function save() {
    setError(null);
    const sent: Record<string, string> = {};
    const oauth = signIn === "oauth";
    // An OAuth tool sends no header: the server refuses them.
    for (const row of oauth ? [] : headers) {
      const n = row.name.trim();
      if (!n) continue;
      if (row.removed) sent[n] = "";
      else if (row.value.trim() || !row.stored) sent[n] = row.value.trim();
    }
    try {
      const auth = oauth ? ("oauth" as const) : current?.auth === "oauth" ? ("headers" as const) : undefined;
      const saved = current
        ? await update.mutateAsync({ id: current.id, name, url: url.trim(), transport, headers: sent, ...(auth ? { auth } : {}) })
        : await create.mutateAsync({ name, url: url.trim(), transport, headers: sent, ...(auth ? { auth } : {}) });
      onSaved(saved);
    } catch (e) {
      setError(errorMessage(e, "Could not save the tool. Check the details and try again."));
    }
  }

  async function reload() {
    if (!current) return;
    setError(null);
    try {
      setCurrent(await refresh.mutateAsync({ id: current.id }));
    } catch {
      setError("Could not refresh the actions.");
    }
  }

  /** Connect or Re-authorize: the page leaves for the server's sign-in, which comes back to the tool. */
  async function connect(client?: { clientId: string; clientSecret?: string } | null) {
    if (!current || unsavedTarget) return;
    setError(null);
    try {
      const { url: to } = await authorize.mutateAsync({ id: current.id, ...(client !== undefined ? { client } : {}) });
      window.location.assign(to);
    } catch (e) {
      const message = errorMessage(e, "Could not start the sign-in.");
      setError(message);
      // The server's authorization server wants a client id it gave the owner: its fields open.
      if (/enter the client id/.test(message)) setAskClient(true);
    }
  }

  async function remove() {
    if (!current) return;
    setError(null);
    try {
      await del.mutateAsync({ id: current.id });
      onClose();
    } catch (e) {
      // CONFLICT names the agent or skill that holds the tool.
      setError(errorMessage(e, "Could not delete the tool."));
    }
  }

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto bg-surface sm:max-w-lg">
        <SheetHeader className="px-6 pt-6">
          <SheetTitle className="text-[20px] tracking-tight">{current ? current.name : "Add MCP server"}</SheetTitle>
          <SheetDescription>
            An MCP server reached over HTTP. It acts as whatever account its headers, or its sign-in, authorize.
            {current?.plugin && ` From the plugin ${current.plugin.name}: removed with it.`}
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-8 px-6 pb-6">
          <form
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <FormField label="Name" htmlFor="tool-name">
              <Input id="tool-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required autoFocus={!current} />
            </FormField>
            <FormField
              label="URL"
              htmlFor="tool-url"
              hint={
                current?.urlSet && url === current.url
                  ? "Set: the URL holds a secret, so its template is shown. Type a new URL to replace it."
                  : "Headers are only sent to an https:// URL."
              }
            >
              <Input id="tool-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} maxLength={2000} required placeholder="https://example.com/mcp" />
            </FormField>
            <FormField label="Transport" htmlFor="tool-transport">
              <Select value={transport} onValueChange={(v) => setTransport(v as keyof typeof transportLabels)}>
                <SelectTrigger id="tool-transport" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(transportLabels).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField label="Sign-in" htmlFor="tool-sign-in-kind" hint={signIn === "oauth" ? "You sign in to the server; Dispand keeps the sign-in encrypted and renews it." : undefined}>
              <Select value={signIn} onValueChange={(v) => setSignIn(v as keyof typeof signInLabels)}>
                <SelectTrigger id="tool-sign-in-kind" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(signInLabels).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            {signIn === "headers" && (
              <fieldset className="space-y-2">
                <legend className="mb-1.5 text-[13px] font-medium text-muted">Headers</legend>
                {elsewhere && headers.some((r) => r.stored && !r.removed) && (
                  <p role="status" className="rounded-lg bg-hover px-3 py-2 text-[13px] text-muted">
                    This is another address: the saved headers are not sent there. Enter again the ones this server needs.
                  </p>
                )}
                {headers
                  .filter((r) => !r.removed)
                  .map((row) => (
                    <div key={row.key} className="flex items-center gap-2">
                      <Input
                        aria-label="Header name"
                        value={row.name}
                        onChange={(e) => setRow(row.key, { name: e.target.value })}
                        disabled={row.stored}
                        placeholder="Authorization"
                        maxLength={100}
                        className="w-2/5"
                      />
                      <Input
                        aria-label={`Value of ${row.name || "the header"}`}
                        type="password"
                        autoComplete="off"
                        value={row.value}
                        onChange={(e) => setRow(row.key, { value: e.target.value })}
                        placeholder={row.stored ? (elsewhere ? "Not kept: enter it again" : "Set: leave empty to keep") : "Bearer …"}
                        maxLength={4000}
                        required={!row.stored}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${row.name || "header"}`}
                        onClick={() => (row.stored ? setRow(row.key, { removed: true }) : setHeaders((rows) => rows.filter((r) => r.key !== row.key)))}
                      >
                        <X />
                      </Button>
                    </div>
                  ))}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={headers.filter((r) => !r.removed).length >= 20}
                  onClick={() => {
                    setHeaders((rows) => [...rows, { key: nextKey, name: "", value: "", stored: false, removed: false }]);
                    setNextKey((k) => k + 1);
                  }}
                >
                  <Plus /> Add header
                </Button>
                <p className="text-[12px] text-faint">Values are stored encrypted and never shown again.</p>
              </fieldset>
            )}

            {error && (
              <p role="alert" className="text-[13px] text-danger">
                {error}
              </p>
            )}
            <div className="flex items-center gap-2 pt-1">
              <Button type="submit" disabled={busy || !name.trim() || !url.trim()}>
                {current ? "Save" : "Add server"}
              </Button>
              <Button type="button" variant="ghost" onClick={onClose}>
                {current ? "Close" : "Cancel"}
              </Button>
              {current && !current.plugin && (
                <Button type="button" variant="ghost" className="ml-auto text-danger" disabled={busy} onClick={() => void remove()}>
                  Delete
                </Button>
              )}
            </div>
          </form>

          {current?.auth === "oauth" &&
            current.oauthStatus &&
            signIn === "oauth" &&
            // A sign-in is for the saved server: an address or transport not saved yet would get it (and the client entered for it).
            (unsavedTarget ? (
              <p role="status" className="text-[13px] text-muted">
                Save the new address before connecting: the sign-in is for the server the tool is saved with.
              </p>
            ) : (
              <ToolSignIn status={current.oauthStatus} clientId={current.enteredClientId} busy={busy} askClient={askClient} onConnect={(client) => void connect(client)} />
            ))}

          {current?.catalogId && current.auth !== "oauth" && !unsavedTarget && (
            <CatalogSettings
              tool={current}
              onSaved={(saved) => {
                setCurrent(saved);
                onSaved(saved);
              }}
            />
          )}

          {current && (
            <section aria-labelledby="tool-actions" className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h2 id="tool-actions" className="text-[15px] font-medium">
                  Actions ({current.actions.length})
                </h2>
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void reload()}>
                  <RefreshCw /> Refresh
                </Button>
              </div>
              {current.actionsError && (
                <p role="status" className="text-[13px] text-danger">
                  {current.actionsError}
                </p>
              )}
              <ul className="divide-y divide-line rounded-xl border border-line">
                {current.actions.map((a) => (
                  <ActionItem key={a.name} action={a} />
                ))}
                {current.actions.length === 0 && <li className="px-4 py-3 text-[13px] text-muted">No action listed.</li>}
              </ul>
            </section>
          )}
          {current && <PollableActions toolId={current.id} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** One action: its name, description and parameters (the top-level properties of its input schema). */
export function ActionItem({ action }: { action: Action }) {
  const properties = (action.inputSchema.properties ?? {}) as Record<string, { type?: unknown; description?: unknown }>;
  const required = new Set(Array.isArray(action.inputSchema.required) ? (action.inputSchema.required as string[]) : []);
  return (
    <li className="space-y-1.5 px-4 py-3">
      <p className="break-all font-mono text-[13px] font-medium">{action.name}</p>
      {action.description && <p className="whitespace-pre-line text-[13px] text-muted">{action.description}</p>}
      {Object.keys(properties).length > 0 && (
        <ul className="space-y-0.5 text-[12.5px]">
          {Object.entries(properties).map(([param, schema]) => (
            <li key={param} className="text-muted">
              <span className="font-mono text-fg">{param}</span>
              {typeof schema.type === "string" && <span> · {schema.type}</span>}
              {required.has(param) && <span> · required</span>}
              {typeof schema.description === "string" && <span> — {schema.description}</span>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
