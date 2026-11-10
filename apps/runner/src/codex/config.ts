// The config overrides every Codex session starts with: Dispand's permission profile.
import type { JsonValue } from "./protocol/serde_json/JsonValue.ts";

/** The permission profile Codex sessions run under, unless the machine allows bypass. */
export const PROFILE = "dispand";
/** Codex's built-in profile with no sandbox: only with `allowBypass`. */
export const BYPASS_PROFILE = ":danger-full-access";

/**
 * Overrides for `thread/start` and `thread/resume`. Without bypass, profile `dispand`: the
 * built-in `:workspace` (read everywhere, write in the session folder), minus every path in
 * `denied` (`codexDenied`: the runner's config, the CLIs' user config and credentials, as given,
 * as real paths and where their symlinks lead) denied outright, the session's skill packages (`pluginsDir`)
 * readable only, and the folder's own Codex config and instructions (`.codex`, `.agents`,
 * `AGENTS.md`, `AGENTS.override.md`) read-only. Network on, as for Claude Code's Bash. No
 * `DISPAND_*` variable reaches a shell. The runner never marks a project trusted.
 */
export function codexConfig(o: { denied: string[]; pluginsDir?: string; bypass: boolean; mcpServers?: Record<string, JsonValue> }): Record<string, JsonValue> {
  const shell = { shell_environment_policy: { exclude: ["DISPAND_*"] }, ...(o.mcpServers && Object.keys(o.mcpServers).length > 0 ? { mcp_servers: o.mcpServers } : {}) };
  if (o.bypass) return { default_permissions: BYPASS_PROFILE, ...shell };
  const filesystem: Record<string, JsonValue> = {};
  for (const path of o.denied) filesystem[path] = "deny";
  if (o.pluginsDir) filesystem[o.pluginsDir] = "read";
  filesystem[":workspace_roots"] = { ".": "write", ".codex": "read", ".agents": "read", "AGENTS.md": "read", "AGENTS.override.md": "read" };
  return {
    default_permissions: PROFILE,
    permissions: { [PROFILE]: { extends: ":workspace", filesystem, network: { enabled: true } } },
    ...shell,
  };
}
