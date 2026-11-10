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
  await expect(page).toHaveURL(/\/$/);
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

test("questions of three kinds reach Notifications and the answers reach their sessions", async ({ page }) => {
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
  await page.setViewportSize({ width: 1100, height: 1500 });
  await expect(page.getByRole("article")).toHaveCount(3);
  await expect(page.getByTestId("pending-badge").first()).toHaveText("3");
  await page.screenshot({ path: test.info().outputPath("task-9-notifications-light.png"), fullPage: true });

  // Answer the choice question: the answer reaches its session and the badge counts down.
  const choice = page.getByRole("article").filter({ hasText: "Which tone" });
  await choice.getByRole("radio", { name: /Casual/ }).click();
  await choice.getByRole("button", { name: "Send answer" }).click();
  const { answer, questionId, sessionId } = await runner.waitFor("session.answer");
  expect({ sessionId, questionId, answer }).toEqual({
    sessionId: sessions[0],
    questionId: "rq_0",
    answer: { kind: "choice", answers: { "Which tone should the post have?": "Casual" } },
  });
  await expect(page.getByRole("article")).toHaveCount(2);
  await expect(page.getByTestId("pending-badge").first()).toHaveText("2");

  const confirm = page.getByRole("article").filter({ hasText: "A weekly newsletter" });
  await confirm.getByLabel("Feedback").fill("Name the day");
  await confirm.getByRole("button", { name: "Not yet" }).click();
  expect((await runner.waitFor("session.answer")).answer).toEqual({ kind: "confirm-outputs", confirmed: false, feedback: "Name the day" });
  await page.getByRole("article").getByRole("button", { name: "Deny" }).click();
  expect((await runner.waitFor("session.answer")).answer).toEqual({ kind: "permission", decision: "deny" });
  await expect(page.getByText("Nothing waits for you")).toBeVisible();
  await expect(page.getByTestId("pending-badge")).toHaveCount(0);
});
