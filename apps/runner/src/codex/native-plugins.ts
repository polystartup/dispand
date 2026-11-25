// A conversation's native plugins in Codex (the container image): installed from the marketplace
// the supervisor wrote beside their read-only mounts, into the worker's fresh Codex home, before
// the first turn. Their hooks don't run from the install: Codex runs only the managed hooks of the
// read-only requirements the supervisor wrote for the conversation (`writeCodexRequirements`).
import type { JsonValue } from "./protocol/serde_json/JsonValue.ts";
import type { CodexRpc } from "./rpc.ts";

/** Marketplace name Codex gives the plugins (`<name>@dispand`), as `codexMarketplace` writes it. */
const MARKETPLACE = "dispand";

/**
 * Installs each plugin. Throws on a failed install.
 * Returns the thread's `plugins` config: every tool of every server the plugins brought asks
 * (Codex runs a tool its server labels read-only unasked otherwise; a plugin's labels decide nothing).
 */
export async function installNativePlugins(rpc: Pick<CodexRpc, "request">, marketplacePath: string, names: string[]): Promise<Record<string, JsonValue>> {
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
  return prompts;
}
