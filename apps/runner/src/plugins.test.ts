import { expect, test, vi } from "vitest";
import { PluginOperation, PluginSource } from "@dispand/runner-protocol";
import { NativePlugins } from "./plugins.ts";

const add = { action: "add", name: "demo", plugin: "demo", source: "https://example.com/team/plugins.git", sourceRef: "v1", targets: ["claude-code", "codex"], dryRun: false, revision: "preview123" } as const;

test("native install uses Skillshare global scope, account targets and reviewed revision, once", async () => {
  const exec = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ results: [{ name: "demo", target: "claude-work", status: "installed" }, { name: "demo", target: "codex", status: "failed", message: "credential-value /private/path" }] }), failed: true });
  const env = { PATH: "/bin", CLAUDE_CONFIG_DIR: "/private/account" };
  const plugins = new NativePlugins({ "claude-code": "claude-work", codex: "codex" }, env, exec);
  const report = await plugins.request(PluginOperation.parse(add));
  expect(exec).toHaveBeenCalledExactlyOnceWith(["plugin", "add", "--global", "--json", "--no-tui", add.source, "--source-ref", "v1", "--name", "demo", "--plugin", "demo", "--target", "claude-work", "--target", "codex", "--revision", "preview123"], env);
  expect(report.results).toEqual([{ name: "demo", harness: "claude-code", status: "installed" }, { name: "demo", harness: "codex", status: "failed" }]);
  expect(report.error).toContain("failure");
  expect(JSON.stringify(report)).not.toContain("credential-value");
});

test("inventory checks bindings against actual native installed and enabled state", async () => {
  const exec = vi.fn().mockResolvedValue({ failed: false, stdout: JSON.stringify({
    targetDefinitions: [{ target: "claude-work", operations: ["add", "remove"] }, { target: "codex", operations: ["add"] }],
    packages: { demo: { source: "/private/source", bindings: { "claude-work": { id: "demo@market" }, codex: { id: "missing", pending: "install" } } } },
    hosts: [{ target: "claude-work", status: "ready", installed: [{ id: "demo@market", installed: true, enabledKnown: true, enabled: false }] }, { target: "codex", status: "missing", installed: [] }],
  }) });
  const report = await new NativePlugins({ "claude-code": "claude-work", codex: "codex" }, {}, exec).request({ action: "list" });
  expect(report).toEqual({ targets: [{ harness: "claude-code", available: true, add: true, remove: true }, { harness: "codex", available: false, add: true, remove: false }], packages: [{ name: "demo", harness: "claude-code", installed: true, enabled: false, pending: false }, { name: "demo", harness: "codex", installed: false, enabled: null, pending: true }] });
});

test("disabled or unauthorized native targets start no process", async () => {
  const exec = vi.fn();
  expect((await new NativePlugins({}, {}, exec).request({ action: "list" })).error).toContain("disabled");
  expect((await new NativePlugins({ codex: "codex" }, {}, exec).request(PluginOperation.parse(add))).error).toContain("authorized");
  expect(exec).not.toHaveBeenCalled();
});

test("source discovery maps formats to account harnesses and discards private paths", async () => {
  const exec = vi.fn().mockResolvedValue({ failed: false, stdout: JSON.stringify({ candidates: [{ name: "demo", targets: ["claude", "codex", "kimi"], path: "/private/path" }] }) });
  expect(await new NativePlugins({ "claude-code": "claude-work" }, {}, exec).request({ action: "discover", source: add.source })).toEqual({ candidates: [{ name: "demo", targets: ["claude-code"], blocked: false }] });
});

test("removal is target-scoped and previewed; never removes workspace data", async () => {
  const exec = vi.fn().mockResolvedValue({ failed: false, stdout: JSON.stringify({ revision: "rev", blocked: false, changes: [{ name: "demo", target: "codex", action: "remove", binding: { source: "/private" } }] }) });
  const report = await new NativePlugins({ codex: "codex" }, {}, exec).request({ action: "remove", name: "demo", targets: ["codex"], dryRun: true });
  expect(report).toEqual({ revision: "rev", blocked: false, changes: [{ name: "demo", harness: "codex", action: "remove" }] });
  expect(exec.mock.calls[0]![0]).toEqual(["plugin", "remove", "--global", "--json", "--no-tui", "demo", "--target", "codex", "--dry-run"]);
});

test("missing CLI and invalid JSON fail explicitly without retry", async () => {
  const exec = vi.fn().mockResolvedValue({ failed: true, stdout: "secret native error" });
  const report = await new NativePlugins({ codex: "codex" }, {}, exec).request({ action: "list" });
  expect(report.error).toContain("could not complete");
  expect(JSON.stringify(report)).not.toContain("secret native error");
  expect(exec).toHaveBeenCalledTimes(1);
});

test("concurrent native operations are refused", async () => {
  let finish!: (v: { stdout: string; failed: boolean }) => void;
  const exec = vi.fn(() => new Promise<{ stdout: string; failed: boolean }>((resolve) => { finish = resolve; }));
  const plugins = new NativePlugins({ codex: "codex" }, {}, exec);
  const first = plugins.request({ action: "list" });
  expect((await plugins.request({ action: "list" })).error).toContain("busy");
  finish({ stdout: "{}", failed: true });
  await first;
  expect(exec).toHaveBeenCalledTimes(1);
});

test("protocol refuses local sources, credentials, duplicate targets and unreviewed apply", () => {
  for (const source of ["/tmp/plugin", "file:///tmp/plugin", "https://user:secret@example.com/p", "https://example.com/p?token=secret"]) expect(PluginSource.safeParse(source).success).toBe(false);
  expect(PluginOperation.safeParse({ ...add, name: "team.review", plugin: "team.review" }).success).toBe(true);
  expect(PluginOperation.safeParse({ ...add, revision: undefined }).success).toBe(false);
  expect(PluginOperation.safeParse({ ...add, targets: ["codex", "codex"] }).success).toBe(false);
});

test("relative local config paths resolve before Skillshare changes directory", async () => {
  const exec = vi.fn().mockResolvedValue({ stdout: "{}", failed: true });
  await new NativePlugins({ codex: "codex" }, { SKILLSHARE_CONFIG: "private/config.yaml" }, exec).request({ action: "list" });
  expect(exec.mock.calls[0]![1].SKILLSHARE_CONFIG).toBe(`${process.cwd()}/private/config.yaml`);
});

test("Claude registrations are installed without the Codex installed flag", async () => {
  for (const installed of [undefined, false]) {
    const exec = vi.fn().mockResolvedValue({ failed: false, stdout: JSON.stringify({
      targetDefinitions: [], packages: { demo: { bindings: { claude: { id: "demo@market" } } } },
      hosts: [{ target: "claude", status: "ready", installed: [{ id: "demo@market", installed, enabledKnown: true, enabled: true }] }],
    }) });
    const report = await new NativePlugins({ "claude-code": "claude" }, {}, exec).request({ action: "list" });
    expect(report.packages).toEqual([expect.objectContaining({ installed: true, enabled: true })]);
  }
});
