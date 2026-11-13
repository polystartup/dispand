import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { api, orpc } from "../../lib/api.ts";
import { FormField } from "./parts.tsx";
import { NativeTargetPicker, nativeWarning, useNativeTargets } from "./NativeSkills.tsx";

export const pluginTabs = [
  { to: "/settings/plugins", label: "Discover" },
  { to: "/settings/plugins/installed", label: "Installed" },
];

/** Why the procedure refused, when it says; else `fallback`. */
export function refusal(e: unknown, fallback: string): string {
  if (typeof e === "object" && e !== null && "code" in e) {
    const { code, message } = e as { code: unknown; message?: unknown };
    if ((code === "BAD_REQUEST" || code === "CONFLICT" || code === "FORBIDDEN" || code === "NOT_FOUND") && typeof message === "string" && !message.startsWith("Input validation")) {
      return message;
    }
  }
  return fallback;
}

type Preview = Awaited<ReturnType<typeof api.plugins.preview>>;

const componentLabels: Record<Preview["notImported"][number]["component"], string> = {
  manifest: "Manifest field",
  hook: "Hook",
  command: "Command",
  bin: "Programs",
  "mcp-server": "MCP server",
  skill: "Skill",
  definition: "Definition",
  file: "File",
};

const box = "mt-1 size-4 accent-[var(--color-accent)]";

export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-2">
      <h3 id={id} className="text-[13px] font-medium text-muted">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** The install sheet of a plugin: what it brings (skills and agents ticked by default, MCP servers not), and what is never imported. Mount it only while open. */
export function PluginInstallSheet({ marketplaceId, entryName, onClose }: { marketplaceId: string; entryName: string; onClose: () => void }) {
  const preview = useQuery({ ...orpc.plugins.preview.queryOptions({ input: { marketplaceId, entryName } }), retry: false, staleTime: Infinity });
  // A plugin changed since it was read: read it again, so the owner reviews what is there now.
  const [changed, setChanged] = useState<string | null>(null);
  const reread = (message: string) => {
    setChanged(message);
    void preview.refetch();
  };
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto bg-surface sm:max-w-lg">
        <SheetHeader className="px-6 pt-6">
          <SheetTitle className="text-[20px] tracking-tight">Install {entryName}</SheetTitle>
          <SheetDescription>Pick what to bring in. Its skills, tools and agents become Dispand ones; removing the plugin keeps its tools and agents.</SheetDescription>
        </SheetHeader>
        <div className="px-6 pb-6">
          {changed && (
            <p role="alert" className="mb-4 text-[13px] text-danger">
              {changed}
            </p>
          )}
          {preview.data ? (
            // A new read starts the form over: nothing stays ticked from the old one.
            <InstallForm key={preview.data.reviewed} marketplaceId={marketplaceId} entryName={entryName} preview={preview.data} onClose={onClose} onChanged={reread} />
          ) : preview.error ? (
            <p role="alert" className="text-[13px] text-danger">
              {refusal(preview.error, "Could not read the plugin.")}
            </p>
          ) : (
            <p className="text-[13px] text-muted">Reading the plugin…</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** A set with `name` toggled. */
export function toggled(set: Set<string>, name: string): Set<string> {
  const next = new Set(set);
  if (!next.delete(name)) next.add(name);
  return next;
}

export function Check({ checked, onChange, label, detail, mono }: { checked: boolean; onChange: () => void; label: string; detail: string; mono?: boolean }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-hover">
      <input type="checkbox" checked={checked} onChange={onChange} className={box} />
      <span className="min-w-0">
        <span className={`block text-[13px] font-medium ${mono ? "font-mono" : ""}`}>{label}</span>
        <span className="line-clamp-2 block text-[13px] text-muted [overflow-wrap:anywhere]">{detail}</span>
      </span>
    </label>
  );
}

function InstallForm({
  marketplaceId,
  entryName,
  preview,
  onClose,
  onChanged,
}: {
  marketplaceId: string;
  entryName: string;
  preview: Preview;
  onClose: () => void;
  onChanged: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const harnesses = useQuery(orpc.harnesses.list.queryOptions());
  const runners = useQuery(orpc.runners.list.queryOptions());
  const install = useMutation(
    orpc.plugins.install.mutationOptions({
      onSuccess: () =>
        Promise.all([orpc.plugins, orpc.skills, orpc.tools, orpc.agents].map((procedures) => queryClient.invalidateQueries({ queryKey: procedures.key() }))),
    }),
  );
  const httpServers = preview.mcpServers.filter((s) => s.type === "http");
  const [skills, setSkills] = useState(() => new Set(preview.skills.map((s) => s.name)));
  // Unticked: ticking a server is choosing to send its settings to the URL it shows.
  const [servers, setServers] = useState(() => new Set<string>());
  const [agents, setAgents] = useState(() => new Set(preview.agents.map((a) => a.name)));
  const [harnessId, setHarnessId] = useState("");
  const [native, setNative] = useState(true);
  const targets = useNativeTargets(harnesses.data ?? [], runners.data ?? []);
  const [excludedTargets, setExcludedTargets] = useState(() => new Set<string>());
  const nativeTargets = new Set(targets.filter((t) => t.enabled && !excludedTargets.has(t.harness.id)).map((t) => t.harness.id));
  // Workspace installation is committed once; failed native operations never resubmit it.
  const [nativeProgress, setNativeProgress] = useState<{ id: string; name: string; status: "Installing…" | "Installed" | "Failed"; error?: string }[] | null>(null);
  // Server name → `${VAR}` → value. Sent only for the ticked servers, never shown again.
  const [settings, setSettings] = useState<Record<string, Record<string, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const setSetting = (server: string, name: string, value: string) => setSettings((prev) => ({ ...prev, [server]: { ...prev[server], [name]: value } }));

  async function submit() {
    setError(null);
    const mcpServers = httpServers.map((s) => s.name).filter((n) => servers.has(n));
    try {
      const result = await install.mutateAsync({
        marketplaceId,
        entryName,
        skills: preview.skills.map((s) => s.name).filter((n) => skills.has(n)),
        mcpServers,
        reviewed: preview.reviewed,
        ...(native ? { nativeInstall: true } : {}),
        agents: preview.agents.map((a) => a.name).filter((n) => agents.has(n)),
        ...(agents.size > 0 ? { harnessId } : {}),
        settings: Object.fromEntries(mcpServers.flatMap((n) => (settings[n] ? [[n, settings[n]]] : []))),
      });
      if (!native || !nativeTargets.size) { onClose(); return; }
      const selected = (harnesses.data ?? []).flatMap((h) => h.type === "cli" && nativeTargets.has(h.id) ? [h] : []);
      setNativeProgress(selected.map((h) => ({ id: h.id, name: h.name, status: "Installing…" })));
      const groups = new Map<string, typeof selected>();
      for (const h of selected) groups.set(h.runnerId, [...(groups.get(h.runnerId) ?? []), h]);
      await Promise.all([...groups.values()].map(async (group) => {
        const request = { harnessIds: group.map((h) => h.id), resource: { kind: "plugin" as const, id: result.pluginId }, action: "add" as const };
        let report: Awaited<ReturnType<typeof api.runners.workspacePlugin>> = {};
        try {
          report = await api.runners.workspacePlugin({ ...request, dryRun: true });
          if (report.revision && !report.blocked && !report.error) report = await api.runners.workspacePlugin({ ...request, dryRun: false, revision: report.revision });
        } catch (e) {
          report = { ...report, error: refusal(e, "Native installation failed. Check Harness inventory before retrying; some changes may have completed.") };
        }
        setNativeProgress((progress) => progress!.map((row) => {
          const h = group.find((h) => h.id === row.id);
          if (!h) return row;
          const outcome = report.results?.find((r) => r.harness === h.kind);
          const installed = outcome?.status === "installed" || outcome?.status === "already_installed";
          return { ...row, status: installed ? "Installed" : "Failed", error: installed ? undefined : report.error ?? "Native installation did not complete. Check Harness inventory before retrying." };
        }));
        await queryClient.invalidateQueries({ queryKey: ["native-plugins", group[0]!.runnerId] });
      }));
    } catch (e) {
      const message = refusal(e, "Could not install the plugin.");
      if (typeof e === "object" && e !== null && "code" in e && e.code === "CONFLICT") onChanged(message);
      else setError(message);
    }
  }

  const { definitions } = preview;
  const defined = definitions.primitives.length + definitions.agents.length + definitions.triggers.length;
  const picked = skills.size + servers.size + agents.size;
  if (nativeProgress) {
    return (
      <div className="space-y-4">
        <p className="text-[13px]">Installed in the workspace.</p>
        <ul aria-label="Native installations" className="space-y-2 text-[13px]">
          {nativeProgress.map((row) => <li key={row.id} className="rounded-lg border border-line p-3">
            <div className="flex items-center justify-between gap-3"><span>{row.name}</span><span role="status" aria-label={`${row.name}: ${row.status}`}>{row.status}</span></div>
            {row.error && <p role="alert" className="mt-1 text-danger">{row.error}</p>}
          </li>)}
        </ul>
        <Button type="button" disabled={nativeProgress.some((row) => row.status === "Installing…")} onClick={onClose}>Done</Button>
      </div>
    );
  }
  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Section id="install-skills" title="Skills">
        {preview.skills.length === 0 ? (
          <p className="text-[13px] text-faint">No skill to import.</p>
        ) : (
          <ul className="space-y-1">
            {preview.skills.map((s) => (
              <li key={s.name}>
                <Check checked={skills.has(s.name)} onChange={() => setSkills((prev) => toggled(prev, s.name))} label={s.name} detail={s.description} mono />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="install-native" title="Native installation (optional)">
        <Check checked={native} onChange={() => setNative((value) => !value)} label="Install the complete native plugin" detail="Install on the selected harnesses and keep workspace copies for fallback." />
        {native && <>
          <p className="text-[13px] text-muted">{nativeWarning}</p>
          <NativeTargetPicker targets={targets} selected={nativeTargets} onChange={(id) => setExcludedTargets((prev) => toggled(prev, id))} />
          {(harnesses.error || runners.error) && <p role="alert" className="text-[13px] text-danger">Could not load native targets.</p>}
        </>}
      </Section>

      {preview.mcpServers.length > 0 && (
        <Section id="install-tools" title="MCP servers">
          <p className="text-[12px] text-faint">Each becomes a tool that calls the URL shown. Its settings go there, stored encrypted and never shown again.</p>
          <ul className="space-y-1">
            {preview.mcpServers.map((s) =>
              s.type === "http" ? (
                <li key={s.name} className="space-y-2">
                  <Check
                    checked={servers.has(s.name)}
                    onChange={() => setServers((prev) => toggled(prev, s.name))}
                    label={s.name}
                    detail={s.url ?? "MCP server over HTTP"}
                  />
                  {servers.has(s.name) &&
                    s.settings.map((name) => (
                      <div key={name} className="pl-8">
                        <FormField label={name} htmlFor={`setting-${s.name}-${name}`}>
                          <Input
                            id={`setting-${s.name}-${name}`}
                            type="password"
                            autoComplete="off"
                            value={settings[s.name]?.[name] ?? ""}
                            onChange={(e) => setSetting(s.name, name, e.target.value)}
                            maxLength={4000}
                          />
                        </FormField>
                      </div>
                    ))}
                </li>
              ) : (
                <li key={s.name}>
                  <label className="flex items-start gap-2.5 px-2 py-1.5 opacity-60">
                    <input type="checkbox" disabled checked={false} onChange={() => undefined} className={box} />
                    <span>
                      <span className="block text-[13px] font-medium">{s.name}</span>
                      <span className="block text-[13px] text-muted">Runs a command on a machine: not yet supported</span>
                    </span>
                  </label>
                </li>
              ),
            )}
          </ul>
        </Section>
      )}

      {preview.agents.length > 0 && (
        <Section id="install-agents" title="Agents">
          <ul className="space-y-1">
            {preview.agents.map((a) => (
              <li key={a.name}>
                <Check checked={agents.has(a.name)} onChange={() => setAgents((prev) => toggled(prev, a.name))} label={a.name} detail={a.description || "Agent"} />
              </li>
            ))}
          </ul>
          {agents.size > 0 && (
            <FormField label="Harness" htmlFor="install-harness" hint="The agents run there, with the plugin's skills and tools you import.">
              <Select value={harnessId} onValueChange={setHarnessId}>
                <SelectTrigger id="install-harness" className="w-full">
                  <SelectValue placeholder="Pick a harness" />
                </SelectTrigger>
                <SelectContent>
                  {harnesses.data?.map((h) => (
                    <SelectItem key={h.id} value={h.id}>
                      {h.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          )}
          {agents.size > 0 && harnesses.data?.length === 0 && <p className="text-[13px] text-faint">Add a harness first to import agents.</p>}
        </Section>
      )}

      {defined > 0 && (
        <Section id="install-definitions" title="Definitions">
          <p className="text-[12px] text-faint">
            {definitions.description ?? "What the plugin can set up in your workspace."} Installing registers them; nothing is made until you set them up from the plugin.
          </p>
          <ul className="space-y-1 text-[13px]">
            {(
              [
                ["Tables", definitions.primitives.map((d) => d.name)],
                ["Agents", definitions.agents.map((d) => d.name)],
                ["Triggers", definitions.triggers.map((d) => `${d.name} (${d.agent})`)],
              ] as const
            ).map(([label, names]) =>
              names.length > 0 ? (
                <li key={label} className="px-2">
                  <span className="text-muted">{label}: </span>
                  {names.join(", ")}
                </li>
              ) : null,
            )}
          </ul>
        </Section>
      )}

      {preview.notImported.length > 0 && (
        <Section id="install-not-imported" title="Not imported">
          <p className="text-[12px] text-faint">Dispand never brings in what would run code you haven't approved, nor files a skill can't hold.</p>
          <ul className="divide-y divide-line rounded-xl border border-line">
            {preview.notImported.map((n, i) => (
              <li key={i} className="px-3 py-2 text-[13px]">
                <span className="text-muted">{componentLabels[n.component]} </span>
                <span className="break-all font-mono">{n.name}</span>
                <span className="block text-faint">{n.reason}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {error && (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={install.isPending || (picked === 0 && defined === 0 && !native) || (agents.size > 0 && !harnessId) || (native && nativeTargets.size === 0)}>
          {install.isPending ? "Installing…" : "Install"}
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
