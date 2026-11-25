// A conversation's native plugins in Codex (the container image): installed from the marketplace
// the supervisor wrote beside their read-only mounts, into the worker's fresh Codex home, before
// the first turn. Their hooks arrive untrusted; the supervisor trusts exactly those, by hash.
import type { CodexRpc } from "./rpc.ts";

/** Marketplace name Codex gives the plugins (`<name>@dispand`), as `codexMarketplace` writes it. */
const MARKETPLACE = "dispand";

/**
 * Installs each plugin, then trusts the hooks they brought and no other: a hook of any other
 * source, or of a plugin not installed here, stays as Codex left it. Throws on a failed install.
 */
export async function installNativePlugins(rpc: Pick<CodexRpc, "request">, marketplacePath: string, names: string[], cwd: string): Promise<void> {
  for (const pluginName of names) {
    await rpc.request("plugin/install", { marketplacePath, pluginName }).catch(() => {
      throw new Error(`the native plugin ${pluginName} couldn't be installed in Codex`);
    });
  }
  const ours = new Set(names.map((name) => `${name}@${MARKETPLACE}`));
  const hooks = (await rpc.request("hooks/list", { cwds: [cwd] })).data.flatMap((entry) => entry.hooks).filter((h) => h.source === "plugin" && h.pluginId !== null && ours.has(h.pluginId));
  if (!hooks.length) return;
  // Trust follows the hash the supervisor read now: a hook changed since is untrusted again.
  await rpc.request("config/batchWrite", { edits: hooks.map((h) => ({ keyPath: `hooks.state.${JSON.stringify(h.key)}.trusted_hash`, value: h.currentHash, mergeStrategy: "replace" as const })), reloadUserConfig: true });
}
