import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
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

test("a strict:false entry's skills are the folders it lists", () => {
  const root = tree({
    "skills/pdf/SKILL.md": skillMd("pdf"),
    "skills/pdf/scripts/fill.py": "print(1)\n",
    "skills/docx/SKILL.md": skillMd("docx"),
    "skills/other/SKILL.md": skillMd("other"),
  });
  const got = readPlugin(root, entry({ skills: ["./skills/pdf", "./skills/docx"] }));
  expect(got.skills.map((s) => [s.name, s.files.map((f) => f.path)])).toEqual([
    ["pdf", ["pdf/SKILL.md", "pdf/scripts/fill.py"]],
    ["docx", ["docx/SKILL.md"]],
  ]);
  expect(got.notImported).toEqual([]);
});

test("without a list, the skills are skills/*; hooks, commands and bin/ are listed as not imported", () => {
  const root = tree({
    ".claude-plugin/plugin.json": JSON.stringify({ name: "superpowers" }),
    "skills/brainstorming/SKILL.md": skillMd("brainstorming"),
    "skills/tdd/SKILL.md": skillMd("tdd"),
    "hooks/hooks.json": JSON.stringify({ hooks: { SessionStart: [] } }),
    "commands/plan.md": "Plan.",
    "bin/tool": "#!/bin/sh\n",
  });
  const got = readPlugin(root, entry());
  expect(got.skills.map((s) => s.name)).toEqual(["brainstorming", "tdd"]);
  expect(got.notImported).toEqual([
    { component: "hook", name: "hooks", reason: "Hooks run commands on the machine" },
    { component: "command", name: "plan", reason: "Commands aren't imported" },
    { component: "bin", name: "bin/", reason: "Runs the plugin's own programs" },
  ]);
});

test("symlinked file is skipped, and so are a linked skill folder and files a skill can't hold", () => {
  const outside = tree({ "secret/SKILL.md": skillMd("secret") });
  const root = tree({
    "skills/x/SKILL.md": skillMd("x"),
    "skills/x/host": { link: "/etc/hostname" },
    "skills/x/.mcp.json": "{}",
    "skills/x/.claude/settings.json": "{}",
    "skills/x/hooks/hooks.json": "{}",
    "skills/linked": { link: join(outside, "secret") },
  });
  const got = readPlugin(root, entry({ skills: ["skills/x", "skills/linked", "../escape"] }));
  expect(got.skills.map((s) => [s.name, s.files.map((f) => f.path)])).toEqual([["x", ["x/SKILL.md", "x/hooks/hooks.json"]]]);
  expect(got.notImported).toEqual(
    expect.arrayContaining([
      { component: "file", name: "x/host", reason: "A symbolic link" },
      { component: "file", name: "x/.mcp.json", reason: "Its path isn't allowed in a skill" },
      { component: "file", name: "x/.claude", reason: "Its path isn't allowed in a skill" },
      { component: "skill", name: "linked", reason: "Its folder isn't in the plugin (or is a link)" },
      { component: "skill", name: "../escape", reason: "Its folder is outside the plugin" },
    ]),
  );
});

test("a skill that doesn't validate is listed with its reason", () => {
  const root = tree({ "skills/a/SKILL.md": skillMd("b"), "skills/Bad_Name/SKILL.md": skillMd("Bad_Name") });
  expect(readPlugin(root, entry()).notImported).toEqual([
    { component: "skill", name: "Bad_Name", reason: "Its name isn't lowercase letters, digits and hyphens" },
    { component: "skill", name: "a", reason: 'a/SKILL.md: the frontmatter\'s name must be "a", its folder' },
  ]);
});

test("a relative source leaving the repo is refused", () => {
  const root = tree({ "plugins/a/x": "1" });
  expect(resolvePluginRoot(root, "./plugins/a")).toBe(join(root, "plugins/a"));
  for (const path of ["../x", "plugins/../../x", "/etc", "plugins/a/x"]) expect(() => resolvePluginRoot(root, path), path).toThrow();
  writeTree(root, { "plugins/out": { link: "/etc" } });
  expect(() => resolvePluginRoot(root, "plugins/out")).toThrow();
});

test("readPlugin parses .mcp.json servers with their ${VAR} settings and agents/*.md", () => {
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
  const got = readPlugin(root, entry());
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
  expect(got.notImported).toEqual([{ component: "mcp-server", name: "own", reason: "It runs the plugin's own files" }]);
  expect(got.agents).toEqual([
    { name: "plain", description: "", systemPrompt: "Just a prompt." },
    { name: "code-reviewer", description: "Reviews code.", systemPrompt: "You review code." },
  ]);
});

test("marketplace sources map to Git fetches; an npm source is unsupported, with its reason", () => {
  expect(mapSource("./plugins/a")).toEqual({ type: "path", path: "./plugins/a" });
  expect(mapSource({ source: "github", repo: "obra/superpowers", ref: "v1" })).toEqual({ type: "git", url: "https://github.com/obra/superpowers.git", ref: "v1" });
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
  expect(mapSource({ source: "npm", package: "@acme/plugin" })).toEqual({ type: "unsupported", reason: "“npm” sources aren't supported: only Git repositories are" });
});

test("parseMarketplace keeps readable entries and leaves the others out", () => {
  const dir = tree({});
  expect(() => parseMarketplace(dir)).toThrow("no .claude-plugin/marketplace.json");
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
  expect(parseMarketplace(dir)).toEqual({
    name: "acme",
    entries: [
      { name: "docs", description: "Docs.", skills: ["./skills/pdf"], source: { type: "path", path: "./" }, manifest: { hooks: { x: 1 } } },
      { name: "pkg", source: { type: "unsupported", reason: "“npm” sources aren't supported: only Git repositories are" } },
    ],
  });
  writeFileSync(join(dir, ".claude-plugin/marketplace.json"), "{");
  expect(() => parseMarketplace(dir)).toThrow("isn't valid JSON");
});

test("a folder listed many times is read once; a huge one stops early; what isn't imported is capped", () => {
  const files: Record<string, string> = { "skills/bad/SKILL.md": "no frontmatter" };
  for (let i = 0; i < 1100; i++) files[`skills/bad/f${i}\\x`] = "";
  const root = tree(files);
  const got = readPlugin(root, entry({ skills: Array.from({ length: 200 }, () => "skills/bad") }));
  expect(got.notImported).toEqual([{ component: "skill", name: "bad", reason: "bad: a skill holds at most 500 files" }]);

  const many: Record<string, string> = { "skills/ok/SKILL.md": skillMd("ok") };
  for (let i = 0; i < 300; i++) many[`skills/ok/f${i}\\x`] = "";
  const capped = readPlugin(tree(many), entry()).notImported;
  expect(capped).toHaveLength(201);
  expect(capped.at(-1)).toEqual({ component: "file", name: "…", reason: "and 100 more not imported" });
});

test("one read has a budget: too many skills, files or bytes, or a file named again and again, can't make it do more", () => {
  const skills: Record<string, string> = {};
  for (let i = 0; i < 201; i++) skills[`skills/s${i}/SKILL.md`] = skillMd(`s${i}`);
  expect(() => readPlugin(tree(skills), entry())).toThrow("more than 200 skills");

  const files: Record<string, string> = {};
  for (let i = 0; i < 25; i++) for (let j = 0; j < 900; j++) files[`skills/s${i}/f${j}`] = "";
  for (let i = 0; i < 25; i++) files[`skills/s${i}/SKILL.md`] = skillMd(`s${i}`);
  expect(() => readPlugin(tree(files), entry())).toThrow("too large to read");

  const servers = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`s${i}`, { url: `https://x.example/${i}`, pad: "x".repeat(20_000) }]));
  const root = tree({ "servers.json": JSON.stringify({ mcpServers: servers }) });
  const got = readPlugin(root, entry({ manifest: { mcpServers: Array.from({ length: 10_000 }, () => "./servers.json") } }));
  expect(got.mcpServers).toHaveLength(50);
});

test("MCP servers are charged to the budget and capped, however they are declared", () => {
  const many = Object.fromEntries(Array.from({ length: 80_000 }, (_, i) => [`s${i}`, { url: "https://x.example" }]));
  const started = Date.now();
  expect(() => readPlugin(tree({}), entry({ manifest: { mcpServers: many } }))).toThrow(/more than 100 MCP servers|too large/);
  expect(Date.now() - started).toBeLessThan(2000);
  const dupes = Array.from({ length: 50 }, () => ({ same: { url: "https://x.example" } }));
  expect(readPlugin(tree({}), entry({ manifest: { mcpServers: dupes } })).mcpServers).toHaveLength(1);
});
