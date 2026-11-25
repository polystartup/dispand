// A conversation's native plugins in Codex (the container image): installed from the marketplace
// the supervisor wrote beside their read-only mounts, into the worker's fresh Codex home, before
// the first turn. Their hooks then run only as managed hooks of Codex's system requirements, a
// file the supervisor writes from Codex's own reading of them and the worker only reads: hook
// trust never comes from the worker's writable Codex home.
import { writeFile } from "node:fs/promises";
import type { HookMetadata } from "./protocol/v2/HookMetadata.ts";
import type { JsonValue } from "./protocol/serde_json/JsonValue.ts";
import type { CodexRpc } from "./rpc.ts";

/** Marketplace name Codex gives the plugins (`<name>@dispand`), as `codexMarketplace` writes it. */
const MARKETPLACE = "dispand";

/** Codex's hook events, as its requirements name them: never one that can answer for a permission. */
const EVENTS = ["PreModelRequest", "PostModelRequest", "PostToolUse", "PreCompact", "PostCompact", "SessionStart", "SessionEnd", "UserPromptSubmit", "SubagentStart", "SubagentStop", "Stop", "Interrupt"];

/** A TOML basic string: `\`, `"` and every control character (DEL included) escaped. */
export const tomlString = (s: string) => `"${[...s].map((c) => {
  const code = c.charCodeAt(0);
  return c === "\\" || c === '"' ? `\\${c}` : code < 0x20 || code === 0x7f ? `\\u${code.toString(16).padStart(4, "0")}` : c;
}).join("")}"`;
const shellQuoted = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Codex's requirements running these hooks, and only managed ones (`allow_managed_hooks_only`):
 * each as Codex read it from its plugin (event, matcher, timeout, async), its command given the
 * variables Codex gives a plugin's hook (`PLUGIN_ROOT`, `PLUGIN_DATA` and their `CLAUDE_` names),
 * which it doesn't give a managed one. Its root is the plugin's read-only mount (`roots`, by plugin
 * name), never Codex's writable install copy, whose path is replaced wherever the command holds it:
 * a managed hook has no hash check, so its code must be what can't change. A hook of a plugin
 * without a mount runs nowhere.
 */
export function managedRequirements(hooks: HookMetadata[], codexHome: string, roots: Record<string, string>): string {
  const lines = ["allow_managed_hooks_only = true"];
  for (const h of hooks) {
    const event = EVENTS.find((e) => e.toLowerCase() === h.eventName.toLowerCase());
    if (!event || h.handlerType !== "command" || h.pluginId === null) continue;
    const installed = new RegExp(`^(${codexHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/plugins/cache/[^/]+/[^/]+/[^/]+)/`).exec(h.sourcePath)?.[1];
    const root = roots[h.pluginId.split("@")[0]!];
    if (!installed || !root) continue;
    const data = `${codexHome}/plugins/data/${h.pluginId.replace("@", "-")}`;
    const vars = `export PLUGIN_ROOT=${shellQuoted(root)} CLAUDE_PLUGIN_ROOT=${shellQuoted(root)} PLUGIN_DATA=${shellQuoted(data)} CLAUDE_PLUGIN_DATA=${shellQuoted(data)}; `;
    const command = h.command.split(installed).join(root);
    lines.push("", `[[hooks.${event}]]`, ...(h.matcher !== null ? [`matcher = ${tomlString(h.matcher)}`] : []));
    lines.push(`[[hooks.${event}.hooks]]`, 'type = "command"', `command = ${tomlString(vars + command)}`, `timeout = ${String(h.timeoutSec)}`, `async = ${h.async}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Installs each plugin, then has their hooks run only as managed hooks: lists them as Codex read
 * them, writes `requirements` (the supervisor's file, which the worker mounts read-only as Codex's
 * system requirements) and checks that Codex now lists exactly those, managed, and no other hook.
 * Throws on a failed install or check. Returns the thread's `plugins` config: every tool of every
 * server the plugins brought asks (Codex runs a tool its server labels read-only unasked otherwise;
 * a plugin's labels decide nothing).
 */
export async function installNativePlugins(rpc: Pick<CodexRpc, "request">, marketplacePath: string, names: string[], requirements: { file: string; cwd: string; codexHome: string; roots: Record<string, string> }): Promise<Record<string, JsonValue>> {
  for (const pluginName of names) {
    await rpc.request("plugin/install", { marketplacePath, pluginName }).catch(() => {
      throw new Error(`the native plugin ${pluginName} couldn't be installed in Codex`);
    });
  }
  const prompts: Record<string, JsonValue> = {};
  for (const pluginName of names) {
    const { plugin } = (await rpc.request("plugin/read", { marketplacePath, pluginName })) as { plugin: { mcpServers: string[] } };
    if (plugin.mcpServers.length) prompts[`${pluginName}@${MARKETPLACE}`] = { mcp_servers: Object.fromEntries(plugin.mcpServers.map((server) => [server, { default_tools_approval_mode: "prompt" }])) };
  }
  const ours = new Set(names.map((name) => `${name}@${MARKETPLACE}`));
  const listed = async () => (await rpc.request("hooks/list", { cwds: [requirements.cwd] })).data.flatMap((entry) => entry.hooks);
  const hooks = (await listed()).filter((h) => h.source === "plugin" && h.pluginId !== null && ours.has(h.pluginId) && h.enabled);
  const content = managedRequirements(hooks, requirements.codexHome, requirements.roots);
  await writeFile(requirements.file, content);
  // Checked at use: what Codex runs now is exactly what was written, managed, and nothing else.
  const now = await listed();
  const expected = content.split("\n").filter((l) => l.startsWith("[[hooks.") && l.endsWith(".hooks]]")).length;
  if (now.length !== expected || now.some((h) => !h.isManaged || h.trustStatus !== "managed")) throw new Error("Codex didn't take the native plugins' hooks as managed: none of them runs");
  return prompts;
}
