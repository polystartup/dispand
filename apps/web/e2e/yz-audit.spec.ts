import { expect as baseExpect, test, type Page } from "@playwright/test";
import { startFakeMcp, type FakeMcp } from "../../../packages/domain/src/tools/test-server.ts";
import { AUDIT_SENTINELS, auditRows, type AuditRow } from "./audit.ts";
import { startFakeModel, type ChatMessage, type FakeModel, type Turn } from "./fake-model.ts";
import { FakeRunner } from "./fake-runner.ts";

// Audit's acceptance (script 4.1, steps 6 to 10): a new email found by a poll starts the intake
// Job, which reads and writes the firm's data (the row it makes fires the upkeep Job, on a paired
// runner), writes to its memory and drafts a reply the owner approves. Audit names each of these,
// with no content, and the intake Job's rows carry the one trace that holds its whole work.
// Before zz-questions and zzz-telemetry, which reads these rows back against the sentinels below.
const COLLECTOR = "http://127.0.0.1:3199";
const WAIT_MS = 20_000;
const expect = baseExpect.configure({ timeout: WAIT_MS });
// A poll's interval is a minute at least, and its first poll records a baseline only.
test.describe.configure({ timeout: 240_000 });


let model: FakeModel | undefined;
let mail: FakeMcp | undefined;
let runner: FakeRunner | undefined;
test.afterAll(async () => {
  runner?.close();
  await mail?.close();
  await model?.close();
});

async function signIn(page: Page) {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  // Home, or the Assistant while no Assistant is set up (when this spec runs without the ones before it).
  await expect(page).toHaveURL(/\/(assistant)?$/);
}

async function rpc<T>(page: Page, path: string, input?: unknown): Promise<T> {
  // maxRetries retries only ECONNRESET: a reused keep-alive socket the server closed while idle.
  const res = await page.request.post(`/api/rpc/${path}`, { maxRetries: 1, headers: { "x-csrf-token": "orpc" }, data: input === undefined ? {} : { json: input } });
  expect(res.ok(), `${path}: ${res.status()}`).toBe(true);
  return ((await res.json()) as { json: T }).json;
}

/** The spans the collector received, by trace. */
async function spansOf(traceId: string): Promise<string[]> {
  const exports = (await (await fetch(`${COLLECTOR}/dump`)).json()) as { path: string; body: string }[];
  return exports
    .filter((e) => e.path.endsWith("/v1/traces"))
    .flatMap((e) => (JSON.parse(e.body) as { resourceSpans: { scopeSpans: { spans: { traceId: string; name: string }[] }[] }[] }).resourceSpans)
    .flatMap((r) => r.scopeSpans.flatMap((s) => s.spans))
    .filter((s) => s.traceId === traceId)
    .map((s) => s.name);
}

test("a polled email's Job, the Job its row fires, its memory write and its approved draft are audited, in one trace", async ({ page }) => {
  model = await startFakeModel("audit-model");
  const threads: { id: string; subject: string }[] = [];
  const drafts: unknown[] = [];
  mail = await startFakeMcp([
    { name: "search_threads", annotations: { readOnlyHint: true }, call: () => ({ content: [{ type: "text", text: JSON.stringify({ threads }) }], structuredContent: { threads } }) },
    { name: "create_draft", inputSchema: { type: "object", properties: { thread: { type: "string" }, body: { type: "string" } } }, call: (args) => (drafts.push(args), { content: [{ type: "text", text: "Draft saved." }] }) },
  ]);
  await signIn(page);
  const created = await rpc<{ runnerId: string; pairingCode: string }>(page, "runners/create", { name: "Audit box" });
  runner = await FakeRunner.pair(page, created.pairingCode);

  const cloud = await rpc<{ id: string }>(page, "harnesses/create", { type: "cloud", name: "Audit model", kind: "openai-compatible", baseUrl: model.baseUrl, model: "audit-model", systemPrompt: "" });
  const cli = await rpc<{ id: string }>(page, "harnesses/create", { name: "Claude on Audit box", runnerId: created.runnerId, kind: "claude-code", permissionMode: "default" });
  const tool = await rpc<{ id: string }>(page, "tools/create", { name: "Audit mail", url: mail.url, transport: "streamable-http", headers: {} });
  const matters = await rpc<{ id: string }>(page, "tables/create", { name: "Audit matters" });
  await rpc(page, "tables/setPrimitive", { id: matters.id, primitive: true });
  const field = (await rpc<{ fields: { id: string }[] }>(page, "tables/get", { id: matters.id })).fields[0]!.id;
  const intake = await rpc<{ id: string }>(page, "agents/create", {
    name: "Audit intake",
    harnessId: cloud.id,
    systemPrompt: "Record each new client email and draft its reply.",
    toolIds: [tool.id],
    toolPermissions: [{ toolId: tool.id, unasked: ["search_threads"] }],
    bundles: ["data"],
    dataTables: [matters.id],
    selfLearning: ["agent"],
  });
  const upkeep = await rpc<{ id: string }>(page, "agents/create", { name: "Audit upkeep", harnessId: cli.id, systemPrompt: "Keep each matter up to date.", bundles: ["data"], dataTables: [matters.id] });
  await rpc(page, "triggers/create", { agentId: upkeep.id, name: "Audit matter made", instructions: "Bring the matter up to date.", config: { kind: "primitive", tableId: matters.id, operations: ["created"] } });

  // The intake Job's turns, by how many tool results it has had; the upkeep Job runs on the runner.
  const turns: Turn[] = [
    { call: { name: "rows_list", args: { tableId: matters.id } } },
    { call: { name: "rows_create", args: { tableId: matters.id, values: { [field]: AUDIT_SENTINELS.auditRow } } } },
    { call: { name: "memory_add", args: { scope: "agent", path: "clients/audit.md", name: "A client", description: "Who wrote", type: "fact", body: AUDIT_SENTINELS.auditMemory } } },
    { call: { name: "Audit_mail_create_draft", args: { thread: "t1", body: AUDIT_SENTINELS.auditDraft } } },
    { text: "The reply is drafted for your review." },
  ];
  model.script(...turns.map(() => (m: ChatMessage[]) => turns[m.filter((x) => x.role === "tool").length]!));

  // 6. The poll: its first call records a baseline; the email that arrives after it starts a Job.
  const trigger = await rpc<{ id: string }>(page, "triggers/create", {
    agentId: intake.id,
    name: "Audit new email",
    instructions: "A new email arrived.",
    config: { kind: "poll", toolId: tool.id, action: "search_threads", arguments: {}, itemsPath: "threads", idPath: "id", interval: 60 },
  });
  try {
    await expect.poll(async () => (await auditRows(page)).some((r) => r.action === "poll.run" && r.resourceId === trigger.id), { timeout: 60_000 }).toBe(true);
    threads.push({ id: "t1", subject: AUDIT_SENTINELS.auditMail });
    const jobOf = async () => (await rpc<{ id: string }[]>(page, "runs/list", { triggerId: trigger.id }))[0]?.id;
    await expect.poll(jobOf, { timeout: 120_000 }).toBeTruthy();
    const jobId = (await jobOf())!;

    // 8. The draft asks first: the owner approves it in the Inbox.
    const pending = async () => (await rpc<{ id: string; runId: string | null }[]>(page, "questions/list", { status: "pending" })).find((q) => q.runId === jobId);
    await expect.poll(pending).toBeTruthy();
    const question = (await pending())!;
    await rpc(page, "questions/answer", { questionId: question.id, answer: { kind: "permission", decision: "allow" } });
    await expect.poll(async () => (await rpc<{ status: string }>(page, "jobs/get", { id: jobId })).status).toBe("succeeded");
    expect(drafts).toEqual([{ thread: "t1", body: AUDIT_SENTINELS.auditDraft }]);

    // 7. The row the Job made fired the upkeep Job, on the runner.
    const { start } = await runner.waitFor("session.start", WAIT_MS);
    runner.emit(start.sessionId, { type: "result", text: "Up to date." });

    // 9 and 10. Audit, on the Job's page and through audit.list.
    let rows: AuditRow[] = [];
    await expect
      .poll(async () => {
        rows = await auditRows(page);
        const made = rows.find((r) => r.action === "job.created" && r.details.agentId === upkeep.id);
        return rows.some((r) => r.action === "job.finished" && !!made && r.jobId === made.jobId);
      })
      .toBe(true);
    const mine = rows.filter((r) => r.jobId === jobId);
    const one = (action: string, extra: (r: AuditRow) => boolean = () => true) => {
      const found = mine.filter((r) => r.action === action && extra(r));
      expect(found, action).toHaveLength(1);
      return found[0]!;
    };
    expect(rows.find((r) => r.action === "poll.run" && r.resourceId === trigger.id && r.details.found === 1)).toMatchObject({ details: { toolId: tool.id, action: "search_threads", status: "polled" } });
    expect(one("job.created").details).toMatchObject({ causeKind: "poll", agentId: intake.id, agentName: "Audit intake", triggerId: trigger.id });
    expect(one("job.started").details).toMatchObject({ harnessId: cloud.id, harnessName: "Audit model" });
    one("platform.call", (r) => r.details.tool === "rows_list" && r.details.tableId === matters.id);
    one("platform.call", (r) => r.details.tool === "rows_create" && r.details.tableId === matters.id && r.result === "ok");
    one("platform.call", (r) => r.details.tool === "memory_add" && r.result === "ok");
    one("memory.written", (r) => r.details.scope === "agent" && r.details.operation === "add" && r.details.agentId === intake.id && r.resourceType === "memory");
    one("question.asked", (r) => r.details.questionKind === "approval");
    one("question.answered", (r) => r.details.decision === "allow" && r.details.answeredBy === "person");
    one("tool.call", (r) => r.details.toolId === tool.id && r.details.action === "create_draft" && r.result === "ok");
    one("job.finished");
    const event = rows.find((r) => r.action === "event.recorded" && r.details.tableId === matters.id && r.details.operation === "created")!;
    expect(event).toBeDefined();
    const upkeepJob = rows.find((r) => r.action === "job.created" && r.details.agentId === upkeep.id)!;
    expect(upkeepJob.details).toMatchObject({ causeKind: "event", eventId: event.details.eventId, agentName: "Audit upkeep" });
    expect(rows.find((r) => r.action === "job.started" && r.jobId === upkeepJob.jobId)!.details).toMatchObject({ harnessName: "Claude on Audit box", runnerId: created.runnerId, runnerName: "Audit box" });

    // One trace: the Job's creation, its session, its model turns, its Dispand and tool calls.
    const traceId = one("job.created").traceId!;
    for (const action of ["job.started", "platform.call", "memory.written", "tool.call", "job.finished"]) for (const r of mine.filter((x) => x.action === action)) expect(r.traceId, action).toBe(traceId);
    await expect
      .poll(async () => {
        const names = await spansOf(traceId);
        return ["scheduler.poll", "engine.job", "engine.session.start", "model.turn", "rows.create", "tool.call"].filter((n) => !names.includes(n));
      })
      .toEqual([]);

    await page.goto(`/settings/workflows/runs/${jobId}`);
    const section = page.getByRole("region", { name: "Audit" });
    await expect(section.getByText("Tool action called")).toBeVisible();
    await expect(section.getByRole("button", { name: "Copy the trace id" }).first()).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("audit-job.png"), fullPage: true });
    // From the Job's page to the Audit page, filtered on that Job: the filter is in the URL and survives a reload.
    await section.getByRole("link", { name: "Open in Audit" }).click();
    await expect(page).toHaveURL(new RegExp(`/audit\\?jobId=${jobId}`));
    await expect(page.getByText(`Only the Job ${jobId}`)).toBeVisible();
    await expect(page.getByText("Tool action called")).toBeVisible();
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(`Only the Job ${jobId}`)).toBeVisible();
    await page.getByLabel(/^What/).selectOption("memory");
    await expect(page).toHaveURL(/action=memory/);
    await expect(page.getByText("Memory written")).toBeVisible();
    await expect(page.getByText("Tool action called")).toBeHidden();
  } finally {
    await rpc(page, "triggers/delete", { id: trigger.id });
  }
});

test("a Job's token, its runner's token, a chat message and a Question's own-words answer reach no Audit row and no telemetry", async ({ page }) => {
  await signIn(page);
  const created = await rpc<{ runnerId: string; pairingCode: string }>(page, "runners/create", { name: "Audit chat box" });
  const local = await FakeRunner.pair(page, created.pairingCode);
  try {
    const harness = await rpc<{ id: string }>(page, "harnesses/create", { name: "Claude on Audit chat box", runnerId: created.runnerId, kind: "claude-code", permissionMode: "default" });
    const agent = await rpc<{ id: string }>(page, "agents/create", { name: "Audit chat partner", harnessId: harness.id, systemPrompt: "" });
    const trigger = await rpc<{ id: string }>(page, "triggers/create", { agentId: agent.id, name: "Audit chat", instructions: "", config: { kind: "manual", placement: "chat" } });
    const { runId } = await rpc<{ runId: string }>(page, "jobs/start", { triggerId: trigger.id });
    const { start } = await local.waitFor("session.start", WAIT_MS);
    expect(start.jobToken).toBeTruthy();
    await rpc(page, "runs/sendChat", { runId, text: AUDIT_SENTINELS.chatMessage });
    expect((await local.waitFor("session.send", WAIT_MS)).text).toBe(AUDIT_SENTINELS.chatMessage);
    const asked = "Which client is it?";
    local.emit(start.sessionId, { type: "question", questionId: "aq_audit", payload: { kind: "choice", questions: [{ question: asked, header: "Client", options: [{ label: "A new one" }], multiSelect: false }] } });
    const pending = async () => (await rpc<{ id: string; runId: string | null }[]>(page, "questions/list", { status: "pending" })).find((q) => q.runId === runId);
    await expect.poll(pending).toBeTruthy();
    await rpc(page, "questions/answer", { questionId: (await pending())!.id, answer: { kind: "choice", answers: { [asked]: AUDIT_SENTINELS.ownWordsAnswer } } });
    expect((await local.waitFor("session.answer", WAIT_MS)).answer).toEqual({ kind: "choice", answers: { [asked]: AUDIT_SENTINELS.ownWordsAnswer } });
    local.emit(start.sessionId, { type: "outputs-accepted", values: {} });
    await expect.poll(async () => (await rpc<{ status: string }>(page, "jobs/get", { id: runId })).status).toBe("succeeded");

    const rows = await auditRows(page);
    expect(rows.filter((r) => r.jobId === runId).map((r) => r.action)).toEqual(expect.arrayContaining(["job.created", "question.asked", "question.answered", "job.finished"]));
    // The tokens exist for this run only: checked here, against the rows and what the collector got so far.
    await page.waitForTimeout(2_000);
    const exported = JSON.stringify(await (await fetch(`${COLLECTOR}/dump`)).json());
    const audited = JSON.stringify(rows);
    for (const [what, sentinel] of Object.entries({ jobToken: start.jobToken!, runnerToken: local.token, chat: AUDIT_SENTINELS.chatMessage, answer: AUDIT_SENTINELS.ownWordsAnswer })) {
      expect(audited.includes(sentinel), `${what} found in an Audit row`).toBe(false);
      expect(exported.includes(sentinel), `${what} found in exported telemetry`).toBe(false);
    }
  } finally {
    local.close();
  }
});
