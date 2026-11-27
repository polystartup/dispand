import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { inEnglish } from "./test-notes.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { say } from "../messages/index.ts";
import { mapSource, type MarketplaceEntry, parseMarketplace } from "./marketplace.ts";
import { readPlugin, resolvePluginRoot } from "./read-plugin.ts";
import { type FixtureFile, skillMd, writeTree } from "./test-support.ts";

function tree(files: Record<string, FixtureFile>): string {
  // A real path, as resolvePluginRoot gives readPlugin: macOS's temp folder is a link.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dispand-plugin-")));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  writeTree(dir, files);
  return dir;
}

const entry = (more: Partial<MarketplaceEntry> = {}): MarketplaceEntry => ({ name: "demo", source: { type: "path", path: "./" }, ...more });

test("a strict:false entry's skills are the folders it lists", async () => {
  const root = tree({
    "skills/pdf/SKILL.md": skillMd("pdf"),
    "skills/pdf/scripts/fill.py": "print(1)\n",
    "skills/docx/SKILL.md": skillMd("docx"),
    "skills/other/SKILL.md": skillMd("other"),
  });
  const got = await readPlugin(root, entry({ skills: ["./skills/pdf", "./skills/docx"] }));
  expect(got.skills.map((s) => [s.name, s.files.map((f) => f.path)])).toEqual([
    ["pdf", ["pdf/SKILL.md", "pdf/scripts/fill.py"]],
    ["docx", ["docx/SKILL.md"]],
  ]);
  expect(got.notImported).toEqual([]);
});

test("without a list, the skills are skills/*; hooks, commands and bin/ are listed as not imported", async () => {
  const root = tree({
    ".claude-plugin/plugin.json": JSON.stringify({ name: "superpowers" }),
    "skills/brainstorming/SKILL.md": skillMd("brainstorming"),
    "skills/tdd/SKILL.md": skillMd("tdd"),
    "hooks/hooks.json": JSON.stringify({ hooks: { SessionStart: [] } }),
    "commands/plan.md": "Plan.",
    "bin/tool": "#!/bin/sh\n",
  });
  const got = await readPlugin(root, entry());
  expect(got.skills.map((s) => s.name)).toEqual(["brainstorming", "tdd"]);
  expect(inEnglish(got.notImported)).toEqual([
    { component: "hook", name: "hooks", reason: "Hooks run commands on the machine" },
    { component: "command", name: "plan", reason: "Commands aren't imported" },
    { component: "bin", name: "bin/", reason: "Runs the plugin's own programs" },
  ]);
});

test("symlinked file is skipped, and so are a linked skill folder and files a skill can't hold", async () => {
  const outside = tree({ "secret/SKILL.md": skillMd("secret") });
  const root = tree({
    "skills/x/SKILL.md": skillMd("x"),
    "skills/x/host": { symlink: "/etc/hostname" },
    "skills/x/.mcp.json": "{}",
    "skills/x/.claude/settings.json": "{}",
    "skills/x/hooks/hooks.json": "{}",
    "skills/linked": { symlink: join(outside, "secret") },
  });
  const got = await readPlugin(root, entry({ skills: ["skills/x", "skills/linked", "../escape"] }));
  expect(got.skills.map((s) => [s.name, s.files.map((f) => f.path)])).toEqual([["x", ["x/SKILL.md", "x/hooks/hooks.json"]]]);
  expect(inEnglish(got.notImported)).toEqual(
    expect.arrayContaining([
      { component: "file", name: "x/host", reason: "A symbolic link" },
      { component: "file", name: "x/.mcp.json", reason: "Its path isn't allowed in a skill" },
      { component: "file", name: "x/.claude", reason: "Its path isn't allowed in a skill" },
      { component: "skill", name: "linked", reason: "Its folder isn't in the plugin (or is a link)" },
      { component: "skill", name: "../escape", reason: "Its folder is outside the plugin" },
    ]),
  );
});

test("the plugin's own folder (`.`) is one skill named by its SKILL.md; links, .git, config paths and large files stay out", async () => {
  const outside = tree({ "secret.md": "secret words", "SKILL.md": skillMd("secret") });
  const root = tree({
    "SKILL.md": skillMd("plain-words"),
    "examples.md": "Short.",
    ".git/config": "[core]",
    host: { symlink: "/etc/hostname" },
    linked: { symlink: outside },
    "notes.md": { symlink: join(outside, "secret.md") },
    ".mcp.json": "{}",
    ".claude/settings.json": "{}",
    "big.bin": "x".repeat(2 * 1024 * 1024 + 1),
  });
  const got = await readPlugin(root, entry({ skills: ["."] }));
  expect(got.skills.map((s) => [s.name, s.files.map((f) => f.path)])).toEqual([["plain-words", ["plain-words/SKILL.md", "plain-words/examples.md"]]]);
  expect(inEnglish(got.notImported)).toEqual(
    expect.arrayContaining([
      { component: "file", name: "plain-words/host", reason: "A symbolic link" },
      { component: "file", name: "plain-words/linked", reason: "A symbolic link" },
      { component: "file", name: "plain-words/notes.md", reason: "A symbolic link" },
      { component: "file", name: "plain-words/.mcp.json", reason: "Its path isn't allowed in a skill" },
      { component: "file", name: "plain-words/.claude", reason: "Its path isn't allowed in a skill" },
      { component: "file", name: "plain-words/big.bin", reason: "Larger than 2 MiB" },
    ]),
  );
  expect(JSON.stringify(got)).not.toContain("secret");
});

test("a root skill whose SKILL.md is a link, or names no skill it can have, isn't read; one with a byte-order mark is", async () => {
  const outside = tree({ "SKILL.md": skillMd("secret") });
  for (const md of [{ symlink: join(outside, "SKILL.md") }, "No frontmatter.", '---\nname: "bad\\0name"\ndescription: x\n---\n'] satisfies FixtureFile[]) {
    const got = await readPlugin(tree({ "SKILL.md": md, "notes.md": "x" }), entry({ skills: ["."] }));
    expect(got.skills).toEqual([]);
    expect(inEnglish(got.notImported)).toContainEqual({ component: "skill", name: ".", reason: "Its name isn't lowercase letters, digits and hyphens" });
  }
  const marked = await readPlugin(tree({ "SKILL.md": `\uFEFF${skillMd("plain-words")}` }), entry({ skills: ["."] }));
  expect(marked.skills.map((s) => s.name)).toEqual(["plain-words"]);
});

test("a skill that doesn't validate is listed with its reason", async () => {
  const root = tree({ "skills/a/SKILL.md": skillMd("b"), "skills/Bad_Name/SKILL.md": skillMd("Bad_Name") });
  expect(inEnglish((await readPlugin(root, entry())).notImported)).toEqual([
    { component: "skill", name: "Bad_Name", reason: "Its name isn't lowercase letters, digits and hyphens" },
    { component: "skill", name: "a", reason: "The frontmatter's name in “a/SKILL.md” must be “a”, its folder." },
  ]);
});

test("a relative source leaving the repo is refused", async () => {
  const root = tree({ "plugins/a/x": "1" });
  expect(await resolvePluginRoot(root, "./plugins/a")).toBe(join(root, "plugins/a"));
  for (const path of ["../x", "plugins/../../x", "/etc", "plugins/a/x"]) await expect(resolvePluginRoot(root, path), path).rejects.toThrow();
  writeTree(root, { "plugins/out": { symlink: "/etc" } });
  await expect(resolvePluginRoot(root, "plugins/out")).rejects.toThrow();
});

test("readPlugin parses .mcp.json servers with their ${VAR} settings and agents/*.md", async () => {
  const root = tree({
    ".mcp.json": JSON.stringify({
      mcpServers: {
        github: { type: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer ${GITHUB_PAT}" } },
        search: { command: "npx", args: ["-y", "brave"], env: { BRAVE_API_KEY: "${BRAVE_API_KEY}" } },
        own: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.js"] },
      },
    }),
    ".claude-plugin/plugin.json": JSON.stringify({ mcpServers: { events: { type: "sse", url: "https://x.example/${TENANT}/sse" } } }),
    "agents/reviewer.md": "---\nname: code-reviewer\ndescription: Reviews code.\ntools: Read, Grep\nmodel: opus\n---\n\nYou review code.\n",
    "agents/plain.md": "Just a prompt.",
  });
  const got = await readPlugin(root, entry());
  expect(got.mcpServers).toEqual([
    {
      name: "github",
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
      transport: "streamable-http",
      headers: { Authorization: "Bearer ${GITHUB_PAT}" },
      settings: ["GITHUB_PAT"],
    },
    { name: "search", type: "stdio", command: "npx", args: ["-y", "brave"], env: { BRAVE_API_KEY: "${BRAVE_API_KEY}" }, settings: ["BRAVE_API_KEY"] },
    { name: "events", type: "http", url: "https://x.example/${TENANT}/sse", transport: "sse", headers: {}, settings: ["TENANT"] },
  ]);
  expect(inEnglish(got.notImported)).toEqual([{ component: "mcp-server", name: "own", reason: "It runs the plugin's own files" }]);
  expect(got.agents).toEqual([
    { name: "plain", description: "", systemPrompt: "Just a prompt." },
    { name: "code-reviewer", description: "Reviews code.", systemPrompt: "You review code." },
  ]);
});

test("marketplace sources map to Git fetches; an npm source is unsupported, with its reason", async () => {
  expect(mapSource("./plugins/a")).toEqual({ type: "path", path: "./plugins/a" });
  expect(mapSource({ source: "github", repo: "obra/superpowers", ref: "v1" })).toEqual({
    type: "git",
    url: "https://github.com/obra/superpowers.git",
    ref: "v1",
  });
  expect(mapSource({ source: "url", url: "https://github.com/obra/superpowers.git", sha: "a".repeat(40) })).toEqual({
    type: "git",
    url: "https://github.com/obra/superpowers.git",
    sha: "a".repeat(40),
  });
  expect(mapSource({ source: "git-subdir", url: "acme/skills", path: "plugins/x", ref: "main" })).toEqual({
    type: "git",
    url: "https://github.com/acme/skills.git",
    path: "plugins/x",
    ref: "main",
  });
  expect(mapSource({ source: "npm", package: "@acme/plugin" })).toEqual({
    type: "unsupported",
    reason: say("marketplaceFile.source.kindNamed", { kind: "npm" }),
  });
});

test("parseMarketplace keeps readable entries and leaves the others out", async () => {
  const dir = tree({});
  await expect(parseMarketplace(dir)).rejects.toThrow("no .claude-plugin/marketplace.json");
  writeTree(dir, {
    ".claude-plugin/marketplace.json": JSON.stringify({
      name: "acme",
      owner: { name: "Acme" },
      plugins: [
        { name: "docs", description: "Docs.", source: "./", strict: false, skills: ["./skills/pdf"], hooks: { x: 1 } },
        { description: "no name", source: "./" },
        { name: "pkg", source: { source: "npm", package: "x" } },
      ],
    }),
  });
  expect(await parseMarketplace(dir)).toEqual({
    name: "acme",
    entries: [
      { name: "docs", description: "Docs.", skills: ["./skills/pdf"], source: { type: "path", path: "./" }, manifest: { hooks: { x: 1 } } },
      { name: "pkg", source: { type: "unsupported", reason: say("marketplaceFile.source.kindNamed", { kind: "npm" }) } },
    ],
  });
  writeFileSync(join(dir, ".claude-plugin/marketplace.json"), "{");
  await expect(parseMarketplace(dir)).rejects.toThrow("isn't valid JSON");
});

test("a folder listed many times is read once; a huge one stops early; what isn't imported is capped", async () => {
  const files: Record<string, string> = { "skills/bad/SKILL.md": "no frontmatter" };
  for (let i = 0; i < 1100; i++) files[`skills/bad/f${i}\\x`] = "";
  const root = tree(files);
  const got = await readPlugin(root, entry({ skills: Array.from({ length: 200 }, () => "skills/bad") }));
  expect(inEnglish(got.notImported)).toEqual([{ component: "skill", name: "bad", reason: "The skill “bad” holds at most 500 files." }]);

  const many: Record<string, string> = { "skills/ok/SKILL.md": skillMd("ok") };
  for (let i = 0; i < 300; i++) many[`skills/ok/f${i}\\x`] = "";
  const capped = (await readPlugin(tree(many), entry())).notImported;
  expect(capped).toHaveLength(201);
  expect(inEnglish(capped).at(-1)).toEqual({ component: "file", name: "…", reason: "and 100 more not imported" });
});

test("one read has a budget: too many skills, files or bytes, or a file named again and again, can't make it do more", async () => {
  const skills: Record<string, string> = {};
  for (let i = 0; i < 201; i++) skills[`skills/s${i}/SKILL.md`] = skillMd(`s${i}`);
  await expect(readPlugin(tree(skills), entry())).rejects.toThrow("more than 200 skills");

  const files: Record<string, string> = {};
  for (let i = 0; i < 25; i++) for (let j = 0; j < 900; j++) files[`skills/s${i}/f${j}`] = "";
  for (let i = 0; i < 25; i++) files[`skills/s${i}/SKILL.md`] = skillMd(`s${i}`);
  await expect(readPlugin(tree(files), entry())).rejects.toThrow("too large to read");

  const servers = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`s${i}`, { url: `https://x.example/${i}`, pad: "x".repeat(20_000) }]));
  const root = tree({ "servers.json": JSON.stringify({ mcpServers: servers }) });
  const got = await readPlugin(root, entry({ manifest: { mcpServers: Array.from({ length: 10_000 }, () => "./servers.json") } }));
  expect(got.mcpServers).toHaveLength(50);
});

test("reads run off the event loop, at once, each on its own budget", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 25; i++) for (let j = 0; j < 900; j++) files[`skills/s${i}/f${j}`] = "";
  for (let i = 0; i < 25; i++) files[`skills/s${i}/SKILL.md`] = skillMd(`s${i}`);
  const huge = tree(files);
  const small = tree({ "skills/ok/SKILL.md": skillMd("ok") });
  // The event loop turns while a read goes on: a timer set now fires before the huge read ends.
  let turned = false;
  setImmediate(() => (turned = true));
  const [over, ok] = await Promise.allSettled([readPlugin(huge, entry()).finally(() => expect(turned).toBe(true)), readPlugin(small, entry())]);
  expect(over).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: expect.stringContaining("too large to read") }) });
  // The huge read's spending isn't the small one's.
  expect(ok).toMatchObject({ status: "fulfilled", value: { skills: [{ name: "ok" }] } });
});

test("MCP servers are charged to the budget and capped, however they are declared", async () => {
  const many = Object.fromEntries(Array.from({ length: 80_000 }, (_, i) => [`s${i}`, { url: "https://x.example" }]));
  const started = Date.now();
  await expect(readPlugin(tree({}), entry({ manifest: { mcpServers: many } }))).rejects.toThrow(/more than 100 MCP servers|too large/);
  expect(Date.now() - started).toBeLessThan(2000);
  const dupes = Array.from({ length: 50 }, () => ({ same: { url: "https://x.example" } }));
  expect((await readPlugin(tree({}), entry({ manifest: { mcpServers: dupes } }))).mcpServers).toHaveLength(1);
});
