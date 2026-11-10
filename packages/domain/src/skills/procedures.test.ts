import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { marketplaces, plugins, skillFiles, skillPackages, tools, user } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";

const b64 = (s: string) => Buffer.from(s).toString("base64");
const hello = { name: "hello-check", description: "Answers HELLO-CHECK.", instructions: "# Hello\n\nAnswer HELLO-CHECK.", requiredToolIds: [] };

test("create writes SKILL.md with name and description", async () => {
  const context = await ownerContext();
  const { packageId } = await call(router.skills.create, { ...hello, files: [{ path: "scripts/run.sh", base64: b64("echo hi\n") }] }, { context });
  const got = await call(router.skills.get, { packageId }, { context });
  expect(got.skillMd).toBe("---\nname: hello-check\ndescription: Answers HELLO-CHECK.\n---\n\n# Hello\n\nAnswer HELLO-CHECK.\n");
  expect(got.instructions).toBe("# Hello\n\nAnswer HELLO-CHECK.\n");
  expect(got.files).toEqual([
    { path: "hello-check/SKILL.md", size: Buffer.byteLength(got.skillMd!) },
    { path: "hello-check/scripts/run.sh", size: 8 },
  ]);
  expect(got).toMatchObject({ packageId, name: "hello-check", description: "Answers HELLO-CHECK.", plugin: null, requiredTools: [] });
  expect(await call(router.skills.list, undefined, { context })).toEqual([
    {
      packageId,
      name: "hello-check",
      description: "Answers HELLO-CHECK.",
      plugin: null,
      skills: [{ name: "hello-check", description: "Answers HELLO-CHECK." }],
      requiredTools: [],
    },
  ]);
  const [stored] = await context.db.select().from(skillFiles).where(eq(skillFiles.path, "hello-check/scripts/run.sh"));
  expect(Buffer.from(stored!.content).toString()).toBe("echo hi\n");
});

test("update rewrites SKILL.md, keeps the files unless new ones are given, and follows a rename", async () => {
  const context = await ownerContext();
  const { packageId } = await call(router.skills.create, { ...hello, files: [{ path: "a.txt", base64: b64("A") }] }, { context });
  await call(router.skills.update, { ...hello, packageId, name: "hello", description: "Says hello." }, { context });
  let got = await call(router.skills.get, { packageId }, { context });
  expect(got.files.map((f) => f.path)).toEqual(["hello/SKILL.md", "hello/a.txt"]);
  expect(got.skills).toEqual([{ name: "hello", description: "Says hello." }]);
  expect(got.skillMd).toMatch(/^---\nname: hello\ndescription: Says hello.\n---\n/);

  await call(router.skills.update, { ...hello, packageId, files: [{ path: "b/c.txt", base64: b64("C") }] }, { context });
  got = await call(router.skills.get, { packageId }, { context });
  expect(got.files.map((f) => f.path)).toEqual(["hello-check/SKILL.md", "hello-check/b/c.txt"]);
});

test("names are unique per owner and follow the skill name rule", async () => {
  const context = await ownerContext();
  await call(router.skills.create, hello, { context });
  await expect(call(router.skills.create, hello, { context })).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(call(router.skills.create, { ...hello, name: "Hello Check" }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("an unsafe or clashing file is BAD_REQUEST naming it", async () => {
  const context = await ownerContext();
  for (const path of ["../x", "/etc/x", "a\\b", ".claude/settings.json", "SKILL.md", "x/.mcp.json"]) {
    await expect(call(router.skills.create, { ...hello, files: [{ path, base64: b64("x") }] }, { context }), path).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  }
  await expect(call(router.skills.create, { ...hello, files: [{ path: "x", base64: "not base64!" }] }, { context })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  expect(await call(router.skills.list, undefined, { context })).toEqual([]);
});

test("requiredToolIds of another owner is NOT_FOUND", async () => {
  const context = await ownerContext();
  await context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  await context.db.insert(tools).values({ id: "tool_other", ownerId: "user_other", name: "Eve's", kind: "http", url: "https://example.com/mcp", transport: "streamable-http" });
  await expect(call(router.skills.create, { ...hello, requiredToolIds: ["tool_other"] }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  const { packageId } = await call(router.skills.create, hello, { context });
  await expect(call(router.skills.update, { ...hello, packageId, requiredToolIds: ["tool_other"] }, { context })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

test("a package lists the tools it requires, by name", async () => {
  const context = await ownerContext();
  await context.db.insert(tools).values({ id: "tool_gh", ownerId: context.ownerId, name: "GitHub", kind: "http", url: "https://example.com/mcp", transport: "streamable-http" });
  const { packageId } = await call(router.skills.create, { ...hello, requiredToolIds: ["tool_gh"] }, { context });
  expect((await call(router.skills.get, { packageId }, { context })).requiredTools).toEqual([{ id: "tool_gh", name: "GitHub" }]);
});

test("another owner's package is NOT_FOUND", async () => {
  const context = await ownerContext();
  await context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  await context.db.insert(skillPackages).values({ id: "skillpkg_other", ownerId: "user_other", name: "hello-check", description: "x" });
  expect(await call(router.skills.list, undefined, { context })).toEqual([]);
  await expect(call(router.skills.get, { packageId: "skillpkg_other" }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(router.skills.update, { ...hello, packageId: "skillpkg_other" }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(router.skills.delete, { packageId: "skillpkg_other" }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  // The same name is free for this owner.
  await call(router.skills.create, hello, { context });
});

test("a plugin's package can't be edited or deleted here", async () => {
  const context = await ownerContext();
  const [market] = await context.db.select().from(marketplaces);
  await context.db.insert(plugins).values({
    id: "plugin_1",
    ownerId: context.ownerId,
    name: "superpowers",
    description: "x",
    marketplaceId: market!.id,
    entryName: "superpowers",
    url: "https://example.com/x.git",
    sha: "a".repeat(40),
    components: { skills: [], mcpServers: [], agents: [] },
  });
  await context.db.insert(skillPackages).values({ id: "skillpkg_plugin", ownerId: context.ownerId, name: "superpowers", description: "x", pluginId: "plugin_1" });
  await expect(call(router.skills.update, { ...hello, packageId: "skillpkg_plugin" }, { context })).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(call(router.skills.delete, { packageId: "skillpkg_plugin" }, { context })).rejects.toMatchObject({
    code: "FORBIDDEN",
    message: expect.stringMatching(/Remove the plugin/),
  });
});

test("delete removes the package and its files", async () => {
  const context = await ownerContext();
  const { packageId } = await call(router.skills.create, hello, { context });
  await call(router.skills.delete, { packageId }, { context });
  expect(await call(router.skills.list, undefined, { context })).toEqual([]);
  expect(await context.db.select().from(skillFiles)).toEqual([]);
  await expect(call(router.skills.get, { packageId }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
});
