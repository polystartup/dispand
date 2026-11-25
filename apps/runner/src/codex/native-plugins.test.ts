import { expect, test } from "vitest";
import { installNativePlugins } from "./native-plugins.ts";

/** An app-server that records its requests; `failing` names a plugin whose install fails. */
function fake(failing?: string) {
  const calls: [string, unknown][] = [];
  const request = async (method: string, params: unknown) => {
    calls.push([method, params]);
    if (method === "plugin/install" && (params as { pluginName: string }).pluginName === failing) throw new Error("install failed");
    if (method === "plugin/read") return { plugin: { mcpServers: (params as { pluginName: string }).pluginName === "demo" ? ["kept", "other"] : [] } };
    return {};
  };
  return { rpc: { request } as never, calls };
}

test("installs each plugin from the marketplace and writes no hook trust: the read-only requirements decide which hooks run", async () => {
  const { rpc, calls } = fake();
  await installNativePlugins(rpc, "/run/plugins/.claude-plugin/marketplace.json", ["demo"]);
  expect(calls.map(([m]) => m)).toEqual(["plugin/install", "plugin/read"]);
  expect(calls[0]![1]).toEqual({ marketplacePath: "/run/plugins/.claude-plugin/marketplace.json", pluginName: "demo" });
});

test("every tool of every server its plugins brought asks, whatever the tools say of themselves; a plugin with none adds nothing", async () => {
  const { rpc } = fake();
  expect(await installNativePlugins(rpc, "/m", ["demo", "quiet"])).toEqual({
    "demo@dispand": { mcp_servers: { kept: { default_tools_approval_mode: "prompt" }, other: { default_tools_approval_mode: "prompt" } } },
  });
});

test("a failed install fails the start, naming the plugin", async () => {
  const { rpc, calls } = fake("demo");
  await expect(installNativePlugins(rpc, "/m", ["demo", "other"])).rejects.toThrow("the native plugin demo couldn't be installed in Codex");
  expect(calls.map(([m]) => m)).toEqual(["plugin/install"]);
});
