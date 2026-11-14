import { execFileSync } from "node:child_process";
import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { ELEMENT_FIELDS } from "./overrides.ts";
import { messages, plugins as pluginsTable, questions, runs as runsTable, skillFiles, skillPackages, stepRuns, tools } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";
import { BUILT_IN_MARKETPLACES } from "./marketplace.ts";
import { marketplaceUrl, packageName } from "./procedures.ts";
import { fixtureRepo, lawFirm, lawFirmMarket, skillMd } from "./test-support.ts";
import { toolTarget } from "../tools/procedures.ts";
import { addStep } from "../workflows/model.ts";
import { type FakeAction, startFakeMcp } from "../tools/test-server.ts";

/** The owner's context, allowed to use `file://` fixture repositories. */
async function context() {
  return { ...(await ownerContext()), gitFileUrls: true };
}

/** A plugin repository shaped like superpowers: skills/*, a hook, a command. */
function superpowers() {
  return fixtureRepo({
    ".claude-plugin/plugin.json": JSON.stringify({ name: "superpowers", description: "Core skills." }),
    "skills/brainstorming/SKILL.md": skillMd("brainstorming"),
    "skills/brainstorming/visual.md": "Draw.",
    "skills/tdd/SKILL.md": skillMd("tdd"),
    "hooks/hooks.json": "{}",
    "commands/plan.md": "Plan.",
  });
}

/** A marketplace shaped like anthropics/skills (strict:false entries listing skills), plus a url-sourced plugin. */
function marketplace(plugin: { url: string; sha: string }) {
  return fixtureRepo({
    ".claude-plugin/marketplace.json": JSON.stringify({
      name: "acme",
      plugins: [
        { name: "document-skills", description: "Office documents.", source: "./", strict: false, skills: ["./skills/pdf", "./skills/docx"] },
        { name: "superpowers", description: "TDD and more.", source: { source: "url", url: plugin.url, sha: plugin.sha } },
        { name: "npm-thing", source: { source: "npm", package: "x" } },
        { name: "escape", source: "../outside" },
      ],
    }),
    "skills/pdf/SKILL.md": skillMd("pdf"),
    "skills/pdf/fill.py": "print(1)\n",
    "skills/docx/SKILL.md": skillMd("docx"),
  });
}

test("the owner starts with the built-in marketplaces, which can't be removed", async () => {
  const ctx = await ownerContext();
  const list = await call(router.marketplaces.list, undefined, { context: ctx });
  expect(list.map((m) => [m.url, m.builtIn, m.plugins, m.syncedAt])).toEqual(
    [...BUILT_IN_MARKETPLACES].sort((a, b) => a.name.localeCompare(b.name)).map((m) => [m.url, true, 0, null]),
  );
  await expect(call(router.marketplaces.remove, { id: list[0]!.id }, { context: ctx })).rejects.toMatchObject({ code: "FORBIDDEN" });
});

test("a marketplace is https:// only; file:// needs the development switch", async () => {
  const ctx = await ownerContext();
  const repo = marketplace({ url: "https://example.com/x.git", sha: "a".repeat(40) });
  await expect(call(router.marketplaces.add, { url: repo.url }, { context: ctx })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Use an https:// Git URL" });
  await expect(call(router.marketplaces.add, { url: "http://example.com/m.git" }, { context: ctx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  repo.remove();
});

test("install reads the skills a strict:false entry lists, and skills shows them from the plugin, read-only", async () => {
  const ctx = await context();
  const plugin = superpowers();
  const repo = marketplace(plugin);
  const market = await call(router.marketplaces.add, { url: repo.url }, { context: ctx });
  expect(market).toMatchObject({ name: "acme", plugins: 4, builtIn: false, syncError: null });

  const found = await call(router.plugins.discover, { query: "office" }, { context: ctx });
  expect(found).toEqual([
    {
      marketplaceId: market.id,
      marketplace: "acme",
      entry: { name: "document-skills", description: "Office documents.", version: null, source: { supported: true } },
      installed: false,
    },
  ]);
  const preview = await call(router.plugins.preview, { marketplaceId: market.id, entryName: "document-skills" }, { context: ctx });
  expect(preview.skills.map((s) => s.name)).toEqual(["pdf", "docx"]);

  const { pluginId } = await call(router.plugins.install, { marketplaceId: market.id, entryName: "document-skills", skills: ["pdf"] }, { context: ctx });
  const [pkg] = await call(router.skills.list, undefined, { context: ctx });
  expect(pkg).toMatchObject({ name: "document-skills", plugin: { id: pluginId, name: "document-skills" }, skills: [{ name: "pdf", description: "Does pdf." }] });
  const files = await ctx.db.select({ path: skillFiles.path }).from(skillFiles).where(eq(skillFiles.packageId, pkg!.packageId));
  expect(files.map((f) => f.path).sort()).toEqual(["pdf/SKILL.md", "pdf/fill.py"]);
  await expect(call(router.skills.delete, { packageId: pkg!.packageId }, { context: ctx })).rejects.toMatchObject({ code: "FORBIDDEN" });

  const [installed] = await call(router.plugins.list, undefined, { context: ctx });
  expect(installed).toMatchObject({ id: pluginId, source: "marketplace", marketplace: "acme", tables: [], triggers: [], skills: [{ name: "pdf" }], available: { skills: [{ name: "docx" }] } });
  expect((await call(router.plugins.discover, { query: "document" }, { context: ctx }))[0]!.installed).toBe(true);
  await expect(
    call(router.plugins.install, { marketplaceId: market.id, entryName: "document-skills", skills: ["docx"] }, { context: ctx }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(call(router.marketplaces.remove, { id: market.id }, { context: ctx })).rejects.toMatchObject({ code: "CONFLICT" });
  plugin.remove();
  repo.remove();
});

test("install reads skills/ of a url-sourced plugin at its sha; hooks and commands are listed as not imported", async () => {
  const ctx = await context();
  const plugin = superpowers();
  plugin.commit({ "skills/later/SKILL.md": skillMd("later") });
  const repo = marketplace(plugin);
  const market = await call(router.marketplaces.add, { url: repo.url }, { context: ctx });
  const preview = await call(router.plugins.preview, { marketplaceId: market.id, entryName: "superpowers" }, { context: ctx });
  expect(preview.skills.map((s) => s.name)).toEqual(["brainstorming", "tdd"]);
  expect(preview.notImported).toEqual([
    { component: "hook", name: "hooks", reason: "Hooks run commands on the machine" },
    { component: "command", name: "plan", reason: "Commands aren't imported" },
  ]);
  await call(router.plugins.install, { marketplaceId: market.id, entryName: "superpowers", skills: ["brainstorming", "tdd"] }, { context: ctx });
  const [installed] = await call(router.plugins.list, undefined, { context: ctx });
  expect(installed).toMatchObject({ sha: plugin.sha, skills: [{ name: "brainstorming" }, { name: "tdd" }], notImported: preview.notImported });
  plugin.remove();
  repo.remove();
});

test("unsupported and escaping sources, and unknown skills, are refused with their reason", async () => {
  const ctx = await context();
  const plugin = superpowers();
  const repo = marketplace(plugin);
  const market = await call(router.marketplaces.add, { url: repo.url }, { context: ctx });
  const ref = { marketplaceId: market.id };
  await expect(call(router.plugins.preview, { ...ref, entryName: "npm-thing" }, { context: ctx })).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: "“npm” sources aren't supported: only Git repositories are",
  });
  await expect(call(router.plugins.preview, { ...ref, entryName: "escape" }, { context: ctx })).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: "The plugin's folder is outside its repository",
  });
  await expect(call(router.plugins.install, { ...ref, entryName: "document-skills", skills: ["nope"] }, { context: ctx })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  await expect(call(router.plugins.preview, { ...ref, entryName: "missing" }, { context: ctx })).rejects.toMatchObject({ code: "NOT_FOUND" });
  plugin.remove();
  repo.remove();
});

test("a failed sync keeps the previous entries and stores syncError", async () => {
  const ctx = await context();
  const repo = marketplace({ url: "https://example.com/x.git", sha: "a".repeat(40) });
  const market = await call(router.marketplaces.add, { url: repo.url }, { context: ctx });
  repo.remove();
  const synced = await call(router.marketplaces.sync, { id: market.id }, { context: ctx });
  expect(synced).toMatchObject({ plugins: 4, syncedAt: market.syncedAt });
  expect(synced.syncError).toMatch(/^Couldn't fetch file:.*: /);
  expect(await call(router.plugins.discover, {}, { context: ctx })).toHaveLength(4);
});

test("update replaces the imported skills' files with the latest commit's; new skills show as available", async () => {
  const ctx = await context();
  const plugin = superpowers();
  const repo = marketplace(plugin);
  const market = await call(router.marketplaces.add, { url: repo.url }, { context: ctx });
  const { pluginId } = await call(router.plugins.install, { marketplaceId: market.id, entryName: "document-skills", skills: ["pdf"] }, { context: ctx });
  repo.commit({ "skills/pdf/fill.py": "print(2)\n", "skills/xlsx/SKILL.md": skillMd("xlsx") });
  // The marketplace lists the new skill too.
  const sha = repo.commit({
    ".claude-plugin/marketplace.json": JSON.stringify({
      name: "acme",
      plugins: [{ name: "document-skills", source: "./", strict: false, skills: ["./skills/pdf", "./skills/docx", "./skills/xlsx"] }],
    }),
  });
  expect(await call(router.plugins.update, { id: pluginId }, { context: ctx })).toEqual({ sha });
  const [pkg] = await ctx.db.select().from(skillPackages).where(eq(skillPackages.pluginId, pluginId));
  const [file] = await ctx.db.select().from(skillFiles).where(eq(skillFiles.path, "pdf/fill.py"));
  expect(file!.packageId).toBe(pkg!.id);
  expect(Buffer.from(file!.content).toString()).toBe("print(2)\n");
  const [installed] = await call(router.plugins.list, undefined, { context: ctx });
  expect(installed!.available.skills.map((s) => s.name)).toEqual(["docx", "xlsx"]);
  plugin.remove();
  repo.remove();
});

test("uninstall removes the plugin's skill package when no agent uses it, else keeps it as the owner's own", async () => {
  const ctx = await context();
  const plugin = superpowers();
  const repo = marketplace(plugin);
  const market = await call(router.marketplaces.add, { url: repo.url }, { context: ctx });
  const ref = { marketplaceId: market.id, entryName: "document-skills", skills: ["pdf", "docx"] };
  // No agent uses it: it goes with the plugin.
  const first = await call(router.plugins.install, ref, { context: ctx });
  await call(router.plugins.uninstall, { id: first.pluginId }, { context: ctx });
  expect(await call(router.plugins.list, undefined, { context: ctx })).toEqual([]);
  expect(await call(router.skills.list, undefined, { context: ctx })).toEqual([]);
  expect(await ctx.db.select().from(skillFiles)).toEqual([]);
  // An agent uses it: it stays, no longer the plugin's, and editable.
  const second = await call(router.plugins.install, ref, { context: ctx });
  const h = await harness(ctx);
  const [pkg] = await call(router.skills.list, undefined, { context: ctx });
  expect(pkg).toMatchObject({ plugin: { id: second.pluginId } });
  const agent = await call(router.agents.create, { name: "Writer", harnessId: h.id, systemPrompt: "", skillPackageIds: [pkg!.packageId] }, { context: ctx });
  await call(router.plugins.uninstall, { id: second.pluginId }, { context: ctx });
  expect(await call(router.plugins.list, undefined, { context: ctx })).toEqual([]);
  const [kept] = await call(router.skills.list, undefined, { context: ctx });
  expect(kept).toMatchObject({ packageId: pkg!.packageId, name: "document-skills", plugin: null });
  expect((await call(router.skills.list, undefined, { context: ctx }))[0]!.skills.map((s) => s.name).sort()).toEqual(["docx", "pdf"]);
  expect(await call(router.agents.get, { id: agent.id }, { context: ctx })).toMatchObject({ skills: [{ name: "document-skills" }] });
  const again = await call(router.plugins.install, ref, { context: ctx });
  const reinstalled = await call(router.skills.list, undefined, { context: ctx });
  expect(reinstalled.find((p) => p.plugin?.id === again.pluginId)).toMatchObject({ name: "document-skills-2" });
  expect(await call(router.agents.get, { id: agent.id }, { context: ctx })).toMatchObject({ skills: [{ name: "document-skills" }] });
  await call(router.plugins.uninstall, { id: again.pluginId }, { context: ctx });
  // Editing it adds the skill named like it and keeps the plugin's, files included.
  const edit = { packageId: pkg!.packageId, description: "Mine now.", instructions: "Use them.", requiredToolIds: [] };
  await expect(call(router.skills.update, { ...edit, name: "pdf" }, { context: ctx })).rejects.toMatchObject({ code: "CONFLICT" });
  await call(router.skills.update, { ...edit, name: "document-skills" }, { context: ctx });
  expect((await call(router.skills.list, undefined, { context: ctx }))[0]!.skills.map((s) => s.name).sort()).toEqual(["document-skills", "docx", "pdf"]);
  expect((await call(router.skills.get, { packageId: pkg!.packageId }, { context: ctx })).files.map((f) => f.path)).toContain("pdf/fill.py");
  await call(router.agents.delete, { id: agent.id }, { context: ctx });
  await call(router.skills.delete, { packageId: pkg!.packageId }, { context: ctx });
  expect(await call(router.skills.list, undefined, { context: ctx })).toEqual([]);
  await call(router.marketplaces.remove, { id: market.id }, { context: ctx });
  plugin.remove();
  repo.remove();
});

test("plugin imports use a free package name without changing existing skills", async () => {
  const ctx = await context();
  const plugin = superpowers();
  const repo = marketplace(plugin);
  const market = await call(router.marketplaces.add, { url: repo.url }, { context: ctx });
  const mine = await call(router.skills.create, { name: "document-skills", description: "Mine.", instructions: "Keep these edits.", requiredToolIds: [] }, { context: ctx });
  await call(router.skills.create, { name: "document-skills-2", description: "Also mine.", instructions: "x", requiredToolIds: [] }, { context: ctx });
  const result = await call(router.plugins.install, { marketplaceId: market.id, entryName: "document-skills", skills: ["pdf"] }, { context: ctx });
  const packages = await call(router.skills.list, undefined, { context: ctx });
  expect(packages.find((p) => p.plugin?.id === result.pluginId)).toMatchObject({ name: "document-skills-3" });
  expect((await call(router.skills.get, { packageId: mine.packageId }, { context: ctx })).instructions).toContain("Keep these edits.");
  plugin.remove();
  repo.remove();
});

test("package names follow the skill name rule", () => {
  expect(packageName("Document Skills")).toBe("document-skills");
  expect(packageName("wordpress.com")).toBe("wordpress-com");
  expect(packageName("---")).toBe("plugin");
});

test("a custom marketplace shaped like superpowers-marketplace: url sources at their default branch or ref", async () => {
  const ctx = await context();
  const plugin = superpowers();
  const dev = plugin.commit({ "skills/dev-only/SKILL.md": skillMd("dev-only") });
  // `main` stays at the first commit; `dev` gets the new skill.
  execFileSync("git", ["branch", "dev", dev], { cwd: plugin.dir });
  execFileSync("git", ["reset", "-q", "--hard", plugin.sha], { cwd: plugin.dir });
  const repo = fixtureRepo({
    ".claude-plugin/marketplace.json": JSON.stringify({
      name: "superpowers-marketplace",
      owner: { name: "Someone" },
      metadata: { description: "Skills, workflows, and productivity tools", version: "1.0.13" },
      plugins: [
        { name: "superpowers", source: { source: "url", url: plugin.url }, description: "Core skills library", version: "7.0.2", strict: true },
        { name: "superpowers-dev", source: { source: "url", url: plugin.url, ref: "dev" }, description: "DEV BRANCH", strict: true },
      ],
    }),
  });
  const market = await call(router.marketplaces.add, { url: repo.url }, { context: ctx });
  expect(market).toMatchObject({ name: "superpowers-marketplace", plugins: 2 });
  const preview = await call(router.plugins.preview, { marketplaceId: market.id, entryName: "superpowers" }, { context: ctx });
  expect(preview.skills.map((s) => s.name)).toEqual(["brainstorming", "tdd"]);
  const devPreview = await call(router.plugins.preview, { marketplaceId: market.id, entryName: "superpowers-dev" }, { context: ctx });
  expect(devPreview.skills.map((s) => s.name)).toEqual(["brainstorming", "dev-only", "tdd"]);
  await call(router.plugins.install, { marketplaceId: market.id, entryName: "superpowers", skills: ["brainstorming", "tdd"] }, { context: ctx });
  const [installed] = await call(router.plugins.list, undefined, { context: ctx });
  expect(installed).toMatchObject({ name: "superpowers", sha: plugin.sha, skills: [{ name: "brainstorming" }, { name: "tdd" }] });
  plugin.remove();
  repo.remove();
});

test("a marketplace can be given as GitHub's owner/repo", () => {
  expect(marketplaceUrl("obra/superpowers-marketplace")).toBe("https://github.com/obra/superpowers-marketplace.git");
  expect(marketplaceUrl("obra/superpowers-marketplace.git")).toBe("https://github.com/obra/superpowers-marketplace.git");
  expect(marketplaceUrl("https://gitlab.com/a/b.git")).toBe("https://gitlab.com/a/b.git");
});

test("symlinked file is skipped: a link in a fetched plugin is listed, never imported", async () => {
  const ctx = await context();
  const plugin = fixtureRepo({
    "skills/peek/SKILL.md": skillMd("peek"),
    "skills/peek/host": { link: "/etc/hostname" },
    "skills/peek/keys": { link: `${process.env.HOME}/.ssh` },
  });
  const repo = fixtureRepo({
    ".claude-plugin/marketplace.json": JSON.stringify({ name: "m", plugins: [{ name: "peek", source: { source: "url", url: plugin.url } }] }),
  });
  const market = await call(router.marketplaces.add, { url: repo.url }, { context: ctx });
  const preview = await call(router.plugins.preview, { marketplaceId: market.id, entryName: "peek" }, { context: ctx });
  expect(preview.notImported).toEqual([
    { component: "file", name: "skills/peek/host", reason: "A symbolic link" },
    { component: "file", name: "skills/peek/keys", reason: "A symbolic link" },
  ]);
  await call(router.plugins.install, { marketplaceId: market.id, entryName: "peek", skills: ["peek"] }, { context: ctx });
  const files = await ctx.db.select({ path: skillFiles.path }).from(skillFiles);
  expect(files.map((f) => f.path)).toEqual(["peek/SKILL.md"]);
  plugin.remove();
  repo.remove();
});

/** A plugin shaped like claude-plugins-official's github, with more of every kind of component. */
async function toolPlugin() {
  const server = await startFakeMcp([echo]);
  const base = server.url.replace(/\/mcp$/, "");
  const plugin = fixtureRepo({
    ".claude-plugin/plugin.json": JSON.stringify({ name: "github" }),
    ".mcp.json": JSON.stringify({
      github: { type: "http", url: server.url, headers: { Authorization: "Bearer ${GITHUB_TOKEN}" } },
      tenant: { type: "http", url: `${base}/\${TENANT}/mcp` },
      fetch: { command: "uvx", args: ["mcp-server-fetch"], env: { KEY: "${KEY}" } },
      local: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.js"] },
    }),
    "skills/review/SKILL.md": skillMd("review"),
    "agents/reviewer.md": "---\nname: reviewer\ndescription: Reviews PRs.\ntools: Bash, Read\nmodel: opus\n---\n\nYou review pull requests.\n",
  });
  const repo = fixtureRepo({
    ".claude-plugin/marketplace.json": JSON.stringify({ name: "official", plugins: [{ name: "github", source: { source: "url", url: plugin.url } }] }),
  });
  return {
    server,
    plugin,
    repo,
    remove: async () => {
      plugin.remove();
      repo.remove();
      await server.close();
    },
  };
}

const echo: FakeAction = { name: "echo", description: "Says it back to Acme-Tenant", inputSchema: { type: "object" }, call: () => ({ content: [] }) };
const TOKEN = "ghp_s3cret-token";

/** What the owner reviews before installing MCP servers. */
async function reviewed(ctx: Awaited<ReturnType<typeof context>>, marketplaceId: string, entryName: string) {
  return (await call(router.plugins.preview, { marketplaceId, entryName }, { context: ctx })).reviewed;
}

async function harness(ctx: Awaited<ReturnType<typeof context>>) {
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context: ctx });
  return call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context: ctx });
}

test("plugin-root server not imported; an HTTP server is installed with its setting sealed in the header", async () => {
  const ctx = await context();
  const fx = await toolPlugin();
  const market = await call(router.marketplaces.add, { url: fx.repo.url }, { context: ctx });
  const ref = { marketplaceId: market.id, entryName: "github" };
  const preview = await call(router.plugins.preview, ref, { context: ctx });
  // Where each HTTP server's settings would go is shown.
  expect(preview.mcpServers).toEqual([
    { name: "github", type: "http", settings: ["GITHUB_TOKEN"], url: fx.server.url },
    { name: "tenant", type: "http", settings: ["TENANT"], url: fx.server.url.replace(/\/mcp$/, "/${TENANT}/mcp") },
    { name: "fetch", type: "stdio", settings: ["KEY"] },
  ]);
  expect(preview.reviewed).toMatch(/^[0-9a-f]{64}$/);
  expect(preview.notImported).toContainEqual({ component: "mcp-server", name: "local", reason: "It runs the plugin's own files" });
  await expect(call(router.plugins.install, { ...ref, reviewed: await reviewed(ctx, market.id, "github"), mcpServers: ["local"] }, { context: ctx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(call(router.plugins.install, { ...ref, reviewed: await reviewed(ctx, market.id, "github"), mcpServers: ["github"] }, { context: ctx })).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: "The MCP server github needs GITHUB_TOKEN",
  });
  // Runner tools can't be installed from a plugin.
  await expect(call(router.plugins.install, { ...ref, reviewed: await reviewed(ctx, market.id, "github"), mcpServers: ["fetch"] }, { context: ctx })).rejects.toMatchObject({ code: "BAD_REQUEST" });

  const { pluginId, toolIds } = await call(router.plugins.install, { ...ref, reviewed: await reviewed(ctx, market.id, "github"), mcpServers: ["github"], settings: { github: { GITHUB_TOKEN: TOKEN } } }, { context: ctx });
  const [tool] = await call(router.tools.list, undefined, { context: ctx });
  expect(tool).toMatchObject({ id: toolIds[0], name: "github", url: fx.server.url, urlSet: false, headerNames: ["authorization"], plugin: { id: pluginId, name: "github" } });
  expect(tool!.actions.map((a) => a.name)).toEqual(["echo"]);
  expect(fx.server.requests.every((h) => h.authorization === `Bearer ${TOKEN}`)).toBe(true);
  const [row] = await ctx.db.select().from(tools).where(eq(tools.id, tool!.id));
  expect(JSON.stringify(row)).not.toContain("s3cret");
  expect(JSON.stringify(await call(router.plugins.list, undefined, { context: ctx }))).not.toContain("s3cret");
  const [installed] = await call(router.plugins.list, undefined, { context: ctx });
  expect(installed).toMatchObject({ tools: [{ id: tool!.id, name: "github" }], available: { mcpServers: [{ name: "tenant" }, { name: "fetch" }] } });

  // The owner may edit it, as an override; it goes only with its plugin.
  await call(router.tools.update, { id: tool!.id, name: "GitHub" }, { context: ctx });
  await expect(call(router.tools.delete, { id: tool!.id }, { context: ctx })).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect((await call(router.plugins.list, undefined, { context: ctx }))[0]).toMatchObject({ tools: [{ id: tool!.id, name: "GitHub" }], available: { mcpServers: [{ name: "tenant" }, { name: "fetch" }] } });
  await fx.remove();
});

test("a marketplace entry may point at an Agent Plugins plugin: its skill and HTTP server install, and the layout is kept", async () => {
  const ctx = await context();
  const server = await startFakeMcp([echo]);
  const plugin = fixtureRepo({
    "plugin.json": JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "reviews", version: "1.0.0" }),
    "mcp.json": JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { review: { type: "streamable-http", url: server.url }, local: { type: "stdio", command: "./bin/server" } },
    }),
    "skills/review/SKILL.md": skillMd("review"),
  });
  const repo = fixtureRepo({ ".claude-plugin/marketplace.json": JSON.stringify({ name: "acme", plugins: [{ name: "reviews", source: { source: "url", url: plugin.url } }] }) });
  const market = await call(router.marketplaces.add, { url: repo.url }, { context: ctx });
  const ref = { marketplaceId: market.id, entryName: "reviews" };
  expect(await call(router.plugins.preview, ref, { context: ctx })).toMatchObject({
    skills: [{ name: "review" }],
    mcpServers: [
      { name: "review", type: "http", settings: [], url: server.url },
      { name: "local", type: "stdio", settings: [] },
    ],
    notImported: [],
  });
  // Its stdio server, like any, waits for runner support.
  await expect(call(router.plugins.install, { ...ref, reviewed: await reviewed(ctx, market.id, "reviews"), mcpServers: ["local"] }, { context: ctx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  const { pluginId, toolIds } = await call(router.plugins.install, { ...ref, reviewed: await reviewed(ctx, market.id, "reviews"), skills: ["review"], mcpServers: ["review"] }, { context: ctx });
  const [row] = await ctx.db.select().from(pluginsTable).where(eq(pluginsTable.id, pluginId));
  expect(row).toMatchObject({ layout: "standard", components: { skills: [{ name: "review" }] } });
  const [tool] = await call(router.tools.list, undefined, { context: ctx });
  expect(tool).toMatchObject({ id: toolIds[0], name: "review", url: server.url, headerNames: [] });
  plugin.remove();
  repo.remove();
  await server.close();
});

test("a placeholder in the URL makes the whole URL a secret; a plugin's tool may be called as one of the owner's is", async () => {
  const ctx = await context();
  const fx = await toolPlugin();
  const market = await call(router.marketplaces.add, { url: fx.repo.url }, { context: ctx });
  await call(router.tools.create, { name: "Tenant", url: fx.server.url, transport: "streamable-http", headers: {} }, { context: ctx });
  const { toolIds } = await call(
    router.plugins.install,
    { marketplaceId: market.id, entryName: "github", reviewed: await reviewed(ctx, market.id, "github"), mcpServers: ["tenant"], settings: { tenant: { TENANT: "Acme-Tenant" } } },
    { context: ctx },
  );
  const tool = await call(router.tools.get, { id: toolIds[0]! }, { context: ctx });
  expect(tool).toMatchObject({ name: "tenant", url: expect.stringMatching(/\/\$\{TENANT\}\/mcp$/), urlSet: true, actionsError: null });
  // The server may echo it: redacted like a header.
  expect(tool.actions).toEqual([expect.objectContaining({ name: "echo", description: "Says it back to ••••" })]);
  const [row] = await ctx.db.select().from(tools).where(eq(tools.id, tool.id));
  expect(JSON.stringify(row)).not.toContain("acme-tenant");
  expect(JSON.stringify(row)).not.toContain("Acme-Tenant");
  expect(toolTarget(row!, ctx.secrets).url).toBe(fx.server.url.replace(/\/mcp$/, "/Acme-Tenant/mcp"));
  // Only characters a URL keeps as they are, so the redaction finds it.
  await expect(
    call(router.plugins.install, { marketplaceId: market.id, entryName: "github", reviewed: await reviewed(ctx, market.id, "github"), mcpServers: ["tenant"], settings: { tenant: { TENANT: "a/b" } } }, { context: ctx }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "A setting of the MCP server tenant's URL may hold only letters, digits and . _ ~ -" });
  // Renaming keeps the secret URL; a new URL replaces it.
  expect(await call(router.tools.update, { id: tool.id, name: "T2", url: tool.url! }, { context: ctx })).toMatchObject({ urlSet: true });
  expect(await call(router.tools.update, { id: tool.id, url: fx.server.url }, { context: ctx })).toMatchObject({ urlSet: false, url: fx.server.url });
  await fx.remove();
});

test("a setting in a URL's host is refused: only a path or query keeps it as written", async () => {
  const ctx = await context();
  const plugin = fixtureRepo({ ".mcp.json": JSON.stringify({ tenant: { type: "http", url: "https://${TENANT}.invalid/mcp" } }) });
  const repo = fixtureRepo({ ".claude-plugin/marketplace.json": JSON.stringify({ name: "m", plugins: [{ name: "t", source: { source: "url", url: plugin.url } }] }) });
  const market = await call(router.marketplaces.add, { url: repo.url }, { context: ctx });
  await expect(
    call(router.plugins.install, { marketplaceId: market.id, entryName: "t", reviewed: await reviewed(ctx, market.id, "t"), mcpServers: ["tenant"], settings: { tenant: { TENANT: "Acme-S3cret" } } }, { context: ctx }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "The MCP server tenant's URL needs a setting in its host: not supported" });
  expect(await call(router.tools.list, undefined, { context: ctx })).toEqual([]);
  plugin.remove();
  repo.remove();
});

test("an agent is created on the chosen harness with the plugin's skills and tools; agents without harnessId is BAD_REQUEST", async () => {
  const ctx = await context();
  const fx = await toolPlugin();
  const market = await call(router.marketplaces.add, { url: fx.repo.url }, { context: ctx });
  const ref = { marketplaceId: market.id, entryName: "github" };
  await expect(call(router.plugins.install, { ...ref, agents: ["reviewer"] }, { context: ctx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  const h = await harness(ctx);
  await call(router.agents.create, { name: "reviewer", harnessId: h.id, systemPrompt: "Mine." }, { context: ctx });
  const { pluginId, agentIds } = await call(
    router.plugins.install,
    { ...ref, skills: ["review"], reviewed: await reviewed(ctx, market.id, "github"), mcpServers: ["github"], agents: ["reviewer"], harnessId: h.id, settings: { github: { GITHUB_TOKEN: TOKEN } } },
    { context: ctx },
  );
  const agent = await call(router.agents.get, { id: agentIds[0]! }, { context: ctx });
  // The owner's own "reviewer" is no clash: the plugin's agents are named inside the plugin.
  expect(agent).toMatchObject({
    name: "reviewer",
    harnessId: h.id,
    systemPrompt: "You review pull requests.",
    plugin: { id: pluginId, name: "github" },
    skills: [{ name: "github" }],
    tools: [{ name: "github", explicit: true, lockedBy: [] }],
  });
  expect(agent).not.toHaveProperty("model");
  const [installed] = await call(router.plugins.list, undefined, { context: ctx });
  expect(installed).toMatchObject({ agents: [{ id: agent.id, name: "reviewer" }], available: { agents: [] } });
  // It goes only with its plugin.
  await expect(call(router.agents.delete, { id: agent.id }, { context: ctx })).rejects.toMatchObject({ code: "FORBIDDEN" });
  await fx.remove();
});

test("uninstall keeps its agents with their Jobs and its tools with their headers; a reinstall makes copies", async () => {
  const ctx = await context();
  const fx = await toolPlugin();
  const market = await call(router.marketplaces.add, { url: fx.repo.url }, { context: ctx });
  const h = await harness(ctx);
  const install = async () =>
    call(
      router.plugins.install,
      { marketplaceId: market.id, entryName: "github", reviewed: await reviewed(ctx, market.id, "github"), mcpServers: ["github"], agents: ["reviewer"], harnessId: h.id, settings: { github: { GITHUB_TOKEN: TOKEN } } },
      { context: ctx },
    );
  const { pluginId, toolIds, agentIds } = await install();
  const [toolId, agentId] = [toolIds[0]!, agentIds[0]!];
  // In use: an agent of the owner's has its tool, a skill requires it, a workflow uses its agent,
  // and its agent has a Job still going, with a message and a Question.
  const mine = await call(router.agents.create, { name: "Mine", harnessId: h.id, systemPrompt: "", toolIds }, { context: ctx });
  const skill = await call(router.skills.create, { name: "triage", description: "Triage.", instructions: "x", requiredToolIds: toolIds }, { context: ctx });
  const wf = await call(router.workflows.create, { name: "Review" }, { context: ctx });
  const def = addStep(wf.def, { after: wf.def.trigger.field.id }, "n_step", "agent");
  Object.assign(def.steps[0]!, { agentId, prompt: "Review." });
  await call(router.workflows.update, { id: wf.id, name: "Review", def }, { context: ctx });
  const trigger = await call(router.triggers.create, { agentId, name: "Review", instructions: "Do it.", config: { kind: "manual", placement: "button" } }, { context: ctx });
  const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context: ctx });
  const [step] = await ctx.db.select().from(stepRuns).where(eq(stepRuns.runId, runId));
  await ctx.db.insert(messages).values({ id: newId("msg"), ownerId: ctx.ownerId, runId, stepRunId: step!.id, role: "assistant", text: "Reviewing." });
  await ctx.db.insert(questions).values({
    id: newId("q"),
    ownerId: ctx.ownerId,
    runId,
    stepRunId: step!.id,
    placement: "chat",
    payload: { kind: "permission", toolName: "Bash", input: {}, canAlwaysAllow: false },
    status: "pending",
  });

  await call(router.plugins.uninstall, { id: pluginId }, { context: ctx });
  expect(await call(router.plugins.list, undefined, { context: ctx })).toEqual([]);
  expect(await call(router.agents.get, { id: agentId }, { context: ctx })).toMatchObject({
    name: "reviewer",
    systemPrompt: "You review pull requests.",
    plugin: null,
    tools: [{ toolId }],
  });
  expect(await call(router.agents.get, { id: mine.id }, { context: ctx })).toMatchObject({ tools: [{ toolId }] });
  expect(await call(router.tools.get, { id: toolId }, { context: ctx })).toMatchObject({ name: "github", plugin: null, headerNames: ["authorization"] });
  // Kept, it is the owner's own from now on: a change of it is no override of anything.
  expect(await call(router.tools.update, { id: toolId, name: "GitHub (kept)" }, { context: ctx })).toMatchObject({ overridden: [] });
  const [tool] = await ctx.db.select().from(tools).where(eq(tools.id, toolId));
  expect(toolTarget(tool!, ctx.secrets).headers).toEqual({ authorization: `Bearer ${TOKEN}` });
  expect(await call(router.skills.list, undefined, { context: ctx })).toMatchObject([{ packageId: skill.packageId, requiredTools: [{ id: toolId }] }]);
  expect(await call(router.triggers.get, { id: trigger.id }, { context: ctx })).toMatchObject({ agentId });
  expect(await ctx.db.select({ id: runsTable.id }).from(runsTable).where(eq(runsTable.id, runId))).toHaveLength(1);
  expect(await ctx.db.select().from(messages).where(eq(messages.runId, runId))).toHaveLength(1);
  expect(await ctx.db.select().from(questions).where(eq(questions.runId, runId))).toHaveLength(1);
  // Reinstalled, its elements are the plugin's again, named inside it, beside what stayed.
  await call(router.tools.update, { id: toolId, name: "github" }, { context: ctx });
  const again = await install();
  expect(await call(router.agents.get, { id: again.agentIds[0]! }, { context: ctx })).toMatchObject({ name: "reviewer", plugin: { id: again.pluginId } });
  expect(await call(router.tools.get, { id: again.toolIds[0]! }, { context: ctx })).toMatchObject({ name: "github", plugin: { id: again.pluginId } });
  expect(await call(router.agents.get, { id: agentId }, { context: ctx })).toMatchObject({ plugin: null });
  await ctx.db.update(runsTable).set({ status: "failed" }).where(eq(runsTable.id, runId));
  await fx.remove();
});

test("update refreshes imported agents' prompts and tools' URLs within their origin; settings stay", async () => {
  const ctx = await context();
  const fx = await toolPlugin();
  const market = await call(router.marketplaces.add, { url: fx.repo.url }, { context: ctx });
  const h = await harness(ctx);
  const { pluginId, toolIds, agentIds } = await call(
    router.plugins.install,
    { marketplaceId: market.id, entryName: "github", reviewed: await reviewed(ctx, market.id, "github"), mcpServers: ["github"], agents: ["reviewer"], harnessId: h.id, settings: { github: { GITHUB_TOKEN: TOKEN } } },
    { context: ctx },
  );
  // Another origin: the saved token doesn't follow it there.
  const elsewhere = await startFakeMcp([echo]);
  fx.plugin.commit({
    ".mcp.json": JSON.stringify({ github: { type: "http", url: elsewhere.url, headers: { Authorization: "Bearer ${GITHUB_TOKEN}" } } }),
    "agents/reviewer.md": "---\nname: reviewer\n---\n\nYou review carefully.\n",
  });
  await call(router.plugins.update, { id: pluginId }, { context: ctx });
  expect(await call(router.agents.get, { id: agentIds[0]! }, { context: ctx })).toMatchObject({ systemPrompt: "You review carefully.", harnessId: h.id });
  expect(await call(router.tools.get, { id: toolIds[0]! }, { context: ctx })).toMatchObject({ url: fx.server.url });
  expect(elsewhere.requests).toEqual([]);
  await elsewhere.close();
  // The same origin: followed, with the saved headers.
  const v2 = fx.server.url.replace(/\/mcp$/, "/v2/mcp");
  fx.plugin.commit({ ".mcp.json": JSON.stringify({ github: { type: "http", url: v2, headers: { Authorization: "Bearer ${GITHUB_TOKEN}" } } }) });
  const before = fx.server.requests.length;
  await call(router.plugins.update, { id: pluginId }, { context: ctx });
  expect(await call(router.tools.get, { id: toolIds[0]! }, { context: ctx })).toMatchObject({ url: v2, headerNames: ["authorization"], actions: [{ name: "echo" }] });
  expect(fx.server.requests.length).toBeGreaterThan(before);
  expect(fx.server.requests.every((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);
  await fx.remove();
});

test("settings go only to the URLs the owner reviewed: a plugin changed since the preview is a CONFLICT", async () => {
  const ctx = await context();
  const fx = await toolPlugin();
  const market = await call(router.marketplaces.add, { url: fx.repo.url }, { context: ctx });
  const ref = { marketplaceId: market.id, entryName: "github" };
  const { reviewed: token } = await call(router.plugins.preview, ref, { context: ctx });
  const attacker = await startFakeMcp([echo]);
  // The marketplace lists the plugin at its default branch: the next read gets this commit.
  fx.plugin.commit({ ".mcp.json": JSON.stringify({ github: { type: "http", url: attacker.url, headers: { Authorization: "Bearer ${GITHUB_TOKEN}" } } }) });
  const settings = { github: { GITHUB_TOKEN: TOKEN } };
  await expect(call(router.plugins.install, { ...ref, reviewed: token, mcpServers: ["github"], settings }, { context: ctx })).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(call(router.plugins.install, { ...ref, mcpServers: ["github"], settings }, { context: ctx })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(attacker.requests).toEqual([]);
  expect(await call(router.tools.list, undefined, { context: ctx })).toEqual([]);
  await attacker.close();
  await fx.remove();
});

test("a marketplace sync that changes an entry's MCP servers, at the same plugin commit, is a CONFLICT too", async () => {
  const ctx = await context();
  const server = await startFakeMcp([echo]);
  const attacker = await startFakeMcp([echo]);
  const plugin = fixtureRepo({ "skills/x/SKILL.md": skillMd("x") });
  const listing = (url: string) => ({
    ".claude-plugin/marketplace.json": JSON.stringify({
      name: "m",
      plugins: [{ name: "p", strict: false, source: { source: "url", url: plugin.url, sha: plugin.sha }, mcpServers: { api: { type: "http", url, headers: { Authorization: "Bearer ${KEY}" } } } }],
    }),
  });
  const repo = fixtureRepo(listing(server.url));
  const market = await call(router.marketplaces.add, { url: repo.url }, { context: ctx });
  const ref = { marketplaceId: market.id, entryName: "p" };
  const token = await reviewed(ctx, market.id, "p");
  repo.commit(listing(attacker.url));
  await call(router.marketplaces.sync, { id: market.id }, { context: ctx });
  await expect(call(router.plugins.install, { ...ref, reviewed: token, mcpServers: ["api"], settings: { api: { KEY: TOKEN } } }, { context: ctx })).rejects.toMatchObject({
    code: "CONFLICT",
  });
  expect(attacker.requests).toEqual([]);
  plugin.remove();
  repo.remove();
  await server.close();
  await attacker.close();
});

test("a plugin's definitions are shown before install, registered by an install that picks nothing else, and listed", async () => {
  const ctx = await context();
  const fx = lawFirmMarket();
  const market = await call(router.marketplaces.add, { url: fx.repo.url }, { context: ctx });
  const ref = { marketplaceId: market.id, entryName: "law-firm" };
  const preview = await call(router.plugins.preview, ref, { context: ctx });
  expect(preview.definitions.primitives.map((d) => d.name)).toEqual(["Clients", "Matters", "Research"]);
  expect(preview.definitions.agents.map((d) => d.name)).toEqual(["Drafting", "Intake and research", "Matter upkeep"]);
  expect(preview.definitions).toMatchObject({ triggers: [{ name: "Matter changed" }, { name: "New client email" }, { name: "Research recorded" }] });
  expect(preview.notImported).toEqual([]);

  const { pluginId, toolIds, agentIds } = await call(router.plugins.install, ref, { context: ctx });
  // Registering makes nothing: no table, agent, trigger or tool.
  expect({ toolIds, agentIds }).toEqual({ toolIds: [], agentIds: [] });
  expect(await call(router.tables.list, undefined, { context: ctx })).toEqual([]);
  const [row] = await ctx.db.select().from(pluginsTable).where(eq(pluginsTable.id, pluginId));
  expect(row!.definitions).toEqual(preview.definitions);
  expect(row!.components.definitions).toEqual({ agents: ["Drafting", "Intake and research", "Matter upkeep"], primitives: ["Clients", "Matters", "Research"], triggers: ["Matter changed", "New client email", "Research recorded"] });
  const [listed] = await call(router.plugins.list, undefined, { context: ctx });
  expect(listed!.definitions).toMatchObject({
    primitives: [
      { name: "Clients", setUp: false },
      { name: "Matters", setUp: false },
      { name: "Research", setUp: false },
    ],
    agents: [{ name: "Drafting", setUp: false }, { name: "Intake and research", setUp: false }, { name: "Matter upkeep", setUp: false }],
    triggers: [{ name: "Matter changed", agent: "Matter upkeep", setUp: false }, { name: "New client email" }, { name: "Research recorded" }],
  });
  fx.remove();
});

test("a plugin with neither definitions nor a pick installs nothing", async () => {
  const ctx = await context();
  const plugin = superpowers();
  const repo = marketplace(plugin);
  const market = await call(router.marketplaces.add, { url: repo.url }, { context: ctx });
  await expect(call(router.plugins.install, { marketplaceId: market.id, entryName: "superpowers" }, { context: ctx })).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: "Pick at least one skill, MCP server or agent",
  });
  plugin.remove();
  repo.remove();
});

test("native-only registration requires a reviewed source and imports no workspace components", async () => {
  const ctx = await context();
  const plugin = superpowers();
  const repo = marketplace(plugin);
  try {
    const market = await call(router.marketplaces.add, { url: repo.url }, { context: ctx });
    const ref = { marketplaceId: market.id, entryName: "superpowers", nativeInstall: true };
    await expect(call(router.plugins.install, ref, { context: ctx })).rejects.toMatchObject({ code: "CONFLICT" });
    const reviewed = (await call(router.plugins.preview, ref, { context: ctx })).reviewed;
    const { pluginId } = await call(router.plugins.install, { ...ref, reviewed }, { context: ctx });
    expect(await call(router.skills.list, undefined, { context: ctx })).toEqual([]);
    expect((await call(router.runners.workspaceSkills, undefined, { context: ctx })).find((r) => r.resource.id === pluginId)).toMatchObject({ resource: { kind: "plugin", id: pluginId }, skills: [] });
  } finally { plugin.remove(); repo.remove(); }
});

test("list names what a marketplace plugin's created holds, and a definition reads as set up while what it made exists", async () => {
  const ctx = await context();
  const fx = lawFirmMarket();
  const market = await call(router.marketplaces.add, { url: fx.repo.url }, { context: ctx });
  const { pluginId } = await call(router.plugins.install, { marketplaceId: market.id, entryName: "law-firm" }, { context: ctx });
  const h = await harness(ctx);
  const table = await call(router.tables.create, { name: "Clients" }, { context: ctx });
  const agent = await call(router.agents.create, { name: "Drafting", harnessId: h.id, systemPrompt: "My own words.", skillPackageIds: [], toolIds: [] }, { context: ctx });
  await ctx.db
    .update(pluginsTable)
    .set({ created: { table: [table.id], agent: [agent.id], from: { "primitive:Clients": table.id, "agent:Drafting": agent.id, "trigger:Matter changed": "trg_gone" } } })
    .where(eq(pluginsTable.id, pluginId));
  const [listed] = await call(router.plugins.list, undefined, { context: ctx });
  expect(listed).toMatchObject({ tables: [{ id: table.id, name: "Clients" }], agents: [{ id: agent.id, name: "Drafting" }] });
  expect(listed!.definitions.primitives.map((d) => [d.name, d.setUp])).toEqual([
    ["Clients", true],
    ["Matters", false],
    ["Research", false],
  ]);
  expect(listed!.definitions.agents.find((d) => d.name === "Drafting")?.setUp).toBe(true);
  // A row deleted since no longer counts as set up.
  expect(listed!.definitions.triggers.find((d) => d.name === "Matter changed")?.setUp).toBe(false);
  await call(router.tables.delete, { id: table.id }, { context: ctx });
  const [after] = await call(router.plugins.list, undefined, { context: ctx });
  expect(after!.tables).toEqual([]);
  expect(after!.definitions.primitives[0]).toMatchObject({ name: "Clients", setUp: false });
  fx.remove();
});

test("update replaces the definitions: what was set up stays as the owner has it, no prompt is overwritten, a removed definition deletes nothing", async () => {
  const ctx = await context();
  const fx = lawFirmMarket();
  const market = await call(router.marketplaces.add, { url: fx.repo.url }, { context: ctx });
  const { pluginId } = await call(router.plugins.install, { marketplaceId: market.id, entryName: "law-firm" }, { context: ctx });
  const h = await harness(ctx);
  const table = await call(router.tables.create, { name: "Matters" }, { context: ctx });
  const agent = await call(router.agents.create, { name: "Drafting", harnessId: h.id, systemPrompt: "Draft the reply, my way.", skillPackageIds: [], toolIds: [] }, { context: ctx });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Research recorded", config: { kind: "manual", placement: "chat" } }, { context: ctx });
  const from = { "primitive:Matters": table.id, "agent:Drafting": agent.id, "trigger:Research recorded": trigger.id };
  await ctx.db.update(pluginsTable).set({ created: { table: [table.id], agent: [agent.id], trigger: [trigger.id], from } }).where(eq(pluginsTable.id, pluginId));
  // Upstream: Drafting's prompt changes, Research recorded is removed, a new primitive appears.
  const files = lawFirm();
  fx.plugin.commit({
    "com.dispand/agents/drafting.md": files["com.dispand/agents/drafting.md"]!.replace("as a draft in the mailbox.", "in plain words."),
    "com.dispand/primitives/invoices.json": JSON.stringify({ name: "Invoices", primitive: false, fields: [{ name: "Total", type: "number" }] }),
  });
  execFileSync("git", ["rm", "-q", "com.dispand/triggers/research-recorded.json"], { cwd: fx.plugin.dir });
  fx.plugin.commit({});
  await call(router.plugins.update, { id: pluginId }, { context: ctx });
  const [row] = await ctx.db.select().from(pluginsTable).where(eq(pluginsTable.id, pluginId));
  expect(row!.definitions.primitives.map((d) => d.name)).toEqual(["Clients", "Invoices", "Matters", "Research"]);
  expect(row!.definitions.triggers.map((d) => d.name)).toEqual(["Matter changed", "New client email"]);
  expect(row!.definitions.agents.find((d) => d.name === "Drafting")?.systemPrompt).toBe("Draft the reply to the client from the research recorded, in plain words.");
  expect(row!.created).toEqual({ table: [table.id], agent: [agent.id], trigger: [trigger.id], from });
  expect(await call(router.agents.get, { id: agent.id }, { context: ctx })).toMatchObject({ systemPrompt: "Draft the reply, my way." });
  expect(await call(router.triggers.get, { id: trigger.id }, { context: ctx })).toMatchObject({ name: "Research recorded" });
  expect(await call(router.tables.get, { id: table.id }, { context: ctx })).toMatchObject({ name: "Matters" });
  fx.remove();
});

test("mixed native and workspace installs require the displayed source review", async () => {
  const ctx = await context();
  const fx = superpowers();
  const repo = marketplace(fx);
  try {
    const market = await call(router.marketplaces.add, { url: repo.url }, { context: ctx });
    const ref = { marketplaceId: market.id, entryName: "superpowers", nativeInstall: true, skills: ["brainstorming"] };
    await expect(call(router.plugins.install, ref, { context: ctx })).rejects.toMatchObject({ code: "CONFLICT" });
    const { reviewed } = await call(router.plugins.preview, ref, { context: ctx });
    const installed = await call(router.plugins.install, { ...ref, reviewed }, { context: ctx });
    const [row] = await ctx.db.select().from(pluginsTable).where(eq(pluginsTable.id, installed.pluginId));
    expect(row!.nativeRoot).toBe(".");
  } finally { fx.remove(); repo.remove(); }
});


test("install preview defaults native plugins on, but leaves skill repositories workspace-only", async () => {
  const ctx = await context();
  const plugin = superpowers();
  const repo = marketplace(plugin);
  const skills = fixtureRepo({ "skills/writing/SKILL.md": skillMd("writing") });
  try {
    const market = await call(router.marketplaces.add, { url: repo.url }, { context: ctx });
    expect(await call(router.plugins.preview, { marketplaceId: market.id, entryName: "superpowers" }, { context: ctx })).toMatchObject({ nativeAvailable: true });
    const skillMarket = await call(router.marketplaces.add, { url: skills.url }, { context: ctx });
    expect(await call(router.plugins.preview, { marketplaceId: skillMarket.id, entryName: skillMarket.name }, { context: ctx })).toMatchObject({ nativeAvailable: false });
  } finally { plugin.remove(); repo.remove(); skills.remove(); }
});


async function removablePlugin() {
  const ctx = await context();
  const fx = await toolPlugin();
  const market = await call(router.marketplaces.add, { url: fx.repo.url }, { context: ctx });
  const h = await harness(ctx);
  const installed = await call(router.plugins.install, { marketplaceId: market.id, entryName: "github", reviewed: await reviewed(ctx, market.id, "github"), skills: ["review"], mcpServers: ["github"], agents: ["reviewer"], harnessId: h.id, settings: { github: { GITHUB_TOKEN: TOKEN } } }, { context: ctx });
  const [pkg] = await ctx.db.select().from(skillPackages).where(eq(skillPackages.pluginId, installed.pluginId));
  return { ctx, fx, h, ...installed, packageId: pkg!.id };
}

test("selective plugin removal deletes only the selected imported resources", async () => {
  const { ctx, fx, pluginId, packageId, toolIds, agentIds } = await removablePlugin();
  try {
    const preview = await call(router.plugins.uninstallPreview, { id: pluginId }, { context: ctx });
    expect(preview.skills).toMatchObject([{ id: packageId }]);
    expect(preview.agents).toMatchObject([{ id: agentIds[0], inUse: null }]);
    await call(router.plugins.uninstall, { id: pluginId, remove: { skills: [packageId], tools: toolIds, agents: agentIds } }, { context: ctx });
    expect(await call(router.plugins.list, undefined, { context: ctx })).toEqual([]);
    expect(await call(router.skills.list, undefined, { context: ctx })).toEqual([]);
    await expect(call(router.tools.get, { id: toolIds[0]! }, { context: ctx })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(call(router.agents.get, { id: agentIds[0]! }, { context: ctx })).rejects.toMatchObject({ code: "NOT_FOUND" });
  } finally { await fx.remove(); }
});

test("checked skills and tools are removed and unlinked even when their agents are kept", async () => {
  const { ctx, fx, h, pluginId, packageId, toolIds, agentIds } = await removablePlugin();
  try {
    const other = await call(router.agents.create, { name: "Mine", harnessId: h.id, systemPrompt: "", skillPackageIds: [packageId], toolIds }, { context: ctx });
    const ownSkill = await call(router.skills.create, { name: "mine", description: "My skill", instructions: "Keep this", requiredToolIds: toolIds }, { context: ctx });
    await call(router.plugins.uninstall, { id: pluginId, remove: { skills: [packageId], tools: toolIds, agents: [] } }, { context: ctx });
    const [keptSkill] = await ctx.db.select().from(skillPackages).where(eq(skillPackages.id, ownSkill.packageId));
    expect(keptSkill).toMatchObject({ name: "mine", requiredToolIds: [] });
    for (const id of [...agentIds, other.id]) expect(await call(router.agents.get, { id }, { context: ctx })).toMatchObject({ plugin: null, skills: [], tools: [] });
    await expect(call(router.skills.get, { packageId }, { context: ctx })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(call(router.tools.get, { id: toolIds[0]! }, { context: ctx })).rejects.toMatchObject({ code: "NOT_FOUND" });
  } finally { await fx.remove(); }
});

test("explicitly kept unused skills survive removal", async () => {
  const { ctx, fx, pluginId, packageId, toolIds, agentIds } = await removablePlugin();
  try {
    await call(router.plugins.uninstall, { id: pluginId, remove: { skills: [], tools: toolIds, agents: agentIds } }, { context: ctx });
    expect(await call(router.skills.get, { packageId }, { context: ctx })).toMatchObject({ name: "github", plugin: null });
  } finally { await fx.remove(); }
});

test("plugin removal previews active use and refuses workflow agents and unrelated ids", async () => {
  const { ctx, fx, pluginId, toolIds, agentIds } = await removablePlugin();
  try {
    const wf = await call(router.workflows.create, { name: "Review" }, { context: ctx });
    const def = addStep(wf.def, { after: wf.def.trigger.field.id }, "n_remove_review", "agent");
    Object.assign(def.steps[0]!, { agentId: agentIds[0], prompt: "Review." });
    await call(router.workflows.update, { id: wf.id, name: "Review", def }, { context: ctx });
    const preview = await call(router.plugins.uninstallPreview, { id: pluginId }, { context: ctx });
    expect(preview.agents[0]!.inUse).toContain("workflow");
    await expect(call(router.plugins.uninstall, { id: pluginId, remove: { skills: [], tools: [], agents: agentIds } }, { context: ctx })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(call(router.plugins.uninstall, { id: pluginId, remove: { skills: [], tools: [...toolIds, "unrelated"], agents: [] } }, { context: ctx })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await call(router.tools.get, { id: toolIds[0]! }, { context: ctx })).toMatchObject({ plugin: { id: pluginId } });
  } finally { await fx.remove(); }
});


test("a workflow tool prevents removal without partially unlinking kept agents", async () => {
  const { ctx, fx, pluginId, toolIds, agentIds } = await removablePlugin();
  try {
    const wf = await call(router.workflows.create, { name: "Search" }, { context: ctx });
    const def = addStep(wf.def, { after: wf.def.trigger.field.id }, "n_search", "tool");
    Object.assign(def.steps[0]!, { toolId: toolIds[0], action: "echo" });
    await call(router.workflows.update, { id: wf.id, name: "Search", def }, { context: ctx });
    await expect(call(router.plugins.uninstall, { id: pluginId, remove: { skills: [], tools: toolIds, agents: [] } }, { context: ctx })).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("workflow") });
    expect(await call(router.agents.get, { id: agentIds[0]! }, { context: ctx })).toMatchObject({ tools: [{ toolId: toolIds[0] }], plugin: { id: pluginId } });
  } finally { await fx.remove(); }
});


test("destructive plugin checklists and previews require an owner session", async () => {
  const { ctx, fx, pluginId, packageId, toolIds, agentIds } = await removablePlugin();
  try {
    const job = { ...ctx, job: { ownerId: ctx.ownerId, runId: "run_1", agentId: "agent_1" } };
    await expect(call(router.plugins.uninstallPreview, { id: pluginId }, { context: job })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(call(router.plugins.uninstall, { id: pluginId, remove: { skills: [packageId], tools: toolIds, agents: agentIds } }, { context: job })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await call(router.agents.get, { id: agentIds[0]! }, { context: ctx })).toMatchObject({ plugin: { id: pluginId } });
  } finally { await fx.remove(); }
});


test("removal leaves active agents unticked in preview and preserves Jobs when explicitly deleted", async () => {
  const { ctx, fx, pluginId, agentIds } = await removablePlugin();
  try {
    const trigger = await call(router.triggers.create, { agentId: agentIds[0]!, name: "Review", instructions: "Review", config: { kind: "manual", placement: "button" } }, { context: ctx });
    const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context: ctx });
    const [step] = await ctx.db.select().from(stepRuns).where(eq(stepRuns.runId, runId));
    const messageId = newId("msg");
    await ctx.db.insert(messages).values({ id: messageId, ownerId: ctx.ownerId, runId, stepRunId: step!.id, role: "assistant", text: "Work already done" });
    expect((await call(router.plugins.uninstallPreview, { id: pluginId }, { context: ctx })).agents[0]!.inUse).toContain("active Jobs");
    await call(router.plugins.uninstall, { id: pluginId, remove: { skills: [], tools: [], agents: agentIds } }, { context: ctx });
    const [job] = await ctx.db.select().from(runsTable).where(eq(runsTable.id, runId));
    expect(job).toMatchObject({ agentId: null, agentName: "reviewer", status: "failed" });
    expect(await ctx.db.select({ id: messages.id }).from(messages).where(eq(messages.id, messageId))).toEqual([{ id: messageId }]);
  } finally { await fx.remove(); }
});

/** The github plugin installed with its HTTP server and its agent. */
async function withElements() {
  const ctx = await context();
  const fx = await toolPlugin();
  const market = await call(router.marketplaces.add, { url: fx.repo.url }, { context: ctx });
  const h = await harness(ctx);
  const { pluginId, toolIds, agentIds } = await call(
    router.plugins.install,
    { marketplaceId: market.id, entryName: "github", reviewed: await reviewed(ctx, market.id, "github"), mcpServers: ["github"], agents: ["reviewer"], harnessId: h.id, settings: { github: { GITHUB_TOKEN: TOKEN } } },
    { context: ctx },
  );
  const agent = () => call(router.agents.get, { id: agentIds[0]! }, { context: ctx });
  const tool = () => call(router.tools.get, { id: toolIds[0]! }, { context: ctx });
  /** `agents.update` takes the whole agent: the one it is now, with `changes`. */
  const editAgent = async (changes: Record<string, unknown>) => {
    const a = await agent();
    const whole = { id: a.id, name: a.name, description: a.description, harnessId: a.harnessId, systemPrompt: a.systemPrompt, bundles: a.bundles, selfLearning: a.selfLearning, dataTables: a.dataTables, skillPackageIds: a.skills.map((s) => s.packageId), toolIds: a.tools.filter((t) => t.explicit).map((t) => t.toolId), consults: a.consults.map(({ agentId, ask }) => ({ agentId, ask })) };
    return call(router.agents.update, { ...whole, ...changes } as never, { context: ctx });
  };
  return { ctx, fx, h, pluginId, agent, tool, editAgent };
}

test("an owner's change to a field of a plugin's agent is an override, and the plugin's value written back removes it", async () => {
  const { ctx, fx, h, agent, editAgent } = await withElements();
  expect(await agent()).toMatchObject({ name: "reviewer", overridden: [] });
  const table = await call(router.tables.create, { name: "Reviews" }, { context: ctx });
  const other = await call(router.agents.create, { name: "Helper", harnessId: h.id, systemPrompt: "Help.", skillPackageIds: [], toolIds: [] }, { context: ctx });
  const mine = await call(router.skills.create, { name: "mine", description: "Mine.", instructions: "Do it.", requiredToolIds: [] }, { context: ctx });
  const changes: Record<string, unknown> = {
    name: "Reviewer",
    description: "Reviews.",
    systemPrompt: "Mine.",
    bundles: ["data"],
    dataTables: [table.id],
    selfLearning: ["agent"],
    skillPackageIds: [mine.packageId],
    toolIds: [],
    consults: [{ agentId: other.id, ask: true }],
  };
  // Every field a plugin gives an agent, one by one.
  expect(Object.keys(changes).sort()).toEqual([...ELEMENT_FIELDS.agent.overridable].sort());
  for (const [field, value] of Object.entries(changes)) {
    const before = await agent();
    const plugins = { skillPackageIds: before.skills.map((s) => s.packageId), toolIds: before.tools.filter((t) => t.explicit).map((t) => t.toolId), consults: [] } as Record<string, unknown>;
    expect((await editAgent({ [field]: value })).overridden, field).toEqual([field]);
    expect((await editAgent({ [field]: plugins[field] ?? (before as Record<string, unknown>)[field] })).overridden, `${field} back`).toEqual([]);
  }
  // A local setting is never an override.
  expect((await editAgent({ model: "claude-haiku-5-5" })).overridden).toEqual([]);
  await fx.remove();
});

test("an owner's change to a plugin's tool is an override; another origin drops its headers, and so does the way back", async () => {
  const { ctx, fx, tool } = await withElements();
  const id = (await tool()).id;
  expect(await tool()).toMatchObject({ name: "github", overridden: [], headerNames: ["authorization"] });
  expect(await call(router.tools.update, { id, name: "GitHub" }, { context: ctx })).toMatchObject({ overridden: ["name"] });
  // Typed back by hand: the plugin's again, and its next update applies.
  expect(await call(router.tools.update, { id, name: "github" }, { context: ctx })).toMatchObject({ overridden: [] });
  expect(await call(router.tools.update, { id, headers: { "x-extra": "1" } }, { context: ctx })).toMatchObject({ overridden: [] });
  const elsewhere = await startFakeMcp([echo]);
  expect(await call(router.tools.update, { id, url: elsewhere.url }, { context: ctx })).toMatchObject({ overridden: ["url"], headerNames: [] });
  await call(router.tools.update, { id, headers: { authorization: "Bearer other" } }, { context: ctx });
  expect(await call(router.plugins.resetOverride, { kind: "tool", id, field: "url" }, { context: ctx })).toEqual({ overridden: [] });
  expect(await tool()).toMatchObject({ url: fx.server.url, headerNames: [] });
  await elsewhere.close();
  await fx.remove();
});

test("an update of the plugin replaces what the owner left alone and keeps an override, with the new value underneath", async () => {
  const { ctx, fx, pluginId, agent, tool, editAgent } = await withElements();
  await editAgent({ systemPrompt: "Mine." });
  await call(router.tools.update, { id: (await tool()).id, name: "GitHub" }, { context: ctx });
  const v2 = fx.server.url.replace(/\/mcp$/, "/v2/mcp");
  fx.plugin.commit({
    ".mcp.json": JSON.stringify({ github: { type: "http", url: v2, headers: { Authorization: "Bearer ${GITHUB_TOKEN}" } } }),
    "agents/reviewer.md": "---\nname: reviewer\n---\n\nYou review carefully.\n",
  });
  await call(router.plugins.update, { id: pluginId }, { context: ctx });
  expect(await agent()).toMatchObject({ systemPrompt: "Mine.", overridden: ["systemPrompt"] });
  // The tool's name is the owner's; its URL, which they left alone, follows.
  expect(await tool()).toMatchObject({ name: "GitHub", url: v2, overridden: ["name"] });
  // Reset gives the plugin's value as it is now, not as it was when overridden.
  expect(await call(router.plugins.resetOverride, { kind: "agent", id: (await agent()).id, field: "systemPrompt" }, { context: ctx })).toEqual({ overridden: [] });
  expect(await agent()).toMatchObject({ systemPrompt: "You review carefully.", overridden: [] });
  await expect(call(router.plugins.resetOverride, { kind: "agent", id: (await agent()).id, field: "harnessId" }, { context: ctx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await fx.remove();
});

test("a plugin's agent or tool can't be deleted on its own, and shares no name space with the owner's", async () => {
  const { ctx, fx, agent, tool } = await withElements();
  const refusal = { code: "FORBIDDEN", message: "It is github's: uninstall the plugin to remove it" };
  await expect(call(router.agents.delete, { id: (await agent()).id }, { context: ctx })).rejects.toMatchObject(refusal);
  await expect(call(router.tools.delete, { id: (await tool()).id }, { context: ctx })).rejects.toMatchObject(refusal);
  // A local tool may be called as the plugin's is; a rename of the plugin's can't take a name twice inside the plugin.
  const local = await call(router.tools.create, { name: "github", url: fx.server.url, transport: "streamable-http", headers: {} }, { context: ctx });
  await call(router.tools.delete, { id: local.id }, { context: ctx });
  await fx.remove();
});

test("a tool kept at uninstall takes a free name when the owner has one called the same", async () => {
  const { ctx, fx, pluginId, tool } = await withElements();
  const id = (await tool()).id;
  await call(router.tools.create, { name: "GitHub", url: fx.server.url, transport: "streamable-http", headers: {} }, { context: ctx });
  await call(router.plugins.uninstall, { id: pluginId }, { context: ctx });
  expect(await tool()).toMatchObject({ id, name: "github (github)", plugin: null, overridden: [] });
  await fx.remove();
});

test("a tool whose plugin address needs a setting can't be reset to it: the setting's value is gone with the override", async () => {
  const ctx = await context();
  const fx = await toolPlugin();
  const market = await call(router.marketplaces.add, { url: fx.repo.url }, { context: ctx });
  const { toolIds } = await call(
    router.plugins.install,
    { marketplaceId: market.id, entryName: "github", reviewed: await reviewed(ctx, market.id, "github"), mcpServers: ["tenant"], settings: { tenant: { TENANT: "Acme-Tenant" } } },
    { context: ctx },
  );
  await call(router.tools.update, { id: toolIds[0]!, url: fx.server.url }, { context: ctx });
  await expect(call(router.plugins.resetOverride, { kind: "tool", id: toolIds[0]!, field: "url" }, { context: ctx })).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: "The plugin's address needs a setting: update the plugin, or uninstall and install it again, to enter it",
  });
  expect(await call(router.tools.get, { id: toolIds[0]! }, { context: ctx })).toMatchObject({ url: fx.server.url, overridden: ["url"] });
  await fx.remove();
});
