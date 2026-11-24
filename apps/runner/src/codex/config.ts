// The config overrides every Codex session starts with: Dispand's permission profile.
import { GRANT_HEADER } from "../subscriptions/relay.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { realOf } from "../boundary.ts";
import type { JsonValue } from "./protocol/serde_json/JsonValue.ts";

/** The permission profile Codex sessions run under, unless the machine allows bypass. */
export const PROFILE = "dispand";
/** Codex's built-in profile with no sandbox: only with `allowBypass`. */
export const BYPASS_PROFILE = ":danger-full-access";

/**
 * What a restricted session (a limited Job) turns off, beyond its profile (`codexConfig`): every
 * native tool a switch removes (shell, view_image, web search, image generation, browser and
 * computer use, apps and plugins, subagents, goals, sleep, asking the person), hooks, memories and
 * the skills catalog. Checked with codex 0.169.0 on what the model is sent: what stays is code
 * mode's `exec`/`wait` (an isolate with no file system or network, calling only these tools),
 * `apply_patch` (set by the model's catalog entry, no switch: inert, as the session's turns get no
 * environment), the clock, the MCP resource tools, `submit_outputs` and the Job's server.
 */
const RESTRICTED: Record<string, JsonValue> = {
  features: {
    shell_tool: false, unified_exec: false, view_image: false, standalone_web_search: false, image_generation: false,
    browser_use: false, browser_use_external: false, in_app_browser: false, computer_use: false, apps: false, plugins: false,
    tool_suggest: false, skill_mcp_dependency_install: false, multi_agent: false, multi_agent_v2: false, goals: false,
    sleep_tool: false, hooks: false, memories: false,
  },
  agents: { enabled: false },
  web_search: "disabled",
  tools: { experimental_request_user_input: { enabled: false } },
  skills: { include_instructions: false, bundled: { enabled: false } },
  include_collaboration_mode_instructions: false,
};

/**
 * Overrides for `thread/start` and `thread/resume`. Without bypass, profile `dispand`: the
 * built-in `:workspace` (read everywhere, write in the session folder), minus every path in
 * `denied` (`codexDenied`: the runner's config, the CLIs' user config and credentials, as given,
 * as real paths and where their symlinks lead) denied outright, the session's skill packages (`pluginsDir`)
 * readable only, and the folder's own Codex config and instructions (`.codex`, `.agents`,
 * `AGENTS.md`, `AGENTS.override.md`) read-only. Network on, as for Claude Code's Bash. No
 * `DISPAND_*` variable reaches a shell. The runner never marks a project trusted. Restricted:
 * `:read-only` minus `denied`, no network, and `RESTRICTED`, bypass or not.
 */
export function codexConfig(o: { denied: string[]; codexHome?: string; pluginsDir?: string; bypass: boolean; restricted?: boolean; mcpServers?: Record<string, JsonValue>; modelBaseUrl?: string; subscriptionRelay?: { url: string; grant: string } }): Record<string, JsonValue> {
  if (o.modelBaseUrl && o.subscriptionRelay) throw new Error("a session uses the runner's model key or a personal subscription, never both");
  // In a worker, the model is reached through the supervisor, which adds the runner's key.
  const provider: Record<string, JsonValue> = o.modelBaseUrl ? { model_provider: "dispand", model_providers: { dispand: { name: "Dispand runner", base_url: `${o.modelBaseUrl}/v1`, wire_api: "responses" } } }
    // A personal subscription: the supervisor's relay attaches the person's credential, so the worker holds none (no key variable, no login).
    // Each request presents its grant in a header, never in the URL a transcript could keep.
    : o.subscriptionRelay ? { model_provider: "subscription", model_providers: { subscription: { name: "Personal subscription", base_url: o.subscriptionRelay.url, wire_api: "responses", http_headers: { [GRANT_HEADER]: o.subscriptionRelay.grant } } } }
    : {};
  const shell = { ...provider, shell_environment_policy: { exclude: ["DISPAND_*"] }, ...(o.mcpServers && Object.keys(o.mcpServers).length > 0 ? { mcp_servers: o.mcpServers } : {}) };
  const filesystem: Record<string, JsonValue> = {};
  for (const path of o.denied) filesystem[path] = "deny";
  if (o.restricted) {
    return { default_permissions: PROFILE, permissions: { [PROFILE]: { extends: ":read-only", filesystem, network: { enabled: false } } }, ...shell, ...RESTRICTED };
  }
  if (o.bypass) return { default_permissions: BYPASS_PROFILE, ...shell };
  // Native plugin code and skills are readable; config, credentials and plugin state
  // remain under the existing deny rules. Paths come only from the runner's local environment.
  const home = o.codexHome || join(homedir(), ".codex");
  for (const path of [join(home, "plugins", "cache"), join(home, "plugins", "marketplaces"), join(home, "skills")]) {
    // Codex's sandbox mounts every path it is given: a missing one (a fresh Codex home) would fail every command.
    if (!existsSync(path)) continue;
    filesystem[path] = "read";
    filesystem[realOf(path)] = "read";
  }
  if (o.pluginsDir) filesystem[o.pluginsDir] = "read";
  filesystem[":workspace_roots"] = { ".": "write", ".codex": "read", ".agents": "read", "AGENTS.md": "read", "AGENTS.override.md": "read" };
  return {
    default_permissions: PROFILE,
    permissions: { [PROFILE]: { extends: ":workspace", filesystem, network: { enabled: true } } },
    ...shell,
  };
}
