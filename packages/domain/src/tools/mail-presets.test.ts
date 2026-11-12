import { call } from "@orpc/server";
import { and, asc, eq } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import { agentTools, pollItems, runners, runs, tools, triggers } from "../db/schema.ts";
import { Engine } from "../engine/engine.ts";
import type { Harness, HarnessAdapter, StartParams } from "../engine/harness.ts";
import { Scheduler } from "../engine/scheduler.ts";
import { router } from "../rpc/router.ts";
import type { RunnerHub } from "../runners/hub.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import { TriggerConfig } from "../triggers/model.ts";
import { CATALOG, runnerSnippet } from "./catalog.ts";
import { InstalledTools } from "./executor.ts";
import { createMcpConnector } from "./mcp.ts";
import { finishToolAuthorization } from "./oauth.ts";
import { pollCaller } from "./poll.ts";
import { startFakeAuthServer } from "./test-auth-server.ts";
import { startFakeMcp, type FakeAction } from "./test-server.ts";

// The mail entries of the catalog (Gmail, Gmail on a runner, Microsoft 365) and their poll
// presets, against fake servers shaped like the real ones: never Google's or Microsoft's.

const APP = "https://dispand.test";
const MINUTE = 60_000;
const GMAIL_SCOPES = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose";
const entry = (id: string) => CATALOG.find((e) => e.id === id)!;

class FakeAdapter implements HarnessAdapter {
  starts: { harness: Harness; start: StartParams }[] = [];
  async start(harness: Harness, start: StartParams) {
    this.starts.push({ harness, start });
    return true;
  }
  async send() {
    return true;
  }
  async answer() {
    return true;
  }
  async stop() {
    return true;
  }
}

/** A clock the test moves, the owner's context on it, and schedulers that poll through `hub` (runner tools) or over HTTP. */
async function world(hub: Pick<RunnerHub, "call"> = { call: async () => Promise.reject(new Error("no runner here")) }) {
  let now = new Date("2026-11-12T09:00:00Z");
  const time = { now: () => now, add: (ms: number) => (now = new Date(now.getTime() + ms)) };
  const context = { ...(await ownerContext()), tools: createMcpConnector({ appUrl: APP }), now: time.now };
  const engine = new Engine(context.db, new FakeAdapter());
  onTestFinished(() => engine.stop());
  const polls = pollCaller(new InstalledTools(context.db, context.secrets, context.tools), hub);
  const scheduler = new Scheduler(context.db, engine, { now: time.now, polls });
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const itemsOf = (triggerId: string) =>
    context.db.select({ itemId: pollItems.itemId, status: pollItems.status }).from(pollItems).where(eq(pollItems.triggerId, triggerId)).orderBy(asc(pollItems.firstSeen), asc(pollItems.itemId));
  const jobsOf = (triggerId: string) => context.db.select().from(runs).where(eq(runs.triggerId, triggerId));
  const unasked = async (agentId: string, toolId: string) =>
    (await context.db.select({ unasked: agentTools.unasked }).from(agentTools).where(and(eq(agentTools.agentId, agentId), eq(agentTools.toolId, toolId))))[0]!.unasked;
  /** A poll trigger of `agentId` with the tool's catalog preset, as the trigger sheet fills it, made an hour before the clock's start (its first `{{lastPoll}}`). */
  const presetTrigger = async (agentId: string, toolId: string, catalogId: string) => {
    const trigger = await call(router.triggers.create, { agentId, name: "New mail", instructions: "Draft a reply.", config: { kind: "poll", toolId, interval: 300, ...entry(catalogId).poll! } }, { context });
    await context.db.update(triggers).set({ createdAt: new Date("2026-11-12T07:00:00Z") }).where(eq(triggers.id, trigger.id));
    return trigger;
  };
  return { context, time, scheduler, runnerId, harness, itemsOf, jobsOf, unasked, presetTrigger };
}

test("every preset is a poll trigger on an action its entry lets polls read and lets run unasked", () => {
  const presets = CATALOG.filter((e) => e.poll);
  expect(presets.map((e) => e.id)).toEqual(["gmail", "gmail-runner", "microsoft-365"]);
  for (const e of presets) {
    expect(TriggerConfig.safeParse({ kind: "poll", toolId: "tool_x", ...e.poll }).success).toBe(true);
    expect(e.pollable).toEqual([e.poll!.action]);
    expect(e.unasked).toContain(e.poll!.action);
  }
});

test("the runner entries start pinned servers; Microsoft 365's with its mail actions alone", () => {
  expect(JSON.parse(runnerSnippet(entry("gmail-runner") as Extract<(typeof CATALOG)[number], { kind: "runner" }>))).toEqual({
    "gmail-runner": { command: "npx", args: ["-y", "@artymclabin/gmail-mcp@1.2.3"] },
  });
  const microsoft = JSON.parse(runnerSnippet(entry("microsoft-365") as Extract<(typeof CATALOG)[number], { kind: "runner" }>)) as Record<string, { args: string[] }>;
  const args = microsoft["microsoft-365"]!.args;
  expect(args.slice(0, 2)).toEqual(["-y", "@softeria/ms-365-mcp-server@0.175.0"]);
  expect(args[2]).toBe("--enabled-tools");
  // The server reads the filter as a case-insensitive regular expression of tool names.
  const filter = new RegExp(args[3]!, "i");
  for (const name of entry("microsoft-365").unasked!) expect(filter.test(name)).toBe(true);
  for (const name of ["send-mail", "reply-mail-message", "forward-mail-message", "delete-mail-message", "list-calendar-events", "list-mail-messages-delta", "x-get-mail-message"]) {
    expect(filter.test(name)).toBe(false);
  }
});

/** Google's hosted Gmail server, as far as Dispand sees it: the actions it lists, threads by pages of `pageToken`. */
function fakeGmail(mailbox: { id: string }[], calls: Record<string, unknown>[]): FakeAction[] {
  const page = 2;
  return [
    {
      name: "search_threads",
      annotations: { readOnlyHint: true },
      call: (args) => {
        calls.push(args);
        const offset = args.pageToken === undefined ? 0 : Number(String(args.pageToken).slice("page-".length));
        const next = offset + page < mailbox.length ? { nextPageToken: `page-${offset + page}` } : {};
        const result = { threads: mailbox.slice(offset, offset + page), ...next };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      },
    },
    { name: "get_thread", annotations: { readOnlyHint: true } },
    { name: "create_draft", annotations: { readOnlyHint: false } },
    { name: "trash_thread", annotations: { readOnlyHint: false } },
    { name: "list_labels", annotations: { readOnlyHint: true } },
  ];
}

test("Gmail: an OAuth tool whose sign-in asks for reading and drafts only, offline, from a server that lists without a token; its preset polls new threads page by page", async () => {
  const w = await world();
  const as = await startFakeAuthServer({ client: { id: "google-client", secret: "google-s3cret" } });
  onTestFinished(as.close);
  const mailbox = [{ id: "t1" }, { id: "t2" }, { id: "t3" }];
  const calls: Record<string, unknown>[] = [];
  const mcp = await startFakeMcp(fakeGmail(mailbox, calls), "streamable-http", {
    // Like Google's: every Gmail scope supported, the listing open, calls behind a token.
    oauth: { authorizationServer: as.url, accepts: (t) => as.accepts(t), scopesSupported: ["https://mail.google.com/", "https://www.googleapis.com/auth/gmail.send", ...GMAIL_SCOPES.split(" ")], openListing: true },
  });
  onTestFinished(mcp.close);

  const installed = await call(router.tools.installFromCatalog, { catalogId: "gmail", settings: {} }, { context: w.context });
  if (!("tool" in installed)) throw new Error("expected a tool");
  // Nothing is fetched before it is connected.
  expect(installed.tool).toMatchObject({ name: "Gmail", url: "https://gmailmcp.googleapis.com/mcp/v1", auth: "oauth", oauthStatus: "authorize", catalogId: "gmail", actions: [] });
  const id = installed.tool.id;
  // The fake stands where Google's server is.
  await w.context.db.update(tools).set({ url: mcp.url }).where(eq(tools.id, id));

  const { url } = await call(router.tools.authorize, { id, client: { clientId: "google-client", clientSecret: "google-s3cret" } }, { context: w.context });
  const asked = new URL(url);
  expect(asked.origin).toBe(as.url);
  expect(asked.searchParams.get("scope")).toBe(GMAIL_SCOPES);
  expect(asked.searchParams.get("access_type")).toBe("offline");
  expect(asked.searchParams.get("prompt")).toBe("consent");
  expect(asked.searchParams.get("redirect_uri")).toBe(`${APP}/oauth/callback`);
  const back = new URL((await fetch(url, { redirect: "manual" })).headers.get("location")!);
  expect(await finishToolAuthorization(w.context, w.context.ownerId, back.searchParams)).toEqual({ toolId: id, ok: true });
  expect(await call(router.tools.get, { id }, { context: w.context })).toMatchObject({ oauthStatus: "connected", actions: expect.arrayContaining([expect.objectContaining({ name: "search_threads" })]) });

  // Given to an agent: the entry's flags, drafts included, trash asking.
  const agent = await call(router.agents.create, { name: "Clerk", harnessId: w.harness.id, systemPrompt: "", toolIds: [id] }, { context: w.context });
  expect((await w.unasked(agent.id, id)).sort()).toEqual(["create_draft", "get_thread", "list_labels", "search_threads"]);
  expect((await call(router.tools.pollable, { id }, { context: w.context })).filter((a) => a.pollable).map((a) => a.name)).toEqual(["search_threads"]);

  const trigger = await w.presetTrigger(agent.id, id, "gmail");
  expect(await w.scheduler.tick()).toEqual([]);
  expect(await w.itemsOf(trigger.id)).toEqual(["t1", "t2", "t3"].map((itemId) => ({ itemId, status: "baseline" })));
  // One query, walked with Google's page token; `after:` takes seconds.
  expect(calls).toEqual([
    { query: expect.stringMatching(/^in:inbox after:\d{10}$/), pageSize: 50 },
    { query: calls[0]!.query, pageSize: 50, pageToken: "page-2" },
  ]);

  mailbox.push({ id: "t4" });
  w.time.add(5 * MINUTE);
  await w.scheduler.tick();
  expect((await w.itemsOf(trigger.id)).find((i) => i.itemId === "t4")).toEqual({ itemId: "t4", status: "started" });
  expect(await w.jobsOf(trigger.id)).toHaveLength(1);
});

/** The actions the real servers list (names and read-only hints), as their runner reports them. */
const SERVER_ACTIONS: Record<string, { name: string; readOnly?: true }[]> = {
  "gmail-runner": [
    { name: "search_emails", readOnly: true },
    { name: "read_email", readOnly: true },
    { name: "download_attachment", readOnly: true },
    { name: "get_thread", readOnly: true },
    { name: "list_inbox_threads", readOnly: true },
    { name: "get_inbox_with_threads", readOnly: true },
    { name: "download_email", readOnly: true },
    { name: "send_email" },
    { name: "draft_email" },
    { name: "send_draft" },
    { name: "delete_draft" },
    { name: "update_draft" },
    { name: "reply_all" },
    { name: "list_email_labels", readOnly: true },
  ],
  "microsoft-365": [
    { name: "login" },
    { name: "list-accounts", readOnly: true },
    { name: "list-mail-folder-messages", readOnly: true },
    { name: "list-mail-messages", readOnly: true },
    { name: "get-mail-message", readOnly: true },
    { name: "read-mail-text", readOnly: true },
    { name: "list-mail-attachments", readOnly: true },
    { name: "get-mail-attachment-content", readOnly: true },
    { name: "create-reply-draft" },
  ],
};

type Mail = { id: string; receivedDateTime: string };

/**
 * A runner whose `gmail-runner` answers `list_inbox_threads` with the JSON that server writes
 * (`{ resultCount, threads: [{ threadId, … }] }`), and whose `microsoft-365` answers
 * `list-mail-folder-messages` as Graph does: oldest first from `filter`'s time, `top` a page, the
 * next page's link in `@odata.nextLink`, taken back whole as `skiptoken`.
 */
function fakeRunner(gmail: { threadId: string }[], outlook: Mail[], calls: { tool: string; arguments: Record<string, unknown> }[]): Pick<RunnerHub, "call"> {
  const text = (body: unknown) => [{ type: "text", text: JSON.stringify(body) }];
  return {
    call: async (_runnerId, msg) => {
      calls.push({ tool: msg.tool, arguments: msg.arguments });
      if (msg.tool === "gmail-runner" && msg.action === "list_inbox_threads") {
        return { type: "tool.called", requestId: msg.requestId, content: text({ resultCount: gmail.length, threads: gmail.map((t) => ({ ...t, snippet: "", messageCount: 1 })) }) };
      }
      if (msg.tool === "microsoft-365" && msg.action === "list-mail-folder-messages" && msg.arguments.mailFolderId === "inbox") {
        const since = /^receivedDateTime ge (.+)$/.exec(String(msg.arguments.filter))![1]!;
        const matching = outlook.filter((m) => m.receivedDateTime >= since).sort((a, b) => a.receivedDateTime.localeCompare(b.receivedDateTime));
        const top = Number(msg.arguments.top);
        const link = msg.arguments.skiptoken as string | undefined;
        const offset = link === undefined ? 0 : Number(new URL(link).searchParams.get("$skiptoken")!.slice("tok-".length));
        const next = offset + top < matching.length ? { "@odata.nextLink": `https://graph.example.com/v1.0/me/mailFolders/inbox/messages?$skiptoken=tok-${offset + top}` } : {};
        return { type: "tool.called", requestId: msg.requestId, content: text({ value: matching.slice(offset, offset + top), ...next }) };
      }
      return { type: "tool.called", requestId: msg.requestId, content: text({ error: "unknown" }), isError: true };
    },
  };
}

test("the runner entries: a tool set up from one keeps its entry, its flags and its poll, and its preset polls through the runner", async () => {
  const gmail = [{ threadId: "g1" }];
  const outlook: Mail[] = Array.from({ length: 30 }, (_, i) => ({ id: `o${i}`, receivedDateTime: "2026-11-12T08:00:00Z" }));
  const calls: { tool: string; arguments: Record<string, unknown> }[] = [];
  const w = await world(fakeRunner(gmail, outlook, calls));
  await w.context.db.update(runners).set({ tools: ["gmail-runner", "microsoft-365"] }).where(eq(runners.id, w.runnerId));
  w.context.hub.request = async (_id, msg) => ({
    type: "tool.discovered",
    requestId: msg.requestId,
    actions: (SERVER_ACTIONS[msg.tool] ?? []).map((a) => ({ ...a, description: "", inputSchema: { type: "object" } })),
  });
  const create = (catalogId: string) =>
    call(router.tools.create, { kind: "runner", name: entry(catalogId).name, runnerId: w.runnerId, runnerTool: catalogId, catalogId }, { context: w.context });
  // Only a runner entry can be named.
  await expect(call(router.tools.create, { kind: "runner", name: "Mail", runnerId: w.runnerId, runnerTool: "gmail-runner", catalogId: "gmail" }, { context: w.context })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  const local = await create("gmail-runner");
  const outlookTool = await create("microsoft-365");
  expect(local).toMatchObject({ catalogId: "gmail-runner" });
  expect(outlookTool).toMatchObject({ catalogId: "microsoft-365" });
  // A poll may read the preset's action only, though the servers call more of them read-only.
  for (const [tool, action] of [
    [local, "list_inbox_threads"],
    [outlookTool, "list-mail-folder-messages"],
  ] as const) {
    expect((await call(router.tools.pollable, { id: tool.id }, { context: w.context })).filter((a) => a.allowed).map((a) => a.name)).toEqual([action]);
  }

  const agent = await call(router.agents.create, { name: "Clerk", harnessId: w.harness.id, systemPrompt: "", toolIds: [local.id, outlookTool.id] }, { context: w.context });
  // Drafts run; sending, files on the machine and the server's sign-in actions ask.
  expect((await w.unasked(agent.id, local.id)).sort()).toEqual(["draft_email", "get_inbox_with_threads", "get_thread", "list_email_labels", "list_inbox_threads", "read_email", "search_emails"]);
  expect((await w.unasked(agent.id, outlookTool.id)).sort()).toEqual([
    "create-reply-draft",
    "get-mail-message",
    "list-mail-attachments",
    "list-mail-folder-messages",
    "list-mail-messages",
    "read-mail-text",
  ]);

  const gmailTrigger = await w.presetTrigger(agent.id, local.id, "gmail-runner");
  const outlookTrigger = await w.presetTrigger(agent.id, outlookTool.id, "microsoft-365");
  await w.scheduler.tick();
  expect(await w.itemsOf(gmailTrigger.id)).toEqual([{ itemId: "g1", status: "baseline" }]);
  // Thirty messages with one timestamp, two pages of 25: every one recorded once.
  expect((await w.itemsOf(outlookTrigger.id)).map((i) => i.itemId).sort()).toEqual(outlook.map((m) => m.id).sort());
  const outlookCalls = calls.filter((c) => c.tool === "microsoft-365");
  expect(outlookCalls).toHaveLength(2);
  expect(outlookCalls[0]!.arguments).toMatchObject({ mailFolderId: "inbox", filter: "receivedDateTime ge 2026-11-12T07:00:00.000Z", fetchAllPages: false });
  expect(outlookCalls[1]!.arguments).toEqual({ ...outlookCalls[0]!.arguments, skiptoken: "https://graph.example.com/v1.0/me/mailFolders/inbox/messages?$skiptoken=tok-25" });
  expect(calls.find((c) => c.tool === "gmail-runner")!.arguments).toEqual({ query: `in:inbox after:${Date.parse("2026-11-12T07:00:00Z") / 1000}`, maxResults: 50 });

  gmail.push({ threadId: "g2" });
  outlook.push({ id: "o-new", receivedDateTime: "2026-11-12T09:03:00Z" });
  w.time.add(5 * MINUTE);
  await w.scheduler.tick();
  expect((await w.itemsOf(gmailTrigger.id)).at(-1)).toEqual({ itemId: "g2", status: "started" });
  expect((await w.itemsOf(outlookTrigger.id)).filter((i) => i.status === "started")).toEqual([{ itemId: "o-new", status: "started" }]);

  // Moved to another server, a tool is no longer its catalog entry.
  await w.context.db.update(runners).set({ tools: ["gmail-runner", "microsoft-365", "other"] }).where(eq(runners.id, w.runnerId));
  expect(await call(router.tools.update, { id: local.id, runnerTool: "other" }, { context: w.context })).toMatchObject({ catalogId: null });
});

test("an HTTP tool from the catalog moved to another address is no longer its entry", async () => {
  const context = await ownerContext();
  const installed = await call(router.tools.installFromCatalog, { catalogId: "gmail", settings: {} }, { context });
  if (!("tool" in installed)) throw new Error("expected a tool");
  expect(await call(router.tools.update, { id: installed.tool.id, url: "https://mail.example.com/mcp" }, { context })).toMatchObject({ catalogId: null, auth: "oauth" });
});
