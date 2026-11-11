import { expect as baseExpect, test, type Page } from "@playwright/test";
import { FakeRunner } from "./fake-runner.ts";

const SERVER = "http://localhost:3100";

// Generous waits: on a loaded machine the run, its stream and the fake runner can each take a few seconds.
const WAIT_MS = 20_000;
const expect = baseExpect.configure({ timeout: WAIT_MS });
test.describe.configure({ timeout: 180_000 });

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

// Runs after settings and workflows (which expect no agent or workflow yet) and before zz-questions.
let runner: FakeRunner | undefined;
test.afterAll(() => runner?.close());

test("a chat widget on Home: inline question, confirmation, then the next step's result", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await signIn(page);
  const created = await rpc<{ runnerId: string; pairingCode: string }>(page, "runners/create", { name: "Journey box" });
  runner = await FakeRunner.pair(SERVER, created.pairingCode);
  const harness = await rpc<{ id: string }>(page, "harnesses/create", {
    name: "Claude on Journey box",
    runnerId: created.runnerId,
    kind: "claude-code",
    permissionMode: "default",
  });
  const agent = await rpc<{ id: string }>(page, "agents/create", { name: "Idea partner", harnessId: harness.id, systemPrompt: "" });
  const workflow = await rpc<{ id: string }>(page, "workflows/create", { name: "Plan an idea" });
  await rpc(page, "workflows/update", {
    id: workflow.id,
    name: "Plan an idea",
    def: {
      trigger: { type: "manual", field: { id: "n_chat", key: "chat", type: "chat", label: "Chat", agentId: agent.id, prompt: "Find an idea with the owner." } },
      steps: [{ id: "n_write", key: "write", type: "agent", name: "Write it up", agentId: agent.id, prompt: "Write about {{chat.idea}}." }],
      edges: [{ from: "n_chat", to: "n_write" }],
    },
  });

  // Add the widget from the sheet; its title defaults to the workflow name and can be renamed.
  await page.goto("/");
  await page.getByRole("button", { name: "Add widget" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Workflow: Plan an idea" }).click();
  const widget = page.getByRole("region", { name: "Plan an idea" });
  await expect(widget).toBeVisible();
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Widget title").fill("Plan an idea now");
  await page.getByLabel("Widget title").press("Enter");
  await page.getByRole("button", { name: "Done" }).click();
  const chat = page.getByRole("region", { name: "Plan an idea now" });
  await expect(chat).toBeVisible();

  // The composer grows for multiline drafts, then returns to one line.
  const input = chat.getByLabel("Message");
  const initialHeight = (await input.boundingBox())!.height;
  await input.fill("One\nTwo\nThree");
  await expect.poll(async () => (await input.boundingBox())!.height).toBeGreaterThan(initialHeight);

  // The first message starts the run.
  await chat.getByLabel("Message").fill("Hello");
  await chat.getByRole("button", { name: "Send" }).click();
  const { start } = await runner.waitFor("session.start", WAIT_MS);
  expect(start.interactive).toBe(true);
  expect(start.expectedOutputs.map((o) => o.name)).toEqual(["idea"]);
  expect((await runner.waitFor("session.send", WAIT_MS)).text).toBe("Hello");
  // In the transcript only: until the send resolves, the textarea still holds "Hello" and the
  // "Say hello to start." placeholder shows. A text match on both is a strict mode violation,
  // which fails at once instead of waiting.
  await expect(chat.getByRole("listitem").getByText("Hello", { exact: true })).toBeVisible();

  runner.emit(start.sessionId, { type: "text", delta: "Hi! Let's " });
  runner.emit(start.sessionId, { type: "text", delta: "find an idea." });
  await expect(chat.getByText("Hi! Let's find an idea.")).toBeVisible();
  runner.emit(start.sessionId, { type: "tool", name: "WebSearch", status: "started" });
  await expect(chat.getByText("WebSearch")).toBeVisible();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const example = "## A starting point\n\nHere is a small example:\n\n```ts\nconst idea = \"A weekly newsletter\";\n```";
  runner.emit(start.sessionId, { type: "text", delta: example });
  await expect(chat.getByRole("heading", { name: "A starting point" })).toBeVisible();
  await chat.getByRole("button", { name: "Copy code" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('const idea = "A weekly newsletter";\n');
  await chat.getByRole("button", { name: "Copy message" }).last().click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(example);
  const viewport = chat.locator('[aria-live="polite"]');
  await viewport.evaluate((el) => { el.scrollTop = 0; });
  const jump = chat.getByRole("button", { name: "Jump to latest message" });
  await expect(jump).toBeVisible();
  await jump.click();
  await expect(jump).toBeHidden();
  await chat.screenshot({ path: test.info().outputPath("chat-controls-light.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" });
  await chat.screenshot({ path: test.info().outputPath("chat-controls-dark.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "light" });
  runner.emit(start.sessionId, {
    type: "question",
    questionId: "aq_1",
    payload: {
      kind: "choice",
      questions: [
        {
          question: "Who is it for?",
          header: "Audience",
          options: [{ label: "Makers", description: "People who build things" }, { label: "Shops" }],
          multiSelect: false,
        },
      ],
    },
  });
  await expect(chat.getByRole("radio", { name: /Makers/ })).toBeVisible();
  // Also counted in the Inbox.
  await expect(page.getByTestId("pending-badge").first()).toHaveText("1");
  await page.screenshot({ path: test.info().outputPath("task-10-home-chat-light.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: test.info().outputPath("task-10-home-chat-dark.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "light" });

  // Opening Home again shows the conversation, with the question still waiting inline.
  await page.reload();
  await expect(chat.getByText("Hi! Let's find an idea.")).toBeVisible();
  await chat.getByRole("radio", { name: /Makers/ }).click();
  await chat.getByRole("button", { name: "Send answer" }).click();
  const answered = await runner.waitFor("session.answer", WAIT_MS);
  expect(answered).toMatchObject({ sessionId: start.sessionId, questionId: "aq_1", answer: { kind: "choice", answers: { "Who is it for?": "Makers" } } });
  await expect(chat.getByRole("radio", { name: /Makers/ })).toHaveCount(0);
  await expect(page.getByTestId("pending-badge")).toHaveCount(0);

  // submit_outputs: the owner confirms the values, then the next step runs.
  runner.emit(start.sessionId, { type: "tool", name: "submit_outputs", status: "started" });
  runner.emit(start.sessionId, { type: "question", questionId: "aq_2", payload: { kind: "confirm-outputs", values: { idea: "x" } } });
  await chat.getByRole("button", { name: "Go ahead" }).click();
  expect((await runner.waitFor("session.answer", WAIT_MS)).answer).toEqual({ kind: "confirm-outputs", confirmed: true });
  runner.emit(start.sessionId, { type: "outputs-accepted", values: { idea: "x" } });

  const next = (await runner.waitFor("session.start", WAIT_MS)).start;
  expect(next.prompt).toBe("Write about x.");
  await expect(chat.getByText("Write it up")).toBeVisible();
  runner.emit(next.sessionId, { type: "result", text: "A post about x." });
  await expect(chat.getByText("A post about x.")).toBeVisible();
  await expect(chat.getByText("All done")).toBeVisible();
  await expect(chat.getByLabel("Message")).toBeDisabled();

  // The workflow changes afterwards: the run still shows its own version's names and its transcript.
  await rpc(page, "workflows/update", {
    id: workflow.id,
    name: "Plan an idea",
    def: {
      trigger: { type: "manual", field: { id: "n_talk", key: "chat", type: "chat", label: "Talk", agentId: agent.id, prompt: "Find an idea." } },
      steps: [{ id: "n_publish", key: "publish", type: "agent", name: "Publish it", agentId: agent.id, prompt: "Publish {{chat.idea}}." }],
      edges: [{ from: "n_talk", to: "n_publish" }],
    },
  });
  await page.reload();
  await expect(chat.getByText("Hi! Let's find an idea.")).toBeVisible();
  await expect(chat.getByText("Write it up")).toBeVisible();
  await expect(chat.getByText("A post about x.")).toBeVisible();
  await expect(chat.getByText("Publish it")).toHaveCount(0);

  await chat.getByRole("button", { name: "New conversation" }).click();
  await expect(chat.getByText("Hi! Let's find an idea.")).toHaveCount(0);
  await expect(chat.getByLabel("Message")).toBeEnabled();

  // Phone width: the widget fills the column, nothing scrolls sideways.
  await page.setViewportSize({ width: 360, height: 740 });
  await expect(chat).toBeVisible();
  await expect.poll(async () => (await chat.boundingBox())!.width).toBeLessThanOrEqual(360);
  // The grid lays out again for the new breakpoint: wait for it to settle, then nothing overflows.
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await page.screenshot({ path: test.info().outputPath("task-10-home-phone.png"), animations: "disabled" });

  // The run, to debug it: the Runs tab of the workflows lists it, its page shows each step.
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/settings/workflows");
  const tabs = page.getByRole("navigation", { name: "Tabs" });
  await expect(tabs.getByRole("link", { name: "Workflows" })).toHaveAttribute("aria-current", "page");
  await tabs.getByRole("link", { name: "Runs" }).click();
  await expect(tabs.getByRole("link", { name: "Runs" })).toHaveAttribute("aria-current", "page");
  await page.getByRole("link", { name: /Plan an idea/ }).first().click();
  // Names as the run's version had them.
  const brief = page.getByRole("region", { name: "Chat" });
  await expect(brief.getByText("succeeded")).toBeVisible();
  await expect(brief.getByText('{ "idea": "x" }', { exact: true })).toBeVisible();
  const write = page.getByRole("region", { name: "Write it up" });
  await write.getByText("Prompt").click();
  await expect(write.getByText("Write about x.")).toBeVisible();
  await expect(write.getByText('{ "result": "A post about x." }', { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("workflow-run-light.png"), fullPage: true });

  // Back to the workflow's own runs, a tab next to its editor.
  await page.getByRole("link", { name: "Runs" }).first().click();
  const workflowTabs = page.getByRole("navigation", { name: "Tabs" });
  await expect(workflowTabs.getByRole("link", { name: "Runs" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: /succeeded/ })).toHaveCount(1);
  await workflowTabs.getByRole("link", { name: "Editor" }).click();
  await expect(page.getByLabel("Workflow name")).toHaveValue("Plan an idea");
});
