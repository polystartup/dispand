import { expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { PluginOperation, PluginSource, workspacePluginContent } from "@dispand/runner-protocol";
import { NativePlugins, skillshareExec } from "./plugins.ts";
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
    if (!contextChanged) exec.mockResolvedValueOnce({ failed: false, stdout: JSON.stringify({ candidates: [{ name: "review", path: ".", targets: ["codex"] }] }) });
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

test("filtered native registrations cannot replace an entire workspace package", async () => {
  for (const filtered of [false, true]) {
    const exec = vi.fn().mockImplementation(async (args: string[]) => ({ failed: false, stdout: JSON.stringify(args[1] === "discover" ? { candidates: [{ name: "review", path: ".", targets: ["codex"] }] } : {
      targetDefinitions: [],
      packages: { review: { bindings: { codex: { id: "review@market", source: "https://example.com/review.git", commit: "a".repeat(40), plugin: "review" } } } },
      hosts: [{ target: "codex", status: "ready", installed: [{ id: "review@market", installed: true, enabledKnown: true, enabled: true, filtered }] }],
    }) }));
    const report = await new NativePlugins({ codex: "codex" }, {}, exec).request({ action: "list" });
    if (filtered) expect(report.packages![0]!.sourceKey).toBeUndefined();
    else expect(report.packages![0]!.sourceKey).toBe(createHash("sha256").update(JSON.stringify(["https://example.com/review", "a".repeat(40), "review"])).digest("hex"));
  }
});


test("subfolder installs verify the pinned Skillshare selection for every target", async () => {
  const operation = { ...add, sourceRef: "a".repeat(40), sourcePath: "plugin" };
  const discovery: { candidates: { name: string; path: string; targets: string[]; targetInfo: Record<string, { path: string }>; problem?: string }[] } = { candidates: [{ name: "demo", path: "plugin", targets: ["claude", "codex"], targetInfo: {} }] };
  const exec = vi.fn().mockImplementation(async (args: string[]) => ({ failed: false, stdout: JSON.stringify(args[1] === "discover" ? discovery : { results: [] }) }));
  const targets = { "claude-code": "claude", codex: "codex" };
  expect(await new NativePlugins(targets, {}, exec).request(PluginOperation.parse(operation))).toEqual({ results: [] });
  expect(exec.mock.calls[0]![0]).toEqual(["plugin", "discover", "--global", "--json", "--no-tui", add.source, "--source-ref", operation.sourceRef]);
  expect(exec.mock.calls[1]![0]).toContain("--plugin");
  expect(exec.mock.calls[1]![0]).not.toContain("--source-path");
  for (const candidate of [
    { ...discovery.candidates[0]!, path: "." },
    { ...discovery.candidates[0]!, targetInfo: { codex: { path: "other" } } },
    { ...discovery.candidates[0]!, problem: "private native error" },
    { ...discovery.candidates[0]!, targets: ["claude"] },
  ]) {
    exec.mockClear();
    discovery.candidates = [candidate];
    const report = await new NativePlugins(targets, {}, exec).request(PluginOperation.parse(operation));
    expect(report.error).toContain("folder");
    expect(JSON.stringify(report)).not.toContain("private native error");
    expect(exec).toHaveBeenCalledTimes(1);
  }
});

test("subfolder identities match only the folder selected for the installed harness", async () => {
  const source = add.source;
  const commit = "a".repeat(40);
  const discovery = { candidates: [{ name: "demo", path: "plugin", targets: ["claude", "codex"], targetInfo: { codex: { path: "codex-plugin" } } }] };
  const inventory = { packages: { demo: { bindings: { claude: { id: "demo@native", source, commit, plugin: "demo" }, codex: { id: "demo@native", source, commit, plugin: "demo" } } } }, hosts: ["claude", "codex"].map((target) => ({ target, status: "ready", installed: [{ id: "demo@native", installed: true, enabledKnown: true, enabled: true }] })) };
  const exec = vi.fn().mockImplementation(async (args: string[]) => ({ failed: false, stdout: JSON.stringify(args[1] === "discover" ? discovery : inventory) }));
  const report = await new NativePlugins({ "claude-code": "claude", codex: "codex" }, {}, exec).request({ action: "list" });
  for (const [index, path] of ["plugin", "codex-plugin"].entries()) {
    expect(report.packages?.[index]?.sourceKey).toBe(createHash("sha256").update(JSON.stringify([source.replace(/\.git$/, ""), commit, "demo", path])).digest("hex"));
  }
  expect(exec).toHaveBeenCalledTimes(2);
});

test("subfolder requests require a safe relative folder and an immutable commit", () => {
  for (const sourcePath of ["/private", "../other", "plugin/../other", "plugin\\other", ""]) {
    expect(PluginOperation.safeParse({ ...add, sourceRef: "a".repeat(40), sourcePath }).success).toBe(false);
  }
  expect(PluginOperation.safeParse({ ...add, sourcePath: "plugin" }).success).toBe(false);
});


test("failed source discovery leaves native inventory readable without claiming a source match", async () => {
  const exec = vi.fn().mockResolvedValueOnce({ failed: false, stdout: JSON.stringify({ packages: { demo: { bindings: { codex: { id: "demo@native", source: add.source, commit: "a".repeat(40), plugin: "demo" } } } }, hosts: [{ target: "codex", status: "ready", installed: [{ id: "demo@native", installed: true, enabledKnown: true, enabled: true }] }] }) }).mockResolvedValueOnce({ failed: true, stdout: "private failure" });
  const report = await new NativePlugins({ codex: "codex" }, {}, exec).request({ action: "list" });
  expect(report.packages?.[0]).toMatchObject({ installed: true, enabled: true });
  expect(report.packages?.[0]?.sourceKey).toBeUndefined();
  expect(JSON.stringify(report)).not.toContain("private failure");
});


test("inventory shares a discovery deadline and deduplicates failures across harnesses", async () => {
  const controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  const inventory = { packages: { demo: { bindings: Object.fromEntries(["claude", "codex"].map((target) => [target, { id: "demo@native", source: add.source, commit: "a".repeat(40), plugin: "demo" }])) } }, hosts: [] };
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const exec = vi.fn().mockImplementation(async (args: string[], _env, signal?: AbortSignal) => {
    if (args[1] === "list") return { failed: false, stdout: JSON.stringify(inventory) };
    started();
    if (!signal) return { failed: true, stdout: "" };
    return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ failed: true, stdout: "" }), { once: true }));
  });
  try {
    const pending = new NativePlugins({ "claude-code": "claude", codex: "codex" }, {}, exec).request({ action: "list" });
    await ready;
    controller.abort();
    const report = await pending;
    expect(report.error).toBeUndefined();
    expect(report.packages).toHaveLength(2);
    expect(report.packages!.every((pkg) => pkg.sourceKey === undefined)).toBe(true);
    expect(exec).toHaveBeenCalledTimes(2);
  } finally { timeout.mockRestore(); }
});


test("discovery cancellation stops its native process group", async () => {
  const controller = new AbortController();
  const exec = skillshareExec("/bin/sh");
  const pending = exec(["-c", "sleep 60"], process.env, controller.signal);
  controller.abort();
  expect(await pending).toEqual({ failed: true, stdout: "" });
  expect(await exec(["-c", "sleep 60"], process.env, controller.signal)).toEqual({ failed: true, stdout: "" });
});
