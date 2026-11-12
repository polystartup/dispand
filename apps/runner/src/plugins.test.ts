import { expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { PluginOperation, PluginSource, workspacePluginContent } from "@dispand/runner-protocol";
import { NativePlugins } from "./plugins.ts";
import { fallbackPackages } from "./native-skills.ts";
import { unlock } from "./skills.ts";

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

test("workspace skills use a persistent content-addressed Skillshare source and match only its exact native content", async () => {
  const state = await mkdtemp(join(tmpdir(), "dispand-native-test-"));
  try {
    const files = [{ path: "writing/SKILL.md", base64: Buffer.from("---\nname: writing\ndescription: Clear writing\nallowed-tools: Bash\n---\n\nWrite clearly.\n").toString("base64") }];
    const digest = createHash("sha256").update(workspacePluginContent(files)).digest("hex");
    const root = join(state, "dispand-runner", "native-skills", "dispand-skillpkg_1", digest, "dispand-skillpkg-1");
    const exec = vi.fn().mockResolvedValueOnce({ failed: false, stdout: JSON.stringify({ revision: "preview", blocked: false, changes: [] }) })
      .mockResolvedValueOnce({ failed: false, stdout: JSON.stringify({ results: [{ name: "dispand-skillpkg_1", target: "codex", status: "installed" }] }) })
      .mockResolvedValueOnce({ failed: false, stdout: JSON.stringify({ packages: { "dispand-skillpkg_1": { bindings: { codex: { id: "native-id", source: root, plugin: "dispand-skillpkg-1" } } } }, hosts: [{ target: "codex", status: "ready", installed: [{ id: "native-id", installed: true, enabledKnown: true, enabled: true }] }] }) });
    const native = new NativePlugins({ codex: "codex" }, { XDG_STATE_HOME: state }, exec);
    const op = { action: "add-workspace" as const, name: "dispand-skillpkg_1", targets: ["codex" as const], dryRun: true, files };
    expect((await native.request(op)).revision).toBe("preview");
    expect(JSON.parse(await readFile(join(root, ".claude-plugin/plugin.json"), "utf8"))).toEqual({ name: "dispand-skillpkg-1" });
    expect(await readFile(join(root, "skills/writing/SKILL.md"), "utf8")).not.toContain("allowed-tools");
    await native.request({ ...op, dryRun: false, revision: "preview" });
    expect(exec.mock.calls[1]![0]).toEqual(["plugin", "add", "--global", "--json", "--no-tui", root, "--name", "dispand-skillpkg_1", "--plugin", "dispand-skillpkg-1", "--target", "codex", "--revision", "preview"]);
    const report = await native.request({ action: "list" });
    expect(report.packages?.[0]?.sourceKey).toBe(`workspace:${digest}`);
    expect(JSON.stringify(report)).not.toContain(state);
    const pkg = { name: "writing", nativePlugin: "dispand-skillpkg_1", nativeKey: `workspace:${digest}`, files: [] };
    expect(fallbackPackages([pkg], "codex", report)).toEqual([]);
    expect(fallbackPackages([{ ...pkg, nativeKey: "workspace:updated" }], "codex", report)).toHaveLength(1);
  } finally {
    await unlock(state);
    await rm(state, { recursive: true, force: true });
  }
});

test("unsafe workspace packages never reach Skillshare, including settings paths", async () => {
  const state = await mkdtemp(join(tmpdir(), "dispand-native-refuse-"));
  try {
    const exec = vi.fn();
    const native = new NativePlugins({ codex: "codex" }, { XDG_STATE_HOME: state }, exec);
    for (const path of ["../../escape", "writing/.claude/settings.json", "writing/.mcp.json"]) {
      const report = await native.request({ action: "add-workspace", name: "dispand-skillpkg_1", targets: ["codex"], dryRun: true, files: [{ path, base64: "eA==" }] });
      expect(report.error).toBeTruthy();
    }
    expect(exec).not.toHaveBeenCalled();
  } finally { await unlock(state); await rm(state, { recursive: true, force: true }); }
});

test("native source matching uses pinned binding metadata and refuses changed account context", async () => {
  const binding = { id: "review@native", source: "https://example.com/review.git", sourceRef: "main", commit: "a".repeat(40), plugin: "review" };
  const exec = vi.fn();
  const native = new NativePlugins({ codex: "codex" }, {}, exec);
  for (const contextChanged of [false, true]) {
    exec.mockResolvedValueOnce({ failed: false, stdout: JSON.stringify({ packages: { "dispand-plugin_1": { bindings: { codex: { ...binding, contextChanged } } } }, hosts: [{ target: "codex", status: "ready", installed: [{ id: binding.id, installed: true, enabledKnown: true, enabled: true }] }] }) });
    const report = await native.request({ action: "list" });
    expect(report.packages?.[0]).toMatchObject({ name: "dispand-plugin_1", sourceKey: createHash("sha256").update(JSON.stringify(["https://example.com/review", "a".repeat(40), "review"])).digest("hex"), installed: true, enabled: true, pending: contextChanged });
    const packages = [{ name: "review", nativePlugin: "dispand-plugin_1", nativeKey: createHash("sha256").update(JSON.stringify(["https://example.com/review", "a".repeat(40), "review"])).digest("hex"), files: [] }];
    expect(fallbackPackages(packages, "codex", report)).toHaveLength(contextChanged ? 1 : 0);
  }
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
