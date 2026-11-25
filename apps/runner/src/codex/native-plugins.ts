// A conversation's native plugins in Codex (the container image): installed from the marketplace
// the supervisor wrote beside their read-only mounts, into the worker's fresh Codex home, before
// the first turn. Their hooks arrive untrusted; the supervisor trusts exactly those, by hash.
import type { JsonValue } from "./protocol/serde_json/JsonValue.ts";
import type { CodexRpc } from "./rpc.ts";

/** Marketplace name Codex gives the plugins (`<name>@dispand`), as `codexMarketplace` writes it. */
const MARKETPLACE = "dispand";

/** Hook events that can answer for a permission: never trusted by the supervisor. */
const DECIDING = new Set<string>(["permissionRequest", "preToolUse"]);

/**
 * Installs each plugin, then trusts the hooks they brought and no other: a hook of any other
 * source, of a plugin not installed here, or of an event that decides permissions, stays as Codex left it. Throws on a failed install.
 * Returns the thread's `plugins` config: every tool of every server the plugins brought asks
 * (Codex runs a tool its server labels read-only unasked otherwise; a plugin's labels decide nothing).
 */
export async function installNativePlugins(rpc: Pick<CodexRpc, "request">, marketplacePath: string, names: string[], cwd: string): Promise<Record<string, JsonValue>> {
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
  // Never a hook that takes part in a permission decision: a grant isn't a grant to approve the
  // CLI's actions on the owner's behalf, which stays the broker's alone.
  const hooks = (await rpc.request("hooks/list", { cwds: [cwd] })).data.flatMap((entry) => entry.hooks).filter((h) => h.source === "plugin" && h.pluginId !== null && ours.has(h.pluginId) && !DECIDING.has(h.eventName));
  if (!hooks.length) return prompts;
  // Trust follows the hash the supervisor read now: a hook changed since is untrusted again.
  await rpc.request("config/batchWrite", { edits: hooks.map((h) => ({ keyPath: `hooks.state.${JSON.stringify(h.key)}.trusted_hash`, value: h.currentHash, mergeStrategy: "replace" as const })), reloadUserConfig: true });
  return prompts;
}
