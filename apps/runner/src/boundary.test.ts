import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, expect, test } from "vitest";
import { createServer } from "node:net";
import { codexDenied, codexDeniedEdit, permissionBoundary, sandboxDenied, TOOL_SHAPES } from "./boundary.ts";

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A project with a session working directory inside it, a home, and a directory outside both. */
async function setup() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "boundary-")));
  made.push(base);
  const project = join(base, "project");
  const work = join(project, "work");
  const home = join(base, "home");
  const outside = join(base, "outside");
  for (const dir of [join(work, ".claude"), join(project, ".claude"), join(home, ".claude"), join(home, ".config", "dispand-runner"), outside]) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(join(work, "notes.md"), "");
  return { base, project, work, home, outside, boundary: permissionBoundary(work, home, {}) };
}

const write = (file_path: string) => ["Write", { file_path, content: "x" }] as const;

test("edits inside the working directory are left to the usual permissions", async () => {
  const { work, boundary } = await setup();
  for (const target of [join(work, "notes.md"), join(work, "src", "new", "a.ts"), "relative.txt"]) {
    expect(boundary.deniedEdit(...write(target)), target).toBe(false);
  }
  expect(boundary.deniedEdit("NotebookEdit", { notebook_path: join(work, "n.ipynb"), new_source: "" })).toBe(false);
  expect(boundary.deniedEdit("Bash", { command: "echo hi > /etc/x" })).toBe(false);
});

test("edits outside the working directory are denied", async () => {
  const { project, home, boundary } = await setup();
  for (const target of [
    join(project, ".claude", "settings.local.json"),
    join(home, ".claude", "settings.json"),
    join(home, ".claude.json"),
    join(home, ".config", "dispand-runner", "config.json"),
    "/etc/passwd",
    "../outside.txt",
  ]) {
    expect(boundary.deniedEdit(...write(target)), target).toBe(true);
  }
});

test("its .claude/ and .mcp.json are denied", async () => {
  const { work, boundary } = await setup();
  for (const target of [".claude/settings.json", ".claude/hooks/pre.sh", ".claude/agents/a.md", ".mcp.json", join(work, ".claude")]) {
    expect(boundary.deniedEdit(...write(target)), target).toBe(true);
  }
  // No path to decide on: the owner decides.
  expect(boundary.editDecision("Edit", { old_string: "a", new_string: "b" })).toBe("ask");
});

test("a symlink in the working directory pointing outside is denied, dangling or not", async () => {
  const { work, home, outside, boundary } = await setup();
  await symlink(join(home, ".claude", "settings.json"), join(work, "innocent.json"));
  await symlink(outside, join(work, "out"));
  expect(boundary.deniedEdit(...write(join(work, "innocent.json")))).toBe(true);
  expect(boundary.deniedEdit(...write(join(work, "out", "new.txt")))).toBe(true);
});

test("a symlink inside .claude pointing to a working-directory file denies that file, transitively", async () => {
  const { work, boundary } = await setup();
  await mkdir(join(work, ".claude", "hooks"));
  await writeFile(join(work, "pre.sh"), "");
  await symlink(join(work, "pre.sh"), join(work, ".claude", "hooks", "pre.sh"));
  // .claude/shared -> work/shared, whose lib -> work/lib
  await mkdir(join(work, "shared"));
  await mkdir(join(work, "lib"));
  await symlink(join(work, "shared"), join(work, ".claude", "shared"));
  await symlink(join(work, "lib"), join(work, "shared", "lib"));
  await symlink(join(work, "mcp-real.json"), join(work, ".mcp.json"));
  for (const target of ["pre.sh", "shared/a.sh", "lib/util.sh", "mcp-real.json"]) {
    expect(boundary.deniedEdit(...write(join(work, target))), target).toBe(true);
  }
  expect(boundary.deniedEdit(...write(join(work, "notes.md")))).toBe(false);
});

test("a .claude that is itself a symlink inside the working directory protects its target", async () => {
  const { work } = await setup();
  await rm(join(work, ".claude"), { recursive: true });
  await mkdir(join(work, "conf"));
  await symlink(join(work, "conf"), join(work, ".claude"));
  expect(permissionBoundary(work, "/nonexistent-home", {}).deniedEdit(...write(join(work, "conf", "settings.json")))).toBe(true);
});

test("a cycle ends the walk; a symlink made mid-session counts at the next call", async () => {
  const { work, boundary } = await setup();
  await mkdir(join(work, ".claude", "a"));
  await symlink(join(work, ".claude"), join(work, ".claude", "a", "up"));
  expect(boundary.deniedEdit(...write(join(work, "notes.md")))).toBe(false);
  await symlink(join(work, "notes.md"), join(work, ".claude", "a", "notes"));
  expect(boundary.deniedEdit(...write(join(work, "notes.md")))).toBe(true);
});

test("a .claude too big to walk denies every edit", async () => {
  const { work, boundary } = await setup();
  for (let i = 0; i < 1100; i++) await writeFile(join(work, ".claude", `f${i}`), "");
  expect(boundary.deniedEdit(...write(join(work, "notes.md")))).toBe(true);
});

test(".claude/ and .mcp.json are protected at any depth, with their symlinks", async () => {
  const { work, boundary } = await setup();
  await mkdir(join(work, "sub", ".claude", "hooks"), { recursive: true });
  await mkdir(join(work, "scripts"));
  await writeFile(join(work, "scripts", "a.sh"), "");
  await symlink(join(work, "scripts", "a.sh"), join(work, "sub", ".claude", "hooks", "a.sh"));
  for (const target of ["sub/.claude/hooks/x", "sub/.claude/settings.json", "deep/er/.mcp.json", "scripts/a.sh"]) {
    expect(boundary.deniedEdit(...write(join(work, target))), target).toBe(true);
  }
  expect(boundary.deniedEdit(...write(join(work, "scripts", "b.sh")))).toBe(false);
});

test("files the CLI user config links to are protected: hooks and settings in ~/.claude or CLAUDE_CONFIG_DIR, ~/.claude.json", async () => {
  const { base, work, home } = await setup();
  await mkdir(join(work, "scripts"));
  await mkdir(join(home, ".claude", "hooks"));
  await symlink(join(work, "scripts", "pre.sh"), join(home, ".claude", "hooks", "pre.sh"));
  await symlink(join(work, "policy.json"), join(home, ".claude", "settings.local.json"));
  await symlink(join(work, "global.json"), join(home, ".claude.json"));
  const boundary = permissionBoundary(work, home, {});
  for (const target of ["scripts/pre.sh", "policy.json", "global.json"]) {
    expect(boundary.deniedEdit(...write(join(work, target))), target).toBe(true);
  }
  expect(boundary.deniedEdit(...write(join(work, "scripts", "other.sh")))).toBe(false);
  // With CLAUDE_CONFIG_DIR, that is the user config dir.
  const config = join(base, "claude-config");
  await mkdir(join(config, "hooks"), { recursive: true });
  await symlink(join(work, "scripts", "cc.sh"), join(config, "hooks", "cc.sh"));
  expect(permissionBoundary(work, home, { CLAUDE_CONFIG_DIR: config }).deniedEdit(...write(join(work, "scripts", "cc.sh")))).toBe(true);
});

test("dependency and git trees are not searched; a working tree too big to search denies every edit", async () => {
  const { work, boundary } = await setup();
  for (let i = 0; i < 50; i++) await mkdir(join(work, "node_modules", `p${i}`, "lib"), { recursive: true });
  expect(boundary.deniedEdit(...write(join(work, "notes.md")))).toBe(false);
  for (let i = 0; i < 10_100; i++) await mkdir(join(work, "many", `d${i}`), { recursive: true });
  expect(boundary.deniedEdit(...write(join(work, "notes.md")))).toBe(true);
});

test("settings back the hook up: deny rules, writes kept in the working directories, bypass off unless allowed", async () => {
  const { work, boundary } = await setup();
  const locked = boundary.settings(false).permissions;
  expect(locked.deny).toContain(`Write(/${work}/.claude/**)`);
  expect(locked.deny).toContain(`Edit(/${work}/.mcp.json)`);
  expect(locked.blockWritesOutsideWorkingDirectories).toBe(true);
  expect(locked.disableBypassPermissionsMode).toBe("disable");
  expect(boundary.settings(true).permissions.disableBypassPermissionsMode).toBeUndefined();
});

test("always-allow keeps permission updates to this session only", () => {
  const boundary = permissionBoundary("/work");
  const rules = [{ toolName: "Bash", ruleContent: "ls" }];
  const suggestions: PermissionUpdate[] = [
    { type: "addRules", rules, behavior: "allow", destination: "localSettings" },
    { type: "addRules", rules, behavior: "allow", destination: "userSettings" },
    { type: "setMode", mode: "acceptEdits", destination: "localSettings" },
    // Could lift a deny rule, widen the working directories, or turn every prompt off: never passed on.
    { type: "addDirectories", directories: ["/srv/data"], destination: "projectSettings" },
    { type: "removeRules", rules, behavior: "deny", destination: "session" },
    { type: "replaceRules", rules, behavior: "deny", destination: "localSettings" },
    { type: "setMode", mode: "bypassPermissions", destination: "session" },
  ];
  expect(boundary.sessionUpdates(suggestions)).toEqual([
    { type: "addRules", rules, behavior: "allow", destination: "session" },
    { type: "addRules", rules, behavior: "allow", destination: "session" },
    { type: "setMode", mode: "acceptEdits", destination: "session" },
  ]);
});

test("file tools read only inside the session folder, and the CLI's plugin code and skills/", async () => {
  const { base, work, home } = await setup();
  const claude = join(home, ".claude");
  const skill = join(claude, "plugins", "cache", "official", "superpowers", "7.0.0", "skills", "brainstorming");
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "visual-companion.md"), "");
  await mkdir(join(claude, "skills", "mine"), { recursive: true });
  await writeFile(join(claude, ".credentials.json"), "{}");
  await symlink(join(claude, ".credentials.json"), join(work, "creds"));
  const b = permissionBoundary(work, home, {});
  const decide = (tool: string, input: Record<string, unknown>) => b.readDecision(tool, input);
  for (const [tool, input] of [
    ["Read", { file_path: join(claude, ".credentials.json") }],
    ["Read", { file_path: "~/.claude/.credentials.json" }],
    ["Read", { file_path: join(work, "creds") }],
    ["Read", { file_path: join(home, ".codex", "auth.json") }],
    ["Read", { file_path: join(home, ".claude.json") }],
    ["Read", { file_path: join(claude, "settings.json") }],
    ["Read", { file_path: "../outside.txt" }],
    ["Grep", { pattern: "token", path: "~/.claude" }],
    ["Grep", { pattern: "token", glob: "/home/*/.claude/*.json" }],
    ["Glob", { pattern: `${claude}/*.json` }],
    ["Glob", { pattern: "~/.claude/**" }],
    ["Glob", { pattern: "../../**/*.json" }],
    ["NotebookRead", { notebook_path: "/etc/passwd" }],
    // Plugins' own state, not their code.
    ["Read", { file_path: join(claude, "plugins", "data", "x") }],
    ["Read", { file_path: join(claude, "plugins", "store", "x") }],
    ["Read", { file_path: join(claude, "plugins", "installed_plugins.json") }],
  ] as const) {
    expect(decide(tool, input), `${tool} ${JSON.stringify(input)}`).toBe("deny");
  }
  for (const [tool, input] of [
    ["Read", { file_path: join(work, "notes.md") }],
    ["Read", { file_path: "notes.md" }],
    ["Read", { file_path: join(skill, "visual-companion.md") }],
    ["Read", { file_path: join(claude, "skills", "mine", "SKILL.md") }],
    ["Read", { file_path: join(claude, "plugins", "marketplaces", "m", "plugin", "skills", "s", "SKILL.md") }],
    ["Grep", { pattern: "x" }],
    ["Grep", { pattern: "x", path: "src", glob: "*.ts" }],
    ["Glob", { pattern: "**/*.ts" }],
    ["Glob", { pattern: "src/**/*.md", path: work }],
  ] as const) {
    expect(decide(tool, input), `${tool} ${JSON.stringify(input)}`).toBe("allow");
  }
  // Shapes the runner can't follow go to the owner.
  for (const [tool, input] of [
    ["Read", { file_path: 42 }],
    // LSP follows imports anywhere: always the owner's call, even in the folder.
    ["LSP", { operation: "hover", filePath: "src/a.ts", line: 1, character: 1 }],
    ["LSP", { operation: "hover", filePath: join(claude, ".credentials.json"), line: 1, character: 1 }],
    ["Glob", { pattern: "{src,/etc}/*" }],
    ["Glob", { pattern: "src/**/../../x" }],
  ] as const) {
    expect(decide(tool, input), `${tool} ${JSON.stringify(input)}`).toBe("ask");
  }
  expect(decide("Bash", { command: "cat ~/.claude/.credentials.json" })).toBe("n/a");
  expect(decide("Write", { file_path: join(work, "x") })).toBe("n/a");
  // CLAUDE_CONFIG_DIR is the CLI's user config dir when set.
  const cc = join(base, "cc");
  await mkdir(join(cc, "skills", "s"), { recursive: true });
  const withDir = permissionBoundary(work, home, { CLAUDE_CONFIG_DIR: cc });
  expect(withDir.readDecision("Read", { file_path: join(cc, "skills", "s", "ref.md") })).toBe("allow");
  expect(withDir.readDecision("Read", { file_path: join(cc, ".credentials.json") })).toBe("deny");
  expect(withDir.readDecision("Read", { file_path: join(skill, "visual-companion.md") })).toBe("deny");
});

test("a path that isn't canonical is never decided silently: the owner is asked", async () => {
  const { work, home } = await setup();
  const b = permissionBoundary(work, home, {});
  const odd = [" ~/.ssh/id_ed25519", "~/.ssh/id_ed25519 ", "notes.md\t", "~root/.ssh/id_rsa", "a/../b", "./x", "//x", `${work}/./x`, `${work}//x`, "a\u0000b", "src/\u001bx", "."];
  for (const p of odd) {
    expect(b.readDecision("Read", { file_path: p }), `read ${JSON.stringify(p)}`).toBe("ask");
    expect(b.editDecision("Write", { file_path: p, content: "" }), `edit ${JSON.stringify(p)}`).toBe("ask");
  }
  expect(b.readDecision("Grep", { pattern: "x", path: " ~/.ssh" })).toBe("ask");
  expect(b.readDecision("Glob", { pattern: " ~/.ssh/*" })).toBe("ask");
  expect(b.readDecision("LSP", { operation: "hover", filePath: "~nobody/x", line: 1, character: 1 })).toBe("ask");
  // Canonical paths keep their decisions.
  expect(b.readDecision("Read", { file_path: "notes.md" })).toBe("allow");
  expect(b.readDecision("Read", { file_path: join(work, "src", "a~b.ts") })).toBe("allow");
  expect(b.readDecision("Read", { file_path: "~/.ssh/id_ed25519" })).toBe("deny");
  expect(b.editDecision("Write", { file_path: "notes.md", content: "" })).toBe("allow");
  expect(b.editDecision("Write", { file_path: ".claude/settings.json", content: "" })).toBe("deny");
  expect(b.editDecision("Bash", { command: "ls" })).toBe("n/a");
});

test("one resolver for every tool: equivalent spellings of a path get the same decision, reads and edits alike", async () => {
  const { work, home } = await setup();
  await mkdir(join(home, "private"), { recursive: true });
  const b = permissionBoundary(work, home, {});
  const decide = (tool: string, input: Record<string, unknown>) =>
    TOOL_SHAPES[tool]!.kind === "edit" ? b.editDecision(tool, input) : b.readDecision(tool, input);
  for (const [tool, shape] of Object.entries(TOOL_SHAPES)) {
    const at = (p: string) => ({ [shape.path]: p, ...(shape.pattern ? { [shape.pattern]: "*" } : {}) });
    // Outside: "~/…" is home, for every tool.
    expect(decide(tool, at("~/private/x.ipynb")), tool).toBe("deny");
    expect(decide(tool, at(join(home, "private", "x.ipynb"))), tool).toBe("deny");
    // Inside: relative and absolute agree.
    expect(decide(tool, at("notes.md")), tool).toBe(decide(tool, at(join(work, "notes.md"))));
    expect(decide(tool, at("notes.md")), tool).toBe("allow");
    // Not plain: asked, whatever the tool.
    expect(decide(tool, at(" ~/private/x")), tool).toBe("ask");
    expect(decide(tool, { [shape.path]: 7 }), tool).toBe("ask");
  }
  expect(b.editDecision("NotebookEdit", { notebook_path: "~/private/x.ipynb", new_source: "" })).toBe("deny");
});

test("relative paths resolve against the CLI's current directory, which must be inside the folder", async () => {
  const { work, home, outside } = await setup();
  await writeFile(join(home, ".claude", ".credentials.json"), "{}");
  const repo = join(work, "repo");
  await mkdir(repo);
  await writeFile(join(repo, "notes.md"), "");
  await symlink(join(home, ".claude", ".credentials.json"), join(repo, "leak"));
  const b = permissionBoundary(work, home, {});
  // After `cd repo`: "leak" is repo/leak, a link to the credentials.
  expect(b.readDecision("Grep", { pattern: "x", path: "leak" }, repo)).toBe("deny");
  expect(b.readDecision("Read", { file_path: "leak" }, repo)).toBe("deny");
  expect(b.readDecision("Read", { file_path: "notes.md" }, repo)).toBe("allow");
  expect(b.editDecision("Write", { file_path: "leak", content: "" }, repo)).toBe("deny");
  expect(b.editDecision("Write", { file_path: "new.md", content: "" }, repo)).toBe("allow");
  // A current directory outside the folder, or not plain: asked.
  expect(b.readDecision("Read", { file_path: "notes.md" }, outside)).toBe("ask");
  expect(b.readDecision("Read", { file_path: "notes.md" }, `${repo}/../repo`)).toBe("ask");
  expect(b.readDecision("Read", { file_path: "notes.md" }, "repo")).toBe("ask");
  // Unknown (canUseTool): relative paths are asked, absolute ones still decided.
  expect(b.readDecision("Read", { file_path: "notes.md" }, null)).toBe("ask");
  expect(b.readDecision("Grep", { pattern: "x" }, null)).toBe("ask");
  expect(b.editDecision("Write", { file_path: "new.md", content: "" }, null)).toBe("ask");
  expect(b.readDecision("Read", { file_path: join(repo, "notes.md") }, null)).toBe("allow");
  expect(b.readDecision("Read", { file_path: join(home, ".claude", ".credentials.json") }, null)).toBe("deny");
});

test("Codex file changes stay in the session folder, out of its Codex config and the machine's config", async () => {
  const { work, home, outside } = await setup();
  const secrets = [join(home, ".codex"), join(work, "linked-secret")];
  await symlink(join(home, ".codex"), join(work, "linked-secret"));
  await symlink(outside, join(work, "out"));
  expect(codexDeniedEdit(work, join(work, "notes.md"), secrets)).toBe(false);
  expect(codexDeniedEdit(work, "sub/new.md", secrets)).toBe(false);
  for (const path of [
    join(outside, "x"),
    "../x",
    join(work, "out", "x"),
    join(work, ".codex", "config.toml"),
    join(work, "sub", ".agents", "skills", "x", "SKILL.md"),
    join(work, "AGENTS.md"),
    join(work, "sub", "AGENTS.override.md"),
    join(work, "linked-secret", "auth.json"),
  ]) {
    expect(codexDeniedEdit(work, path, secrets), path).toBe(true);
  }
});

test("a Codex session is denied the machine's config, and wherever symlinks inside it lead, transitively", async () => {
  const { home, outside } = await setup();
  await mkdir(join(home, ".codex"));
  await mkdir(join(outside, "vault"));
  await writeFile(join(outside, "vault", "auth.json"), "{}");
  await writeFile(join(outside, "token"), "");
  await symlink(join(outside, "vault"), join(home, ".codex", "keys"));
  await symlink(join(outside, "token"), join(outside, "vault", "next"));
  // A cycle back into the tree ends the walk.
  await symlink(join(home, ".codex"), join(outside, "vault", "loop"));
  const denied = codexDenied([join(home, ".codex")]);
  expect(denied).toEqual(expect.arrayContaining([join(home, ".codex"), join(outside, "vault"), join(outside, "token")]));
  expect(denied).not.toContain(outside);
});

test("what the sandbox is asked to hide is only what it can hide: no entry inside another, no socket, never the Codex binary", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "sandbox-denied-")));
  made.push(base);
  const home = join(base, "home");
  const outside = join(base, "outside");
  await mkdir(join(home, ".codex", "releases", "1.0"), { recursive: true });
  await mkdir(join(home, ".codex", "tmp", "arg0"), { recursive: true });
  await mkdir(join(outside, "bin"), { recursive: true });
  await mkdir(join(outside, "vault"));
  await writeFile(join(outside, "vault", "auth.json"), "{}");
  await writeFile(join(outside, "bin", "codex"), "");
  // A link back into the home, a socket elsewhere linked from the home, and the running Codex's link to its own binary.
  await symlink(join(home, ".codex", "releases", "1.0"), join(home, ".codex", "current"));
  const socket = join(outside, "daemon.sock");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  await symlink(socket, join(home, ".codex", "control.sock"));
  await symlink(join(outside, "bin", "codex"), join(home, ".codex", "tmp", "arg0", "codex-linux-sandbox"));
  // A credential kept outside the home stays hidden.
  await symlink(join(outside, "vault"), join(home, ".codex", "keys"));
  try {
    const denied = codexDenied([join(home, ".codex"), join(base, "missing-config")]);
    // The full list still names everything: file changes are checked against it.
    expect(denied).toEqual(expect.arrayContaining([socket, join(outside, "bin", "codex"), join(home, ".codex", "releases", "1.0")]));
    const hidden = sandboxDenied(denied, join(outside, "bin", "codex"));
    expect(hidden.sort()).toEqual([join(base, "missing-config"), join(home, ".codex"), join(outside, "vault")].sort());
    // Whatever the binary's own path is given as (a link to it too).
    await symlink(join(outside, "bin", "codex"), join(base, "codex-link"));
    expect(sandboxDenied(denied, join(base, "codex-link")).sort()).toEqual(hidden.sort());
    // Another binary than the one in the list changes nothing.
    expect(sandboxDenied(denied, "/usr/bin/true")).toEqual(expect.arrayContaining([join(outside, "bin", "codex")]));
    for (const a of hidden) for (const b of hidden) if (a !== b) expect(a.startsWith(`${b}/`), `${a} inside ${b}`).toBe(false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
