import { expect as baseExpect, test, type Page } from "@playwright/test";
import { FakeRunner } from "./fake-runner.ts";

const SERVER = "http://localhost:3100";

// Generous waits: on a loaded machine the run, its stream and the fake runner can each take a few seconds.
const WAIT_MS = 20_000;
const expect = baseExpect.configure({ timeout: WAIT_MS });
test.describe.configure({ timeout: 120_000 });

async function signIn(page: Page) {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function rpc<T>(page: Page, path: string, input?: unknown): Promise<T> {
  const res = await page.request.post(`/api/rpc/${path}`, {
    headers: { "x-csrf-token": "orpc" },
    data: input === undefined ? {} : { json: input },
  });
  expect(res.ok(), `${path}: ${res.status()}`).toBe(true);
  return ((await res.json()) as { json: T }).json;
}

let runner: FakeRunner | undefined;
let harnessId: string | undefined;
test.afterAll(() => runner?.close());

/** Calls one of the Job's tools on its endpoint, as its CLI session would, with the Job's token. */
async function jobTool<T>(page: Page, token: string, name: string, args: unknown): Promise<T> {
  const res = await page.request.post(`${SERVER}/mcp/job`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
  expect(res.ok(), `${name}: ${res.status()}`).toBe(true);
  const body = await res.text();
  // A JSON body, or one server-sent event.
  const json = body.trimStart().startsWith("{") ? body : body.split("\n").find((line) => line.startsWith("data: "))!.slice(6);
  const result = (JSON.parse(json) as { result: { content: { text: string }[]; isError?: boolean } }).result;
  expect(result.isError, result.content[0]?.text).toBeFalsy();
  return JSON.parse(result.content[0]!.text) as T;
}

test("the sidebar's Assistant: a chat whose messages reach its Job", async ({ page }) => {
  await signIn(page);
  const created = await rpc<{ runnerId: string; pairingCode: string }>(page, "runners/create", { name: "Assistant box" });
  runner = await FakeRunner.pair(SERVER, created.pairingCode);
  const harness = await rpc<{ id: string }>(page, "harnesses/create", { name: "Claude on Assistant box", runnerId: created.runnerId, kind: "claude-code", permissionMode: "default" });
  harnessId = harness.id;
  // settings.spec.ts started the Assistant on its own runner, gone since: moved to this one.
  const { agentId } = await rpc<{ agentId: string }>(page, "agents/assistant");
  const agent = await rpc<{ name: string; systemPrompt: string; skills: { packageId: string }[] }>(page, "agents/get", { id: agentId });
  const skillPackageIds = agent.skills.map((s) => s.packageId);
  await rpc(page, "agents/update", { id: agentId, name: agent.name, harnessId: harness.id, systemPrompt: agent.systemPrompt, skillPackageIds, toolIds: [] });

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Assistant" }).click();
  await expect(page).toHaveURL(/\/assistant$/);

  const chat = page.getByRole("region", { name: "Assistant" });
  await chat.getByRole("combobox", { name: "Message", exact: true }).fill("What fires a Job?");
  await chat.getByRole("button", { name: "Send" }).click();
  const { start } = await runner.waitFor("session.start", WAIT_MS);
  expect(start.interactive).toBe(true);
  expect(start.systemPrompt).toMatch(/^You are the Assistant of this Dispand workspace/);
  expect((await runner.waitFor("session.send", WAIT_MS)).text).toBe("What fires a Job?");
  runner.emit(start.sessionId, { type: "text", delta: "A trigger does." });
  await expect(chat.getByText("A trigger does.")).toBeVisible();

  // The URL holds the conversation: a reload reopens it.
  await expect(page).toHaveURL(/\/assistant\?run=run_/);
  await page.getByRole("button", { name: "Conversation history" }).click();
  const conversations = page.getByRole("navigation", { name: "Conversations" });
  await expect(conversations.getByRole("button", { name: /What fires a Job\?/ })).toBeVisible();
  await page.reload();
  await expect(chat.getByText("A trigger does.")).toBeVisible();

  // A new conversation starts empty, and is listed above the first.
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect(page).toHaveURL(/\/assistant\?run=new$/);
  await expect(chat.getByText("Describe your business or use case and how you'd like to automate it.")).toBeVisible();
  await expect(chat.getByText("A trigger does.")).toBeHidden();
  await chat.getByRole("combobox", { name: "Message", exact: true }).fill("And what stops one?");
  await chat.getByRole("button", { name: "Send" }).click();
  const second = await runner.waitFor("session.start", WAIT_MS);
  expect((await runner.waitFor("session.send", WAIT_MS)).text).toBe("And what stops one?");
  runner.emit(second.start.sessionId, { type: "text", delta: "Stopping it does." });
  await expect(chat.getByText("Stopping it does.")).toBeVisible();
  await page.getByRole("button", { name: "Conversation history" }).click();
  await expect(conversations.getByRole("listitem").getByRole("button")).toHaveText([/And what stops one\?/, /What fires a Job\?/]);

  // Opening the first shows its messages, not the second's.
  await conversations.getByRole("button", { name: /What fires a Job\?/ }).click();
  await expect(chat.getByText("A trigger does.")).toBeVisible();
  await expect(chat.getByText("Stopping it does.")).toBeHidden();

  // It is listed with the other agents, its rights locked.
  const assistant = await rpc<{ agentId: string }>(page, "agents/assistant");
  await page.goto(`/settings/agents/${assistant.agentId}`);
  await expect(page.getByText("The Assistant always works on data and changes tables, on every table.")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Change tables and fields/ })).toBeDisabled();
});

test("a proposal in the Assistant's chat: shown whole, approved from the composer, or declined by what is typed", async ({ page }) => {
  test.skip(!runner || !harnessId, "needs the Assistant on the fake runner, from the test above");
  await signIn(page);
  await page.goto("/assistant?run=new");
  const chat = page.getByRole("region", { name: "Assistant" });
  const box = chat.getByRole("combobox", { name: "Message", exact: true });
  await box.fill("Let the Assistant box run two sessions at once.");
  await chat.getByRole("button", { name: "Send" }).click();
  const { start } = await runner!.waitFor("session.start", WAIT_MS);
  await runner!.waitFor("session.send", WAIT_MS);
  await expect(chat.getByRole("button", { name: "Approve" })).toHaveCount(0);

  // The agent proposes, then asks: the chat shows the items, and Approve in its composer.
  const ask = async (maxWorking: number, n: number) => {
    const { proposalId } = await jobTool<{ proposalId: string }>(page, start.jobToken!, "propose", { items: [{ tool: "harnesses_set_limit", input: { id: harnessId, maxWorking } }] });
    runner!.emit(start.sessionId, { type: "question", questionId: `rq_${n}`, payload: { kind: "permission", toolName: "request_approval", input: { message: `May the harness run ${maxWorking} at once?`, proposal: proposalId }, canAlwaysAllow: false } });
    const card = chat.getByRole("region", { name: "Proposal" });
    await expect(card.getByText("Change how many sessions of a harness work at once")).toBeVisible();
    await expect(card.getByText(`May the harness run ${maxWorking} at once?`)).toBeVisible();
  };
  await ask(2, 1);
  await chat.getByRole("button", { name: "Approve" }).click();
  expect((await runner!.waitFor("session.answer", WAIT_MS)).answer).toEqual({ kind: "permission", decision: "allow" });
  await expect(chat.getByText("You approved it")).toBeVisible();
  await expect(chat.getByRole("button", { name: "Approve" })).toHaveCount(0);

  // What is typed declines the next one, and reaches the agent as the reason.
  await ask(5, 2);
  await box.fill("Approve it, but three at most");
  await box.press("Enter");
  expect((await runner!.waitFor("session.answer", WAIT_MS)).answer).toEqual({ kind: "permission", decision: "deny", message: "Approve it, but three at most" });
  await expect(chat.getByText("You declined it: Approve it, but three at most")).toBeVisible();
  await expect(box).toHaveValue("");

  // The Inbox shows both answered from the chat.
  await page.goto("/inbox");
  const done = page.getByRole("region", { name: "Done" });
  await expect(done.getByRole("article").filter({ hasText: "May the harness run 2 at once?" })).toContainText("Approved");
  await expect(done.getByRole("article").filter({ hasText: "May the harness run 5 at once?" })).toContainText("Denied: Approve it, but three at most");
});
