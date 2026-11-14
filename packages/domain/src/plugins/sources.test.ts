import { call } from "@orpc/server";
import { afterEach, expect, test, vi } from "vitest";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";
import { fakeSite, fixtureRepo, installReviewed, skillMd, updatePlugin } from "./test-support.ts";

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
  expect(preview.notImported).toEqual([{ component: "hook", name: "hooks", reason: "Hooks run commands on the machine" }]);
  await installReviewed(ctx, { marketplaceId: market.id, entryName: name, skills: ["plain-words"] });
  const [pkg] = await call(router.skills.list, undefined, { context: ctx });
  expect(pkg).toMatchObject({ skills: [{ name: "plain-words" }], plugin: { name } });
  repo.remove();
});

test("a repository with neither a marketplace file nor skills/ is refused", async () => {
  const ctx = await context();
  const repo = fixtureRepo({ "README.md": "hi" });
  await expect(call(router.marketplaces.add, { url: repo.url }, { context: ctx })).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: "This repository has neither a .claude-plugin/marketplace.json nor a skills/ folder",
  });
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
  expect(synced).toMatchObject({ plugins: 1, syncError: expect.stringContaining("answered 404") });
});

test("a skill site must be https", async () => {
  const ctx = await context();
  await expect(call(router.marketplaces.add, { url: "http://skills.example", kind: "well-known" }, { context: ctx })).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: "Use an https:// address",
  });
});
