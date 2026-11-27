import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { inEnglish } from "./test-notes.ts";
import { afterEach, expect, test, vi } from "vitest";
import { skillFiles } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";
import { startFakeMcp } from "../tools/test-server.ts";
import { fakeSite, type FixtureFile, fixtureRepo, installReviewed, removePlugin, skillMd, updatePlugin } from "./test-support.ts";

afterEach(() => vi.unstubAllGlobals());

async function context() {
  return { ...(await ownerContext()), gitFileUrls: true };
}

test("a Git repository of skills (no marketplace file) is one entry, its skills/ installed like a plugin's", async () => {
  const ctx = await context();
  const repo = fixtureRepo({
    "skills/plain-words/SKILL.md": skillMd("plain-words"),
    "skills/plain-words/examples.md": "Short.",
    "skills/review/SKILL.md": skillMd("review"),
    "hooks/hooks.json": "{}",
  });
  const market = await call(router.marketplaces.add, { url: repo.url }, { context: ctx });
  const name = repo.dir.split("/").pop()!;
  expect(market).toMatchObject({ kind: "skill-repo", name, plugins: 1 });
  const [found] = await call(router.plugins.discover, { query: name }, { context: ctx });
  expect(found!.entry).toMatchObject({ name, source: { supported: true } });
  const preview = await call(router.plugins.preview, { marketplaceId: market.id, entryName: name }, { context: ctx });
  expect(preview.skills.map((s) => s.name)).toEqual(["plain-words", "review"]);
  expect(inEnglish(preview.notImported)).toEqual([{ component: "hook", name: "hooks", reason: "Hooks run commands on the machine" }]);
  await installReviewed(ctx, { marketplaceId: market.id, entryName: name, skills: ["plain-words"] });
  const [pkg] = await call(router.skills.list, undefined, { context: ctx });
  expect(pkg).toMatchObject({ skills: [{ name: "plain-words" }], plugin: { name } });
  repo.remove();
});

test("a repository with none of a marketplace file, skills/, a plugin manifest or a SKILL.md is refused", async () => {
  const ctx = await context();
  // A link is no file: the checkout holds none, so a linked manifest or SKILL.md is no shape either.
  const shapes: Record<string, FixtureFile>[] = [
    { "README.md": "hi" },
    { ".claude-plugin/plugin.json": { symlink: "/etc/hostname" } },
    { "SKILL.md": { symlink: "/etc/hostname" } },
    { ".claude-plugin": { symlink: "/etc" } },
  ];
  for (const files of shapes) {
    const repo = fixtureRepo(files);
    await expect(call(router.marketplaces.add, { url: repo.url }, { context: ctx })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { key: "marketplaceFile.neither" },
      message: "This repository has none of a .claude-plugin/marketplace.json, a skills/ folder, a .claude-plugin/plugin.json or a SKILL.md.",
    });
    repo.remove();
  }
});

test("a repository that is one plugin is one installable entry, its root; sync, update and removal work", async () => {
  const ctx = await context();
  const server = await startFakeMcp([{ name: "echo", description: "Says it back", inputSchema: { type: "object" }, call: () => ({ content: [] }) }]);
  const manifest = (version: string) => JSON.stringify({ name: "case-tools", description: "Tools for cases.", version });
  const repo = fixtureRepo({ ".claude-plugin/plugin.json": manifest("1.0.0"), ".mcp.json": JSON.stringify({ cases: { type: "http", url: server.url } }) });
  const market = await call(router.marketplaces.add, { url: repo.url }, { context: ctx });
  expect(market).toMatchObject({ kind: "marketplace", name: "case-tools", plugins: 1 });
  const found = (await call(router.plugins.discover, {}, { context: ctx })).filter((r) => r.marketplaceId === market.id);
  expect(found.map((r) => r.entry)).toEqual([{ name: "case-tools", description: "Tools for cases.", version: "1.0.0", source: { supported: true } }]);
  const ref = { marketplaceId: market.id, entryName: "case-tools" };
  expect((await call(router.plugins.preview, ref, { context: ctx })).mcpServers.map((s) => s.name)).toEqual(["cases"]);
  const { pluginId } = await installReviewed(ctx, { ...ref, mcpServers: ["cases"] });

  const sha = repo.commit({ ".claude-plugin/plugin.json": manifest("1.1.0") });
  expect(await call(router.marketplaces.sync, { id: market.id }, { context: ctx })).toMatchObject({ kind: "marketplace", plugins: 1, syncError: null });
  const [synced] = (await call(router.plugins.discover, {}, { context: ctx })).filter((r) => r.marketplaceId === market.id);
  expect(synced!.entry.version).toBe("1.1.0");
  expect(await updatePlugin(ctx, pluginId)).toMatchObject({ sha });

  await removePlugin(ctx, pluginId);
  await call(router.marketplaces.remove, { id: market.id }, { context: ctx });
  expect((await call(router.marketplaces.list, undefined, { context: ctx })).map((m) => m.id)).not.toContain(market.id);
  repo.remove();
  await server.close();
});

test("a one-plugin repository whose manifest is too large is named after the repository, the manifest unread", async () => {
  const ctx = await context();
  const repo = fixtureRepo({
    ".claude-plugin/plugin.json": JSON.stringify({ name: "big", description: "x".repeat(1024 * 1024) }),
    ".mcp.json": "{}",
  });
  const market = await call(router.marketplaces.add, { url: repo.url }, { context: ctx });
  const name = repo.dir.split("/").pop()!;
  expect(market).toMatchObject({ kind: "marketplace", name, plugins: 1 });
  const [found] = (await call(router.plugins.discover, {}, { context: ctx })).filter((r) => r.marketplaceId === market.id);
  expect(found!.entry).toEqual({ name, description: "", version: null, source: { supported: true } });
  repo.remove();
});

test("a repository that is one skill is one entry, that skill with every file but .git and links; sync, update and removal work", async () => {
  const ctx = await context();
  const repo = fixtureRepo({
    "SKILL.md": skillMd("plain-words"),
    "examples.md": "Short.",
    "host.md": { symlink: "/etc/hostname" },
    ".claude/settings.json": "{}",
  });
  const market = await call(router.marketplaces.add, { url: repo.url }, { context: ctx });
  const name = repo.dir.split("/").pop()!;
  expect(market).toMatchObject({ kind: "skill-repo", name, plugins: 1 });
  const [found] = (await call(router.plugins.discover, {}, { context: ctx })).filter((r) => r.marketplaceId === market.id);
  expect(found!.entry).toMatchObject({ name, description: `A skill from ${repo.url}`, source: { supported: true } });
  const ref = { marketplaceId: market.id, entryName: name };
  const preview = await call(router.plugins.preview, ref, { context: ctx });
  expect(preview.skills).toEqual([{ name: "plain-words", description: "Does plain-words." }]);
  expect(inEnglish(preview.notImported)).toEqual(
    expect.arrayContaining([
      { component: "file", name: "host.md", reason: "A symbolic link" },
      { component: "file", name: "plain-words/.claude", reason: "Its path isn't allowed in a skill" },
    ]),
  );
  const { pluginId } = await installReviewed(ctx, { ...ref, skills: ["plain-words"] });
  const [pkg] = await call(router.skills.list, undefined, { context: ctx });
  expect(pkg).toMatchObject({ skills: [{ name: "plain-words" }], plugin: { name } });
  const files = await ctx.db.select({ path: skillFiles.path }).from(skillFiles).where(eq(skillFiles.packageId, pkg!.packageId));
  expect(files.map((f) => f.path).sort()).toEqual(["plain-words/SKILL.md", "plain-words/examples.md"]);

  const sha = repo.commit({ "SKILL.md": skillMd("plain-words", "Says it plainly.") });
  expect(await call(router.marketplaces.sync, { id: market.id }, { context: ctx })).toMatchObject({ kind: "skill-repo", plugins: 1, syncError: null });
  expect(await updatePlugin(ctx, pluginId)).toMatchObject({ sha });
  expect((await call(router.skills.list, undefined, { context: ctx }))[0]!.skills).toEqual([{ name: "plain-words", description: "Says it plainly." }]);

  await removePlugin(ctx, pluginId);
  await call(router.marketplaces.remove, { id: market.id }, { context: ctx });
  expect((await call(router.marketplaces.list, undefined, { context: ctx })).map((m) => m.id)).not.toContain(market.id);
  repo.remove();
});

test("a skill site is one entry; install downloads its skills, update sees changes", async () => {
  const ctx = await context();
  const site = "https://skills.example";
  const routes: Record<string, string> = {
    [`${site}/.well-known/skills/index.json`]: JSON.stringify({ skills: [{ name: "greet", description: "Greets.", files: ["SKILL.md"] }] }),
    [`${site}/.well-known/skills/greet/SKILL.md`]: skillMd("greet"),
  };
  fakeSite(routes);
  const market = await call(router.marketplaces.add, { url: site, kind: "well-known" }, { context: ctx });
  expect(market).toMatchObject({ kind: "well-known", name: "skills.example", url: `${site}/.well-known/skills/index.json`, plugins: 1 });
  const [found] = await call(router.plugins.discover, {}, { context: ctx }).then((all) => all.filter((r) => r.marketplaceId === market.id));
  expect(found!.entry).toMatchObject({ name: "skills.example", description: "1 skill: greet" });
  const { pluginId } = await installReviewed(ctx, { marketplaceId: market.id, entryName: "skills.example", skills: ["greet"] });
  const [installed] = await call(router.plugins.list, undefined, { context: ctx });
  expect(installed).toMatchObject({ url: `${site}/.well-known/skills/index.json`, skills: [{ name: "greet" }] });

  routes[`${site}/.well-known/skills/greet/SKILL.md`] = skillMd("greet", "Greets warmly.");
  fakeSite(routes);
  const { sha } = await updatePlugin(ctx, pluginId);
  expect(sha).not.toBe(installed!.sha);
  const [pkg] = await call(router.skills.list, undefined, { context: ctx });
  expect(pkg!.skills).toEqual([{ name: "greet", description: "Greets warmly." }]);

  fakeSite({});
  const synced = await call(router.marketplaces.sync, { id: market.id }, { context: ctx });
  expect(synced).toMatchObject({ plugins: 1, syncError: expect.stringContaining('"status":404') });
});

test("a skill site must be https", async () => {
  const ctx = await context();
  await expect(call(router.marketplaces.add, { url: "http://skills.example", kind: "well-known" }, { context: ctx })).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: "Use an https:// address.",
  });
});
