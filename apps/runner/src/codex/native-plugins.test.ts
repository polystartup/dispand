import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { installNativePlugins, tomlString } from "./native-plugins.ts";

const HOME = "/run/cli/codex";
const hook = (pluginId: string | null, source: string, eventName: string, command: string, extra: Record<string, unknown> = {}) => ({
  key: `${pluginId}:${command}`, eventName, matcher: null, timeoutSec: 600, statusMessage: null, additionalContextLimit: null,
  sourcePath: `${HOME}/plugins/cache/dispand/${pluginId?.split("@")[0]}/1.0.0/hooks/hooks.json`, source, pluginId, environmentId: null,
  displayOrder: 0, enabled: true, isManaged: false, currentHash: "h", trustStatus: "untrusted", handlerType: "command", command, async: false, ...extra,
});

let dir: string;
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/**
 * An app-server that records its requests: `hooks/list` gives `before` until the requirements are
 * written, then what Codex would take from them (`after`, managed by default). `failing` names a plugin whose install fails.
 */
async function fake(before: ReturnType<typeof hook>[], { failing, after }: { failing?: string; after?: (written: string) => unknown[] } = {}) {
  dir = await mkdtemp(join(tmpdir(), "codex-req-"));
  const file = join(dir, "requirements.toml");
  const calls: [string, unknown][] = [];
  let written: string | undefined;
  const request = async (method: string, params: unknown) => {
    calls.push([method, params]);
    if (method === "plugin/install" && (params as { pluginName: string }).pluginName === failing) throw new Error("install failed");
    if (method === "plugin/read") return { plugin: { mcpServers: (params as { pluginName: string }).pluginName === "demo" ? ["kept", "other"] : [] } };
    if (method === "hooks/list") {
      written = await readFile(file, "utf8").catch(() => undefined);
      const hooks = written ? (after ?? ((w: string) => [...w.matchAll(/^command = /gm)].map(() => ({ isManaged: true, trustStatus: "managed" }))))(written) : before;
      return { data: [{ cwd: "/w", hooks, warnings: [], errors: [] }] };
    }
    return {};
  };
  return { rpc: { request } as never, calls, requirements: { file, cwd: "/w", codexHome: HOME, roots: { demo: "/run/plugins/plugin_a" } }, read: () => readFile(file, "utf8") };
}

test("its hooks run only as managed hooks of the requirements written from Codex's own reading of them, with their plugin's variables on its read-only mount", async () => {
  const { rpc, calls, requirements, read } = await fake([
    hook("demo@dispand", "plugin", "userPromptSubmit", 'touch "$PLUGIN_DATA/a b"', { async: true }),
    // A path into Codex's writable install copy, as Codex may have expanded it: the read-only mount instead.
    hook("demo@dispand", "plugin", "postToolUse", `${HOME}/plugins/cache/dispand/demo/1.0.0/post.sh`, { matcher: "Bash", timeoutSec: 7 }),
    // Never one that could answer for a permission, of another plugin, or of another source.
    hook("demo@dispand", "plugin", "permissionRequest", "allow"),
    hook("other@elsewhere", "plugin", "stop", "theirs"),
    hook(null, "user", "stop", "planted"),
  ]);
  await installNativePlugins(rpc, "/run/plugins/.claude-plugin/marketplace.json", ["demo"], requirements);
  expect(calls.map(([m]) => m)).toEqual(["plugin/install", "plugin/read", "hooks/list", "hooks/list"]);
  const vars = `export PLUGIN_ROOT='/run/plugins/plugin_a' CLAUDE_PLUGIN_ROOT='/run/plugins/plugin_a' PLUGIN_DATA='${HOME}/plugins/data/demo-dispand' CLAUDE_PLUGIN_DATA='${HOME}/plugins/data/demo-dispand'; `;
  expect(await read()).toBe([
    "allow_managed_hooks_only = true",
    "",
    "[[hooks.UserPromptSubmit]]",
    "[[hooks.UserPromptSubmit.hooks]]",
    'type = "command"',
    `command = ${tomlString(`${vars}touch "$PLUGIN_DATA/a b"`)}`,
    "timeout = 600",
    "async = true",
    "",
    "[[hooks.PostToolUse]]",
    'matcher = "Bash"',
    "[[hooks.PostToolUse.hooks]]",
    'type = "command"',
    `command = ${tomlString(`${vars}/run/plugins/plugin_a/post.sh`)}`,
    "timeout = 7",
    "async = false",
    "",
  ].join("\n"));
});

test("no hook of its plugins: only managed hooks, and none", async () => {
  const { rpc, requirements, read } = await fake([hook(null, "user", "stop", "planted")]);
  await installNativePlugins(rpc, "/m", ["demo"], requirements);
  expect(await read()).toBe("allow_managed_hooks_only = true\n");
});

test("a start whose Codex runs any hook that isn't one of the written managed ones fails", async () => {
  const { rpc, requirements } = await fake([hook("demo@dispand", "plugin", "stop", "x")], { after: () => [{ isManaged: true, trustStatus: "managed" }, { isManaged: false, trustStatus: "trusted" }] });
  await expect(installNativePlugins(rpc, "/m", ["demo"], requirements)).rejects.toThrow("Codex didn't take the native plugins' hooks as managed");
});

test("every tool of every server its plugins brought asks, whatever the tools say of themselves; a plugin with none adds nothing", async () => {
  const { rpc, requirements } = await fake([]);
  expect(await installNativePlugins(rpc, "/m", ["demo", "quiet"], requirements)).toEqual({
    "demo@dispand": { mcp_servers: { kept: { default_tools_approval_mode: "prompt" }, other: { default_tools_approval_mode: "prompt" } } },
  });
});

test("a failed install fails the start, naming the plugin", async () => {
  const { rpc, calls, requirements } = await fake([], { failing: "demo" });
  await expect(installNativePlugins(rpc, "/m", ["demo", "other"], requirements)).rejects.toThrow("the native plugin demo couldn't be installed in Codex");
  expect(calls.map(([m]) => m)).toEqual(["plugin/install"]);
});

test("a TOML string escapes quotes, backslashes and every control character, DEL included", () => {
  expect(tomlString('a "b" \\ c\n\t\u0000\u007f')).toBe('"a \\"b\\" \\\\ c\\u000a\\u0009\\u0000\\u007f"');
});
