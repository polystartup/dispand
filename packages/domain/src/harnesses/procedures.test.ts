import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import { harnesses, runners, user } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { revokeRunner } from "../runners/pairing.ts";
import { ownerContext } from "../runners/test-support.ts";
import { SecretError } from "../secrets.ts";
import { loadCloudHarness } from "./cloud.ts";

async function setup() {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  return { context, runnerId };
}

const fields = { name: "Claude on Workstation", kind: "claude-code", permissionMode: "default" } as const;

test("harness create, get, list, update, delete", async () => {
  const { context, runnerId } = await setup();
  const created = await call(router.harnesses.create, { ...fields, runnerId }, { context });
  expect(created).toEqual({
    id: expect.stringMatching(/^harness_/),
    ownerId: context.ownerId,
    type: "cli",
    runnerId,
    ...fields,
  });
  expect(await call(router.harnesses.get, { id: created.id }, { context })).toEqual(created);
  expect(await call(router.harnesses.list, undefined, { context })).toEqual([created]);

  const updated = await call(
    router.harnesses.update,
    { ...fields, id: created.id, runnerId, name: "Renamed", model: "opus" },
    { context },
  );
  expect(updated).toMatchObject({ id: created.id, name: "Renamed", model: "opus" });
  expect(updated).not.toHaveProperty("cwd");
  expect(await call(router.harnesses.get, { id: created.id }, { context })).toEqual(updated);

  await call(router.harnesses.delete, { id: created.id }, { context });
  expect(await call(router.harnesses.list, undefined, { context })).toEqual([]);
  await expect(call(router.harnesses.get, { id: created.id }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("codex harness with acceptEdits refused", async () => {
  const { context, runnerId } = await setup();
  const codex = { name: "Codex on Workstation", runnerId, kind: "codex" } as const;
  for (const permissionMode of ["acceptEdits", "plan"] as const) {
    await expect(call(router.harnesses.create, { ...codex, permissionMode } as never, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }
  const created = await call(router.harnesses.create, { ...codex, permissionMode: "bypassPermissions" }, { context });
  expect(created).toMatchObject({ type: "cli", kind: "codex", permissionMode: "bypassPermissions" });
  expect(await call(router.harnesses.get, { id: created.id }, { context })).toEqual(created);
  await expect(
    call(router.harnesses.update, { ...codex, id: created.id, permissionMode: "acceptEdits" } as never, { context }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  // A Claude Code harness moved to Codex takes Codex's modes.
  const claude = await call(router.harnesses.create, { ...fields, runnerId, permissionMode: "acceptEdits" }, { context });
  await expect(call(router.harnesses.update, { ...codex, id: claude.id, permissionMode: "acceptEdits" } as never, { context })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  expect(await call(router.harnesses.update, { ...codex, id: claude.id, permissionMode: "default" }, { context })).toMatchObject({ kind: "codex" });
});

test("harness delete refused while used by an agent", async () => {
  const { context, runnerId } = await setup();
  const harness = await call(router.harnesses.create, { ...fields, runnerId }, { context });
  const agent = await call(router.agents.create, { name: "Writer", harnessId: harness.id, systemPrompt: "" }, { context });
  await expect(call(router.harnesses.delete, { id: harness.id }, { context })).rejects.toMatchObject({ code: "CONFLICT" });
  await call(router.agents.delete, { id: agent.id }, { context });
  await call(router.harnesses.delete, { id: harness.id }, { context });
});

test("cannot reference another owner's runner", async () => {
  const { context, runnerId } = await setup();
  await context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  await context.db.insert(runners).values({ id: "runner_other", ownerId: "user_other", name: "Eve's" });
  await expect(
    call(router.harnesses.create, { ...fields, runnerId: "runner_other" }, { context }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  const harness = await call(router.harnesses.create, { ...fields, runnerId }, { context });
  await expect(
    call(router.harnesses.update, { ...fields, id: harness.id, runnerId: "runner_other" }, { context }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("a revoked runner cannot be used for a new harness", async () => {
  const { context, runnerId } = await setup();
  await call(router.runners.revoke, { runnerId }, { context });
  await expect(call(router.harnesses.create, { ...fields, runnerId }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("a harness on a revoked runner can still be edited, but not moved to another revoked runner", async () => {
  const { context, runnerId } = await setup();
  const other = await call(router.runners.create, { name: "Other" }, { context });
  const harness = await call(router.harnesses.create, { ...fields, runnerId }, { context });
  // runners.revoke refuses a runner a harness uses; this one was revoked before it did.
  expect(await revokeRunner(context.db, context.ownerId, runnerId)).toBe(true);
  await call(router.runners.revoke, { runnerId: other.runnerId }, { context });
  const renamed = await call(router.harnesses.update, { ...fields, id: harness.id, runnerId, name: "Renamed" }, { context });
  expect(renamed.name).toBe("Renamed");
  await expect(
    call(router.harnesses.update, { ...fields, id: harness.id, runnerId: other.runnerId }, { context }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("other owners' harnesses are invisible", async () => {
  const { context, runnerId } = await setup();
  const harness = await call(router.harnesses.create, { ...fields, runnerId }, { context });
  await context.db.insert(user).values({ id: "user_other", name: "Eve", email: "eve@example.com" });
  await context.db.update(harnesses).set({ ownerId: "user_other" });
  expect(await call(router.harnesses.list, undefined, { context })).toEqual([]);
  await expect(call(router.harnesses.get, { id: harness.id }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(call(router.harnesses.delete, { id: harness.id }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("harness procedures require the owner's session", async () => {
  const context = { ...(await ownerContext()), headers: new Headers() };
  for (const procedure of [
    call(router.harnesses.list, undefined, { context }),
    call(router.harnesses.get, { id: "x" }, { context }),
    call(router.harnesses.create, { ...fields, runnerId: "x" }, { context }),
    call(router.harnesses.update, { ...fields, id: "x", runnerId: "x" }, { context }),
    call(router.harnesses.delete, { id: "x" }, { context }),
  ]) {
    await expect(procedure).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  }
});

// --- Cloud harnesses ---

const KEY = "sk-test-cloud-0123456789abcdef";
const cloud = { type: "cloud", name: "Claude API", kind: "anthropic", apiKey: KEY, model: "claude-opus-5-5", systemPrompt: "Be brief." } as const;

test("no procedure returns the key", async () => {
  const { context } = await setup();
  const outputs: unknown[] = [];
  const created = await call(router.harnesses.create, cloud, { context });
  outputs.push(created);
  expect(created).toEqual({
    id: expect.stringMatching(/^harness_/),
    ownerId: context.ownerId,
    name: "Claude API",
    type: "cloud",
    kind: "anthropic",
    model: "claude-opus-5-5",
    systemPrompt: "Be brief.",
    apiKeySet: true,
  });
  outputs.push(await call(router.harnesses.get, { id: created.id }, { context }));
  outputs.push(await call(router.harnesses.list, undefined, { context }));
  outputs.push(await call(router.harnesses.update, { ...cloud, id: created.id, apiKey: `${KEY}-new`, effort: "high" as const }, { context }));
  outputs.push(await call(router.harnesses.update, { ...cloud, id: created.id, apiKey: undefined, maxTokens: 1000 }, { context }));
  for (const output of outputs) {
    const json = JSON.stringify(output);
    expect(json).not.toContain(KEY);
    expect(json).not.toContain("v1.");
  }
  // Stored sealed, bound to its row.
  const [row] = await context.db.select().from(harnesses).where(eq(harnesses.id, created.id));
  expect(row!.apiKeySealed).toMatch(/^v1\./);
  expect(row!.apiKeySealed).not.toContain(KEY);
});

test("update without apiKey keeps it; an empty one clears it", async () => {
  const { context } = await setup();
  const created = await call(router.harnesses.create, cloud, { context });
  const renamed = await call(router.harnesses.update, { ...cloud, apiKey: undefined, id: created.id, name: "Renamed" }, { context });
  expect(renamed).toMatchObject({ name: "Renamed", apiKeySet: true });
  expect(await loadCloudHarness(context.db, context.secrets, context.ownerId, created.id)).toEqual({
    kind: "anthropic",
    model: "claude-opus-5-5",
    systemPrompt: "Be brief.",
    apiKey: KEY,
  });
  // Anthropic needs a key: clearing it is refused.
  await expect(call(router.harnesses.update, { ...cloud, id: created.id, apiKey: "" }, { context })).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: "An API key is required",
  });

  const local = { type: "cloud", name: "Local", kind: "openai-compatible", baseUrl: "https://llm.example.test/v1", apiKey: KEY, model: "qwen", systemPrompt: "" } as const;
  const compatible = await call(router.harnesses.create, local, { context });
  const cleared = await call(router.harnesses.update, { ...local, id: compatible.id, apiKey: "" }, { context });
  expect(cleared.type === "cloud" && cleared.apiKeySet).toBe(false);
  expect(await loadCloudHarness(context.db, context.secrets, context.ownerId, compatible.id)).not.toHaveProperty("apiKey");
});

test("a sealed key copied to another harness doesn't open", async () => {
  const { context } = await setup();
  const a = await call(router.harnesses.create, cloud, { context });
  const b = await call(router.harnesses.create, { ...cloud, name: "Other", apiKey: "sk-other-0123456789" }, { context });
  const [rowA] = await context.db.select().from(harnesses).where(eq(harnesses.id, a.id));
  await context.db.update(harnesses).set({ apiKeySealed: rowA!.apiKeySealed }).where(eq(harnesses.id, b.id));
  await expect(loadCloudHarness(context.db, context.secrets, context.ownerId, b.id)).rejects.toThrow(SecretError);
});

test("an http base URL with a key is refused", async () => {
  const { context } = await setup();
  const local = { type: "cloud", name: "Local", kind: "openai-compatible", baseUrl: "http://llm.example.test/v1", model: "qwen", systemPrompt: "" } as const;
  await expect(call(router.harnesses.create, { ...local, apiKey: KEY }, { context })).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: "A key is only sent to an https:// base URL",
  });
  // Without a key, or to this machine, it is allowed.
  const plain = await call(router.harnesses.create, local, { context });
  expect(plain).toMatchObject({ baseUrl: "http://llm.example.test/v1", apiKeySet: false });
  await call(router.harnesses.create, { ...local, baseUrl: "http://127.0.0.1:8080/v1", apiKey: KEY }, { context });
  // Adding a key later to the http harness is refused too.
  await expect(call(router.harnesses.update, { ...local, id: plain.id, apiKey: KEY }, { context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("temperature on anthropic is refused; cloud rules", async () => {
  const { context } = await setup();
  await expect(call(router.harnesses.create, { ...cloud, temperature: 0.2 }, { context })).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: "Temperature is only for OpenAI-compatible providers",
  });
  await expect(call(router.harnesses.create, { ...cloud, apiKey: undefined }, { context })).rejects.toMatchObject({
    message: "An API key is required",
  });
  await expect(
    call(router.harnesses.create, { ...cloud, kind: "openai-compatible", apiKey: undefined }, { context }),
  ).rejects.toMatchObject({ message: "An OpenAI-compatible provider needs a base URL" });
  const compatible = await call(
    router.harnesses.create,
    { ...cloud, kind: "openai-compatible", baseUrl: "https://llm.example.test/v1", apiKey: undefined, temperature: 0.2 },
    { context },
  );
  expect(compatible).toMatchObject({ temperature: 0.2, apiKeySet: false });
  // A harness can't switch between CLI and cloud.
  const { runnerId } = await call(router.runners.create, { name: "Box" }, { context });
  await expect(call(router.harnesses.update, { ...fields, runnerId, id: compatible.id }, { context })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
});

test("models lists a saved harness's models with its stored key, never returning it", async () => {
  const { context } = await setup();
  const created = await call(router.harnesses.create, cloud, { context });
  const seen: string[] = [];
  const fetcher = (async (url: URL, init: RequestInit) => {
    seen.push(`${url} ${(init.headers as Record<string, string>)["x-api-key"]}`);
    return Response.json({ data: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }] });
  }) as typeof fetch;
  vi.stubGlobal("fetch", fetcher);
  try {
    expect(await call(router.harnesses.models, { harnessId: created.id }, { context })).toEqual([
      { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
    ]);
  } finally {
    vi.unstubAllGlobals();
  }
  expect(seen).toEqual([`https://api.anthropic.com/v1/models?limit=1000 ${KEY}`]);
});

test("cloud harness procedures require the owner's session", async () => {
  const context = { ...(await ownerContext()), headers: new Headers() };
  await expect(call(router.harnesses.models, { harnessId: "x" }, { context })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(call(router.harnesses.create, cloud, { context })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

test("a CLI row stored without a type reads back as a CLI harness", async () => {
  const { context, runnerId } = await setup();
  await context.db.insert(harnesses).values({ id: "harness_old", ownerId: context.ownerId, name: "Old", runnerId, kind: "claude-code", permissionMode: "plan" });
  expect(await call(router.harnesses.get, { id: "harness_old" }, { context })).toEqual({
    id: "harness_old",
    ownerId: context.ownerId,
    name: "Old",
    type: "cli",
    runnerId,
    kind: "claude-code",
    permissionMode: "plan",
  });
});
