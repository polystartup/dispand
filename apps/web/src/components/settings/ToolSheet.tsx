import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { api } from "../../lib/api.ts";
import { orpc } from "../../lib/api.ts";
import { refusal } from "../../lib/refusal.ts";
import { FormField } from "./parts.tsx";
import { PollableActions } from "./PollableActions.tsx";
import { CatalogSettings } from "./CatalogSettings.tsx";
import { ToolSignIn } from "./ToolSignIn.tsx";
import { Overridden } from "./Overridden.tsx";
import { StemMarks } from "./StemMarks.tsx";
import { useStored } from "@/lib/message";

export type Tool = Awaited<ReturnType<typeof api.tools.list>>[number];
type Action = Tool["actions"][number];

export const transportLabels = { "streamable-http": "Streamable HTTP", sse: "SSE" } as const;
const SIGN_INS = ["headers", "oauth"] as const;

/** A header row: a stored one (`stored`) shows "Set" until it is replaced or removed. */
type HeaderRow = { key: number; name: string; value: string; stored: boolean; removed: boolean };

type Props = {
  /** The tool being edited; absent when adding one. */
  tool?: Tool;
  onClose: () => void;
  onSaved: (tool: Tool) => void;
};

/** Why a tools procedure refused, when it says; else `fallback`. */
export const errorMessage = (e: unknown, fallback: string) => refusal(e, fallback, ["BAD_REQUEST", "CONFLICT"]);

/** "Add MCP server", or the editor of a tool with its actions. Mount it only while open. */
export function ToolSheet({ tool, onClose, onSaved }: Props) {
  const { t } = useTranslation("tools");
  const fieldLabels = t("sheet.field", { returnObjects: true });
  const [name, setName] = useState(tool?.name ?? "");
  const [url, setUrl] = useState(tool?.url ?? "");
  const [transport, setTransport] = useState<keyof typeof transportLabels>(tool?.transport ?? "streamable-http");
  const [signIn, setSignIn] = useState<(typeof SIGN_INS)[number]>(tool?.auth === "oauth" ? "oauth" : "headers");
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
  // Back to the plugin's value: the sheet closes, and opens again on the tool as it is then.
  const reset = useMutation(orpc.plugins.resetOverride.mutationOptions({ onSuccess: async () => { await invalidate(); onClose(); } }));
  const authorize = useMutation(orpc.tools.authorize.mutationOptions({ onSuccess: invalidate }));
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
  const busy = actionEnabled.isPending || create.isPending || update.isPending || del.isPending || refresh.isPending || authorize.isPending;

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

  /** Connect or Re-authorize: the page leaves for the server's sign-in, which comes back to the tool. */
  async function connect(client?: { clientId: string; clientSecret?: string } | null) {
    if (!current || unsavedTarget) return;
    setError(null);
    try {
      const { url: to } = await authorize.mutateAsync({ id: current.id, ...(client !== undefined ? { client } : {}) });
      window.location.assign(to);
    } catch (e) {
      const message = errorMessage(e, t("sheet.connectFailed"));
      setError(message);
      // The server's authorization server wants a client id it gave the owner: its fields open.
      if (["tools.fail.needsClient", "tools.fail.otherAuthServer"].includes((e as { data?: { key?: string } }).data?.key ?? "")) setAskClient(true);
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
      setError(errorMessage(e, t("sheet.deleteFailed")));
    }
  }

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto bg-surface sm:max-w-lg">
        <SheetHeader className="px-6 pt-6">
          <SheetTitle className="text-[20px] tracking-tight">{current ? current.name : t("sheet.addMcp")}</SheetTitle>
          <SheetDescription>{t("sheet.description")}</SheetDescription>
        </SheetHeader>
        <div className="space-y-8 px-6 pb-6">
          {current?.plugin && (
            <>
              <Overridden plugin={current.plugin.name} overridden={current.overridden} labels={fieldLabels} busy={reset.isPending} onReset={(field) => reset.mutate({ kind: "tool", id: current.id, field })} />
              <StemMarks kind="tool" id={current.id} labels={fieldLabels} onResolved={onClose} />
            </>
          )}
          {reset.error && <p role="alert" className="text-[13px] text-danger">{errorMessage(reset.error, t("sheet.resetFailed"))}</p>}
          <form
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <FormField label={t("sheet.name")} htmlFor="tool-name">
              <Input id="tool-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required autoFocus={!current} />
            </FormField>
            <FormField
              label={t("sheet.url")}
              htmlFor="tool-url"
              hint={current?.urlSet && url === current.url ? t("sheet.urlSecret") : t("sheet.urlHint")}
            >
              <Input id="tool-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} maxLength={2000} required placeholder={t("sheet.urlPlaceholder")} />
            </FormField>
            <FormField label={t("sheet.transport")} htmlFor="tool-transport">
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

            <FormField label={t("sheet.signIn")} htmlFor="tool-sign-in-kind" hint={signIn === "oauth" ? t("sheet.oauthHint") : undefined}>
              <Select value={signIn} onValueChange={(v) => setSignIn(v as (typeof SIGN_INS)[number])}>
                <SelectTrigger id="tool-sign-in-kind" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SIGN_INS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`sheet.signInKind.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            {signIn === "headers" && (
              <fieldset className="space-y-2">
                <legend className="mb-1.5 text-[13px] font-medium text-muted">{t("sheet.headers")}</legend>
                {elsewhere && headers.some((r) => r.stored && !r.removed) && (
                  <p role="status" className="rounded-lg bg-hover px-3 py-2 text-[13px] text-muted">
                    {t("sheet.elsewhere")}
                  </p>
                )}
                {headers
                  .filter((r) => !r.removed)
                  .map((row) => (
                    <div key={row.key} className="flex items-center gap-2">
                      <Input
                        aria-label={t("sheet.headerName")}
                        value={row.name}
                        onChange={(e) => setRow(row.key, { name: e.target.value })}
                        disabled={row.stored}
                        placeholder={t("sheet.headerPlaceholder")}
                        maxLength={100}
                        className="w-2/5"
                      />
                      <Input
                        aria-label={t("sheet.headerValue", { name: row.name || t("sheet.theHeader") })}
                        type="password"
                        autoComplete="off"
                        value={row.value}
                        onChange={(e) => setRow(row.key, { value: e.target.value })}
                        placeholder={row.stored ? (elsewhere ? t("sheet.notKept") : t("sheet.setKeep")) : t("sheet.valuePlaceholder")}
                        maxLength={4000}
                        required={!row.stored}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t("sheet.removeHeader", { name: row.name || t("sheet.header") })}
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
                  <Plus /> {t("sheet.addHeader")}
                </Button>
                <p className="text-[12px] text-faint">{t("sheet.encrypted")}</p>
              </fieldset>
            )}

            {error && (
              <p role="alert" className="text-[13px] text-danger">
                {error}
              </p>
            )}
            <div className="flex items-center gap-2 pt-1">
              <Button type="submit" disabled={busy || !name.trim() || !url.trim()}>
                {current ? t("sheet.save") : t("sheet.addServer")}
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

          {current?.auth === "oauth" &&
            current.oauthStatus &&
            signIn === "oauth" &&
            // A sign-in is for the saved server: an address or transport not saved yet would get it (and the client entered for it).
            (unsavedTarget ? (
              <p role="status" className="text-[13px] text-muted">
                {t("sheet.saveAddress")}
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

          {current && <ToolActions tool={current} busy={busy} onReload={() => void reload()} onToggle={(action, enabled) => actionEnabled.mutate({ toolId: current.id, action, enabled })} />}
          {current && <PollableActions toolId={current.id} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** A saved tool's actions, each with its switch, and the button that reads them from the server again. */
export function ToolActions({ tool, busy, onReload, onToggle }: { tool: Tool; busy: boolean; onReload: () => void; onToggle: (action: string, enabled: boolean) => void }) {
  const { t } = useTranslation("tools");
  const stored = useStored();
  return (
    <section aria-labelledby="tool-actions" className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id="tool-actions" className="text-[15px] font-medium">
          {t("sheet.actions", { count: tool.actions.length })}
        </h2>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onReload}>
          <RefreshCw /> {t("sheet.refresh")}
        </Button>
      </div>
      {tool.actionsError && (
        <p role="status" className="text-[13px] text-danger">
          {stored(tool.actionsError)}
        </p>
      )}
      <p className="text-[13px] text-muted">{t("sheet.actionsNote")}</p>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {tool.actions.map((a) => (
          <ActionItem key={a.name} action={a} tool={tool.name} enabled={!tool.disabled.includes(a.name)} busy={busy} onChange={(enabled) => onToggle(a.name, enabled)} />
        ))}
        {tool.actions.length === 0 && <li className="px-4 py-3 text-[13px] text-muted">{t("sheet.noAction")}</li>}
      </ul>
    </section>
  );
}

/** One action: its name, description and parameters (the top-level properties of its input schema). */
export function ActionItem({ action, tool, enabled, onChange, busy = false }: { action: Action; tool: string; enabled: boolean; onChange: (enabled: boolean) => void; busy?: boolean }) {
  const { t } = useTranslation("tools");
  const properties = (action.inputSchema.properties ?? {}) as Record<string, { type?: unknown; description?: unknown }>;
  const required = new Set(Array.isArray(action.inputSchema.required) ? (action.inputSchema.required as string[]) : []);
  return (
    <li className="space-y-1.5 px-4 py-3">
      <label className="flex items-start gap-2">
        <input type="checkbox" aria-label={t("sheet.enable", { tool, action: action.name })} checked={enabled} disabled={busy} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]" />
        <span className="break-all font-mono text-[13px] font-medium">{action.name}</span>
      </label>
      {!enabled && <p className="text-[12px] text-muted">{t("sheet.disabled")}</p>}
      {action.description && <p className="whitespace-pre-line text-[13px] text-muted">{action.description}</p>}
      {Object.keys(properties).length > 0 && (
        <ul className="space-y-0.5 text-[12.5px]">
          {Object.entries(properties).map(([param, schema]) => (
            <li key={param} className="text-muted">
              <span className="font-mono text-fg">{param}</span>
              {typeof schema.type === "string" && <span>{t("sheet.paramType", { type: schema.type })}</span>}
              {required.has(param) && <span>{t("sheet.required")}</span>}
              {typeof schema.description === "string" && <span>{t("sheet.paramDescription", { description: schema.description })}</span>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
