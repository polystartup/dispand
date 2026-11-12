import { call } from "@orpc/server";
import { desc, eq } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { agentTools, pollItems, polls, proposals, tools as toolsTable, triggers } from "../db/schema.ts";
import { Engine } from "../engine/engine.ts";
import type { HarnessAdapter } from "../engine/harness.ts";
import { NEEDS_SIGN_IN_POLL, Scheduler } from "../engine/scheduler.ts";
import { callPlatformTool, type JobIdentity } from "../platform/call.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import { CATALOG, type CatalogEntry } from "./catalog.ts";
import { InstalledTools } from "./executor.ts";
import { createMcpConnector } from "./mcp.ts";
import { pollCaller } from "./poll.ts";
import { startFakeMcp } from "./test-server.ts";

// Catalog tools added through a proposal, before their owner signs in: no credential, the
// actions their entry declares, flags and polls set at once, and nothing called until the sign-in.

const MINUTE = 60_000;
const KEY = "fake-key-1";

const adapter: HarnessAdapter = { start: async () => true, send: async () => true, answer: async () => true, stop: async () => true };

/** A catalog entry for the test only, at `url`, removed when the test ends. */
function fakeEntry(url: string): CatalogEntry {
  const entry: CatalogEntry = {
    id: "fake-mail",
    name: "Fake mail",
    description: "A test entry.",
    kind: "http",
    url,
    transport: "streamable-http",
    headers: [{ name: "authorization", template: "Bearer {apiKey}" }],
    settings: [{ key: "apiKey", label: "API key", help: "The key." }],
    actions: [
      { name: "list_mail", description: "List mail", readOnly: true, pollable: true },
      { name: "read_mail", description: "Read one", readOnly: true },
      { name: "send_mail", description: "Send mail" },
    ],
    unasked: ["list_mail", "read_mail"],
    pollable: ["list_mail"],
  };
  (CATALOG as CatalogEntry[]).push(entry);
  onTestFinished(() => void (CATALOG as CatalogEntry[]).splice(CATALOG.indexOf(entry), 1));
  return entry;
}

/** The owner, a clock, a scheduler polling over HTTP, and the Assistant-like agent's Job with `configure`. */
async function world() {
  let now = new Date("2026-11-12T09:00:00Z");
  const time = { now: () => now, add: (ms: number) => (now = new Date(now.getTime() + ms)) };
  const context = { ...(await ownerContext()), tools: createMcpConnector(), now: time.now };
  const engine = new Engine(context.db, adapter);
  onTestFinished(() => engine.stop());
  const scheduler = new Scheduler(context.db, engine, { now: time.now, polls: pollCaller(new InstalledTools(context.db, context.secrets, context.tools), { call: () => Promise.reject(new Error("no runner")) }) });
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const builder = await call(router.agents.create, { name: "Builder", harnessId: harness.id, systemPrompt: "", bundles: ["configure"] }, { context });
  const go = await call(router.triggers.create, { agentId: builder.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
  const job: JobIdentity = { runId: (await call(router.jobs.start, { triggerId: go.id }, { context })).runId, ownerId: context.ownerId, agentId: builder.id };
  const tool = (name: string, input: unknown) => callPlatformTool(context, job, name, input);
  /** Proposes `items`, approves them as the owner's answer does, and applies them. */
  const approveAndApply = async (items: unknown[]) => {
    const proposed = await tool("propose", { items });
    if (!proposed.ok) throw new Error((proposed as { error: string }).error);
    const proposalId = (proposed.output as { proposalId: string }).proposalId;
    await context.db.update(proposals).set({ status: "approved" }).where(eq(proposals.id, proposalId));
    const applied = await tool("proposal_apply", { proposalId });
    if (!applied.ok) throw new Error(applied.error);
    return applied.output as { items: { outcome: string; id?: string }[] };
  };
  const lastPoll = async (triggerId: string) => (await context.db.select().from(polls).where(eq(polls.triggerId, triggerId)).orderBy(desc(polls.at)).limit(1))[0];
  return { context, time, scheduler, harness, tool, approveAndApply, lastPoll };
}

test("one approved proposal adds a catalog tool, sets a flag and makes a poll before sign-in; the poll waits for the key, then runs its baseline", async () => {
  const listed = { calls: 0 };
  const mcp = await startFakeMcp(
    [
      { name: "list_mail", annotations: { readOnlyHint: true }, call: () => (listed.calls++, { content: [{ type: "text", text: JSON.stringify({ items: [{ id: "m1" }, { id: "m2" }] }) }] }) },
      { name: "read_mail", annotations: { readOnlyHint: true } },
      { name: "send_mail" },
      { name: "archive_mail" },
    ],
    "streamable-http",
    { apiKey: KEY },
  );
  onTestFinished(mcp.close);
  fakeEntry(mcp.url);
  const w = await world();

  const applied = await w.approveAndApply([
    { tool: "tools_add_from_catalog", input: { catalogId: "fake-mail" } },
    { tool: "agents_create", input: { name: "Clerk", harnessId: w.harness.id, systemPrompt: "", toolIds: [{ $item: 0 }] } },
    { tool: "agents_set_tool_ask", input: { agentId: { $item: 1 }, toolId: { $item: 0 }, action: "read_mail", ask: true } },
    {
      tool: "triggers_create",
      input: { agentId: { $item: 1 }, name: "New mail", instructions: "Read it.", config: { kind: "poll", toolId: { $item: 0 }, action: "list_mail", arguments: {}, itemsPath: "items", idPath: "id", interval: 300 } },
    },
  ]);
  expect(applied.items.map((i) => i.outcome)).toEqual(["made", "made", "made", "made"]);
  const [toolId, agentId, , triggerId] = applied.items.map((i) => i.id!) as [string, string, string, string];

  // No credential, the entry's actions, and no request to its server yet.
  const tool = await call(router.tools.get, { id: toolId }, { context: w.context });
  expect(tool).toMatchObject({ catalogId: "fake-mail", headerNames: [], signIn: "needed", signInPath: `/settings/tools?tool=${toolId}`, actionsError: null });
  expect(tool.actions.map((a) => a.name)).toEqual(["list_mail", "read_mail", "send_mail"]);
  expect(mcp.requests).toHaveLength(0);
  // The entry's default, then the approved flag: list runs unasked, read and send ask.
  const [chosen] = await w.context.db.select({ unasked: agentTools.unasked }).from(agentTools).where(eq(agentTools.agentId, agentId));
  expect(chosen!.unasked).toEqual(["list_mail"]);
  const triggerRow = (await w.context.db.select().from(triggers).where(eq(triggers.id, triggerId)))[0]!;
  expect(triggerRow).toMatchObject({ kind: "poll", agentId });

  // Due: the poll calls nothing and says it needs sign-in.
  w.time.add(6 * MINUTE);
  await w.scheduler.poll();
  expect(await w.lastPoll(triggerId)).toMatchObject({ status: "skipped", message: NEEDS_SIGN_IN_POLL });
  expect(mcp.requests).toHaveLength(0);
  expect(listed.calls).toBe(0);

  // The owner fills the key: the tool lists the server's actions and is connected.
  const filled = await call(router.tools.fillSettings, { id: toolId, settings: { apiKey: KEY } }, { context: w.context });
  expect(filled).toMatchObject({ signIn: "connected", headerNames: ["authorization"], actionsError: null });
  expect(filled.actions.map((a) => a.name)).toEqual(["list_mail", "read_mail", "send_mail", "archive_mail"]);

  // The next poll is its baseline: it records what exists and starts nothing.
  w.time.add(6 * MINUTE);
  expect(await w.scheduler.poll()).toEqual([]);
  expect(await w.lastPoll(triggerId)).toMatchObject({ status: "baseline", found: 2 });
  expect(listed.calls).toBe(1);
  expect((await w.context.db.select().from(pollItems).where(eq(pollItems.triggerId, triggerId))).map((i) => i.itemId).sort()).toEqual(["m1", "m2"]);
});

test("a Job's call of a catalog tool waiting for its key goes nowhere", async () => {
  const mcp = await startFakeMcp([{ name: "list_mail", annotations: { readOnlyHint: true } }], "streamable-http", { apiKey: KEY });
  onTestFinished(mcp.close);
  fakeEntry(mcp.url);
  const w = await world();
  const tool = await call(router.tools.addFromCatalog, { catalogId: "fake-mail" }, { context: w.context });
  const [row] = await w.context.db.select().from(toolsTable).where(eq(toolsTable.id, tool.id));
  const called = await new InstalledTools(w.context.db, w.context.secrets, w.context.tools).call(row!, "list_mail", {}, AbortSignal.timeout(5000));
  expect(called).toMatchObject({ ok: false, error: expect.stringMatching(/needs sign-in/) });
  // Refresh says why, and keeps the declared actions.
  const refreshed = await call(router.tools.refresh, { id: tool.id }, { context: w.context });
  expect(refreshed).toMatchObject({ actionsError: expect.stringMatching(/needs sign-in/), signIn: "needed" });
  expect(refreshed.actions.map((a) => a.name)).toEqual(["list_mail", "read_mail", "send_mail"]);
  expect(mcp.requests).toHaveLength(0);
});

test("a tool added by URL whose listing fails is not pollable until it lists", async () => {
  const mcp = await startFakeMcp([{ name: "list_mail", annotations: { readOnlyHint: true } }], "streamable-http", { apiKey: KEY });
  onTestFinished(mcp.close);
  const w = await world();
  const applied = await w.approveAndApply([
    { tool: "tools_add", input: { name: "Mail", url: mcp.url, transport: "streamable-http" } },
    { tool: "agents_create", input: { name: "Clerk", harnessId: w.harness.id, systemPrompt: "", toolIds: [{ $item: 0 }] } },
    {
      tool: "triggers_create",
      input: { agentId: { $item: 1 }, name: "New mail", instructions: "Read it.", config: { kind: "poll", toolId: { $item: 0 }, action: "list_mail", arguments: {}, itemsPath: "items", idPath: "id", interval: 300 } },
    },
  ]);
  // The tool and the agent are made; the poll is refused: the tool has no action to poll yet.
  expect(applied.items.map((i) => i.outcome)).toEqual(["made", "made", "refused"]);
  const items = (await w.context.db.select().from(proposals))[0]!.items;
  expect(items.map((i) => i.failed === true)).toEqual([false, false, true]);
  const tool = await call(router.tools.get, { id: items[0]!.createdId! }, { context: w.context });
  expect(tool).toMatchObject({ actions: [], signIn: "none", actionsError: expect.any(String) });
});

test("through a proposal, the Firecrawl entry needs sign-in with no header; filled, it is connected", async () => {
  const w = await world();
  // Its real server is never reached here: the listing after the key is the connector's fake.
  const listings: string[] = [];
  w.context.tools = {
    ...w.context.tools,
    listActions: async (target) => {
      listings.push(target.headers.authorization ?? "none");
      return [{ name: "firecrawl_scrape", description: "Scrape", inputSchema: { type: "object" } }];
    },
  };
  const applied = await w.approveAndApply([{ tool: "tools_add_from_catalog", input: { catalogId: "firecrawl" } }]);
  const toolId = applied.items[0]!.id!;
  expect(await call(router.tools.get, { id: toolId }, { context: w.context })).toMatchObject({ name: "Firecrawl", headerNames: [], signIn: "needed", auth: "none" });
  expect(listings).toEqual([]);
  await expect(call(router.tools.fillSettings, { id: toolId, settings: {} }, { context: w.context })).rejects.toThrow(/API key is required/);
  const filled = await call(router.tools.fillSettings, { id: toolId, settings: { apiKey: "fc-test" } }, { context: w.context });
  expect(filled).toMatchObject({ signIn: "connected", auth: "headers", headerNames: ["authorization"] });
  expect(listings).toEqual(["Bearer fc-test"]);
  // The key is never shown back.
  expect(JSON.stringify(await call(router.tools.list, {}, { context: w.context }))).not.toContain("fc-test");
});

test("a runner entry is refused when proposed, with the snippet its owner adds on their machine", async () => {
  const w = await world();
  const refused = await w.tool("propose", { items: [{ tool: "tools_add_from_catalog", input: { catalogId: "fetch" } }] });
  expect(refused).toMatchObject({ ok: false });
  expect((refused as { error: string }).error).toMatch(/runs on the owner's machine.*mcpServers.*"fetch"/s);
  expect((refused as { error: string }).error).toContain("mcp-server-fetch");
  const unknown = await w.tool("propose", { items: [{ tool: "tools_add_from_catalog", input: { catalogId: "nothing" } }] });
  expect((unknown as { error: string }).error).toMatch(/Not in the catalog/);
});

test("tools_catalog lists the entries with their actions' default flags", async () => {
  const w = await world();
  const listed = await w.tool("tools_catalog", {});
  if (!listed.ok) throw new Error(listed.error);
  const firecrawl = (listed.output as { id: string; actions?: { name: string; readOnly?: boolean }[] }[]).find((e) => e.id === "firecrawl")!;
  expect(firecrawl.actions!.map((a) => a.name)).toContain("firecrawl_scrape");
});

test("every HTTP entry declares its actions, and what runs unasked or may be polled is one of them", () => {
  for (const e of CATALOG) {
    if (e.kind !== "http") continue;
    const names = e.actions.map((a) => a.name);
    expect(names.length, e.id).toBeGreaterThan(0);
    expect(new Set(names).size, e.id).toBe(names.length);
    for (const name of [...(e.unasked ?? []), ...(e.pollable ?? [])]) expect(names, e.id).toContain(name);
    if (e.poll) expect(names, e.id).toContain(e.poll.action);
  }
});
