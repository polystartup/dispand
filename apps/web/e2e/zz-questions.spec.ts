import { expect, test, type Page } from "@playwright/test";
import type { HarnessEvent } from "@dispand/runner-protocol";
import { FakeRunner } from "./fake-runner.ts";

const SERVER = "http://localhost:3100";

async function signIn(page: Page) {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  // Home redirects to Assistant until first-launch setup is complete.
  await expect(page).toHaveURL(/\/(assistant)?$/);
}

/** Calls an API procedure as the signed-in owner (setup that has no screen worth driving). */
async function rpc<T>(page: Page, path: string, input?: unknown): Promise<T> {
  const res = await page.request.post(`/api/rpc/${path}`, {
    headers: { "x-csrf-token": "orpc" },
    data: input === undefined ? {} : { json: input },
  });
  expect(res.ok(), `${path}: ${res.status()}`).toBe(true);
  return ((await res.json()) as { json: T }).json;
}

// Runs last (file order): it adds an agent and a workflow, which the earlier specs expect not to exist.
let runner: FakeRunner | undefined;
test.afterAll(() => runner?.close());

test("questions of three kinds reach the Inbox and the answers reach their sessions", async ({ page }) => {
  await signIn(page);
  const created = await rpc<{ runnerId: string; pairingCode: string }>(page, "runners/create", { name: "Asker" });
  runner = await FakeRunner.pair(SERVER, created.pairingCode.toLowerCase());
  const harness = await rpc<{ id: string }>(page, "harnesses/create", {
    name: "Claude on Asker",
    runnerId: created.runnerId,
    kind: "claude-code",
    permissionMode: "default",
  });
  const agent = await rpc<{ id: string }>(page, "agents/create", { name: "Asker agent", harnessId: harness.id, systemPrompt: "" });
  const workflow = await rpc<{ id: string }>(page, "workflows/create", { name: "Ask things" });
  await rpc(page, "workflows/update", {
    id: workflow.id,
    name: "Ask things",
    def: {
      trigger: { type: "manual", field: { id: "n_go", key: "go", type: "button", label: "Go" } },
      steps: [{ id: "n_ask", key: "ask", type: "agent", name: "Ask", agentId: agent.id, prompt: "Ask." }],
      edges: [{ from: "n_go", to: "n_ask" }],
    },
  });

  const payloads: Extract<HarnessEvent, { type: "question" }>["payload"][] = [
    {
      kind: "choice",
      questions: [
        {
          question: "Which tone should the post have?",
          header: "Tone",
          options: [
            { label: "Formal", description: "Reads like a letter" },
            { label: "Casual", description: "Reads like a chat" },
          ],
          multiSelect: false,
        },
      ],
    },
    { kind: "permission", toolName: "Bash", input: { command: "git status", description: "Check the tree" }, canAlwaysAllow: true },
    { kind: "confirm-outputs", values: { idea: "A weekly newsletter", audience: "Small shops" } },
  ];
  const sessions: string[] = [];
  for (const [i, payload] of payloads.entries()) {
    await rpc(page, "runs/start", { workflowId: workflow.id });
    const { start } = await runner.waitFor("session.start");
    sessions.push(start.sessionId);
    runner.emit(start.sessionId, { type: "question", questionId: `rq_${i}`, payload });
  }

  await page.goto("/notifications");
  // The earlier address leads to the Inbox.
  await expect(page).toHaveURL(/\/inbox$/);
  const waiting = page.getByRole("region", { name: "Waiting for you" });
  await page.setViewportSize({ width: 1100, height: 1500 });
  await expect(waiting.getByRole("article")).toHaveCount(3);
  await expect(page.getByTestId("pending-badge").first()).toHaveText("3");
  await page.screenshot({ path: test.info().outputPath("task-9-notifications-light.png"), fullPage: true });

  // Answer the choice question: the answer reaches its session and the badge counts down.
  const choice = waiting.getByRole("article").filter({ hasText: "Which tone" });
  await choice.getByRole("radio", { name: /Casual/ }).click();
  await choice.getByRole("button", { name: "Send answer" }).click();
  const { answer, questionId, sessionId } = await runner.waitFor("session.answer");
  expect({ sessionId, questionId, answer }).toEqual({
    sessionId: sessions[0],
    questionId: "rq_0",
    answer: { kind: "choice", answers: { "Which tone should the post have?": "Casual" } },
  });
  await expect(waiting.getByRole("article")).toHaveCount(2);
  await expect(page.getByTestId("pending-badge").first()).toHaveText("2");

  const confirm = waiting.getByRole("article").filter({ hasText: "A weekly newsletter" });
  await confirm.getByLabel("Feedback").fill("Name the day");
  await confirm.getByRole("button", { name: "Not yet" }).click();
  expect((await runner.waitFor("session.answer")).answer).toEqual({ kind: "confirm-outputs", confirmed: false, feedback: "Name the day" });
  await waiting.getByRole("article").getByRole("button", { name: "Deny" }).click();
  expect((await runner.waitFor("session.answer")).answer).toEqual({ kind: "permission", decision: "deny" });
  await expect(page.getByText("Nothing waits for you")).toBeVisible();
  // What was answered stays, under Done, with the answer.
  const done = page.getByRole("region", { name: "Done" });
  // Earlier specs share this database: only this test's own answers are looked for.
  await expect(done.getByRole("article").filter({ hasText: "Which tone should the post have?" }).getByText(/Casual/)).toBeVisible();
  await expect(done.getByRole("article").filter({ hasText: "Not confirmed: Name the day" })).toHaveCount(1);
  await expect(done.getByText("Denied", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("pending-badge")).toHaveCount(0);
});


test("tool approvals offer run-only and future-run memory and deliver the selected scope", async ({ page }) => {
  await signIn(page);
  const created = await rpc<{ runnerId: string; pairingCode: string }>(page, "runners/create", { name: "Mail test" });
  const local = await FakeRunner.pair(SERVER, created.pairingCode, { claude: "2.1.0" }, ["mail"]);
  try {
    const pending = rpc<{ id: string }>(page, "tools/create", { kind: "runner", name: "Mail", runnerId: created.runnerId, runnerTool: "mail" });
    const discovery = await local.waitFor("tool.discover");
    local.reply({ type: "tool.discovered", requestId: discovery.requestId, actions: [{ name: "draft_email", description: "Prepare a draft", inputSchema: { type: "object" } }] });
    const tool = await pending;
    const harness = await rpc<{ id: string }>(page, "harnesses/create", { name: "Mail harness", runnerId: created.runnerId, kind: "claude-code", permissionMode: "default" });
    const agent = await rpc<{ id: string }>(page, "agents/create", { name: "Mail helper", harnessId: harness.id, systemPrompt: "", toolIds: [tool.id] });
    const trigger = await rpc<{ id: string }>(page, "triggers/create", { agentId: agent.id, name: "Draft", instructions: "Prepare a draft.", config: { kind: "manual", placement: "button" } });
    for (const [index, scope] of (["run", "always"] as const).entries()) {
      await rpc(page, "jobs/start", { triggerId: trigger.id });
      const { start } = await local.waitFor("session.start");
      const server = start.mcpServers.find((s) => s.type === "runner")!;
      local.emit(start.sessionId, { type: "question", questionId: `rq_scope_${index}`, payload: { kind: "permission", toolName: `mcp__${server.name}__draft_email`, input: { subject: "Draft example" }, canAlwaysAllow: false } });
      await page.goto("/inbox");
      const card = page.getByRole("region", { name: "Waiting for you" }).getByRole("article").filter({ hasText: "Prepare a draft" });
      await expect(card.getByLabel("Remember this for this run only")).toBeVisible();
      await expect(card.getByLabel("Remember this for this and all future runs")).toBeVisible();
      await card.getByLabel(scope === "run" ? "Remember this for this run only" : "Remember this for this and all future runs").click();
      if (scope === "run") {
        await page.setViewportSize({ width: 1440, height: 1100 });
        await page.screenshot({ path: test.info().outputPath("approval-memory-desktop.png"), animations: "disabled" });
        await page.setViewportSize({ width: 360, height: 900 });
        await card.getByLabel("Remember this for this run only").scrollIntoViewIfNeeded();
        await page.screenshot({ path: test.info().outputPath("approval-memory-phone.png"), animations: "disabled" });
        await page.setViewportSize({ width: 1280, height: 900 });
      }
      await card.getByRole("button", { name: scope === "run" ? "Allow" : "Deny", exact: true }).click();
      expect((await local.waitFor("session.answer")).answer).toEqual({ kind: "permission", decision: scope === "run" ? "allow" : "deny", remember: scope });
      const permissions = await rpc<{ actions: { permission: string }[] }[]>(page, "agents/toolAsk", { id: agent.id });
      expect(permissions[0]!.actions[0]!.permission).toBe(scope === "run" ? "ask" : "off");
      local.emit(start.sessionId, { type: "result", text: "Done." });
    }
  } finally {
    local.close();
  }
});
