import { expect, test } from "vitest";
import { installNativePlugins } from "./native-plugins.ts";

const hook = (key: string, source: string, pluginId: string | null, eventName = "userPromptSubmit") => ({ key, source, pluginId, eventName, currentHash: `hash-${key}`, trustStatus: "untrusted" });

/** An app-server that records its requests; `failing` names a plugin whose install fails. */
function fake(hooks: ReturnType<typeof hook>[], failing?: string) {
  const calls: [string, unknown][] = [];
  const request = async (method: string, params: unknown) => {
    calls.push([method, params]);
    if (method === "plugin/install" && (params as { pluginName: string }).pluginName === failing) throw new Error("install failed");
    if (method === "hooks/list") return { data: [{ cwd: "/w", hooks, warnings: [], errors: [] }] };
    if (method === "plugin/read") return { plugin: { mcpServers: (params as { pluginName: string }).pluginName === "demo" ? ["kept", "other"] : [] } };
    return {};
  };
  return { rpc: { request } as never, calls };
}

test("installs each plugin from the marketplace, then trusts by hash only the hooks those plugins brought", async () => {
  const { rpc, calls } = fake([
    hook("demo@dispand:h:0", "plugin", "demo@dispand"),
    // Its hooks that could answer for a permission stay untrusted.
    hook("demo@dispand:p:0", "plugin", "demo@dispand", "permissionRequest"),
    hook("demo@dispand:t:0", "plugin", "demo@dispand", "preToolUse"),
    hook("other@elsewhere:h:0", "plugin", "other@elsewhere"),
    hook("project:h:0", "project", null),
  ]);
  await installNativePlugins(rpc, "/run/plugins/.claude-plugin/marketplace.json", ["demo"], "/w");
  expect(calls.map(([m]) => m)).toEqual(["plugin/install", "plugin/read", "hooks/list", "config/batchWrite"]);
  expect(calls[0]![1]).toEqual({ marketplacePath: "/run/plugins/.claude-plugin/marketplace.json", pluginName: "demo" });
  expect(calls[3]![1]).toEqual({ edits: [{ keyPath: 'hooks.state."demo@dispand:h:0".trusted_hash', value: "hash-demo@dispand:h:0", mergeStrategy: "replace" }], reloadUserConfig: true });
});

test("no hook of its plugins: nothing is trusted", async () => {
  const { rpc, calls } = fake([hook("project:h:0", "project", null)]);
  await installNativePlugins(rpc, "/m", ["demo"], "/w");
  expect(calls.map(([m]) => m)).toEqual(["plugin/install", "plugin/read", "hooks/list"]);
});

test("every tool of every server its plugins brought asks, whatever the tools say of themselves; a plugin with none adds nothing", async () => {
  const { rpc } = fake([]);
  expect(await installNativePlugins(rpc, "/m", ["demo", "quiet"], "/w")).toEqual({
    "demo@dispand": { mcp_servers: { kept: { default_tools_approval_mode: "prompt" }, other: { default_tools_approval_mode: "prompt" } } },
  });
});

test("a failed install fails the start, naming the plugin, and trusts nothing", async () => {
  const { rpc, calls } = fake([hook("demo@dispand:h:0", "plugin", "demo@dispand")], "demo");
  await expect(installNativePlugins(rpc, "/m", ["demo", "other"], "/w")).rejects.toThrow("the native plugin demo couldn't be installed in Codex");
  expect(calls.map(([m]) => m)).toEqual(["plugin/install"]);
});
