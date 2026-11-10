import { expect as baseExpect, test, type Page } from "@playwright/test";
import { FakeRunner } from "./fake-runner.ts";

const SERVER = "http://localhost:3100";

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

// Runs after y-journey (agents and workflows exist by then) and before zz-questions.
let runner: FakeRunner | undefined;
test.afterAll(() => runner?.close());

test("data steps: fields wired to the chat, rewired between agents, and a run writes the row", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await signIn(page);
  const created = await rpc<{ runnerId: string; pairingCode: string }>(page, "runners/create", { name: "Data box" });
  runner = await FakeRunner.pair(SERVER, created.pairingCode);
  const harness = await rpc<{ id: string }>(page, "harnesses/create", {
    name: "Claude on Data box",
    runnerId: created.runnerId,
    kind: "claude-code",
    permissionMode: "default",
  });
  const agent = await rpc<{ id: string }>(page, "agents/create", { name: "Project initiator", harnessId: harness.id, systemPrompt: "" });
  const table = await rpc<{ id: string }>(page, "tables/create", { name: "Ventures" });
  for (const [name, type] of [
    ["Short description", "long-text"],
    ["Mission statement", "long-text"],
    ["Logo", "attachment"],
    ["Repository URL", "url"],
  ]) {
    await rpc(page, "fields/create", { tableId: table.id, name, type });
  }
  const workflow = await rpc<{ id: string }>(page, "workflows/create", { name: "Create a project" });
  await rpc(page, "workflows/update", {
    id: workflow.id,
    name: "Create a project",
    def: {
      trigger: { type: "manual", field: { id: "n_brief", key: "brief", type: "chat", label: "Brief", agentId: agent.id, prompt: "Find a project with the owner." } },
      steps: [],
      edges: [],
    },
  });

  await page.goto(`/settings/workflows/${workflow.id}`);
  const panel = page.getByRole("complementary", { name: "Step settings" });
  const node = (name: string) => page.locator(".react-flow__node").filter({ hasText: name });
  const outputs = panel.getByRole("list", { name: "Expected outputs" });

  // A data step after the chat, its fields wired to the chat.
  await page.getByRole("button", { name: "Add a step after Brief" }).click();
  await page.getByRole("menuitem", { name: "Data" }).click();
  await panel.getByRole("textbox", { name: "Name", exact: true }).fill("Create project in DB");
  await panel.getByLabel("Table").selectOption({ label: "Ventures" });
  await expect(panel.getByRole("checkbox", { name: "Logo" })).toBeDisabled();
  for (const field of ["Name", "Short description", "Mission statement"]) await panel.getByRole("checkbox", { name: field, exact: true }).check();
  await expect(node("Create project in DB")).toContainText("Create row · Ventures");
  await page.screenshot({ path: test.info().outputPath("data-step-panel-light.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: test.info().outputPath("data-step-panel-dark.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "light" });
  await node("Brief").click();
  await expect(outputs.getByRole("listitem")).toHaveText([
    "nameFor “Name” in Ventures: text",
    "short_descriptionFor “Short description” in Ventures: long text",
    "mission_statementFor “Mission statement” in Ventures: long text",
  ]);

  // An agent step, then a data step updating the row: its new input goes to the nearest agent.
  await page.getByRole("button", { name: "Add a step after Create project in DB" }).click();
  await page.getByRole("menuitem", { name: "Agent" }).click();
  await panel.getByRole("textbox", { name: "Name", exact: true }).fill("Define software architecture");
  await panel.getByLabel("Agent").click();
  await page.getByRole("option", { name: "Project initiator" }).click();
  await panel.getByLabel("Prompt").fill("Define which software stack should be used for this project.");
  await page.getByRole("button", { name: "Add a step after Define software architecture" }).click();
  await page.getByRole("menuitem", { name: "Data" }).click();
  await panel.getByRole("textbox", { name: "Name", exact: true }).fill("Save repository");
  await panel.getByLabel("Action").selectOption("Update row");
  await panel.getByLabel("Table").selectOption({ label: "Ventures" });
  const row = panel.getByRole("group", { name: "Row" });
  await row.getByLabel("From").selectOption({ label: "Create project in DB" });
  await expect(row.getByLabel("Value")).toHaveValue("row_id");
  await panel.getByRole("checkbox", { name: "Repository URL" }).check();
  await node("Define software architecture").click();
  await expect(outputs).toContainText("repository_url");

  // Rewired to the chat, it leaves the architecture step's outputs and joins the chat's.
  await node("Save repository").click();
  await panel.getByRole("group", { name: "Repository URL" }).getByLabel("From").selectOption({ label: "Brief" });
  await node("Define software architecture").click();
  await expect(outputs).toHaveCount(0);
  await node("Brief").click();
  await expect(outputs.getByRole("listitem")).toHaveCount(4);
  await expect(outputs).toContainText("For “Repository URL” in Ventures: an http(s) URL");
  await expect(page.getByRole("status")).toHaveText(/^Saved/, { timeout: 5_000 });

  // Phone width: the panel sits under the canvas, nothing scrolls sideways.
  await node("Save repository").click();
  await page.setViewportSize({ width: 360, height: 740 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("data-step-panel-phone-light.png"), animations: "disabled", fullPage: true });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: test.info().outputPath("data-step-panel-phone-dark.png"), animations: "disabled", fullPage: true });
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 1000 });

  // Run it from Home: the chat's four values and the update make one row.
  const home = await rpc<{ id: string }>(page, "pages/home");
  await rpc(page, "widgets/create", { pageId: home.id, type: "workflow-form", workflowId: workflow.id });
  await page.goto("/");
  const chat = page.getByRole("region", { name: "Create a project" });
  await chat.getByLabel("Message").fill("A new project");
  await chat.getByRole("button", { name: "Send" }).click();
  const { start } = await runner.waitFor("session.start", WAIT_MS);
  expect(start.expectedOutputs.map((o) => o.name)).toEqual(["name", "short_description", "mission_statement", "repository_url"]);
  runner.emit(start.sessionId, {
    type: "outputs-accepted",
    values: {
      name: "Dispand",
      short_description: "Agents and workflows",
      mission_statement: "Make agent work repeatable",
      repository_url: "https://example.com/dispand.git",
    },
  });
  const next = (await runner.waitFor("session.start", WAIT_MS)).start;
  expect(next.prompt).toBe("Define which software stack should be used for this project.");
  runner.emit(next.sessionId, { type: "result", text: "TypeScript." });
  await expect(chat.getByText("All done")).toBeVisible();

  const rows = await rpc<{ total: number }>(page, "rows/list", { tableId: table.id });
  expect(rows.total).toBe(1);
  await page.goto(`/settings/data/${table.id}`);
  for (const text of ["Dispand", "Agents and workflows", "Make agent work repeatable", "https://example.com/dispand.git"]) {
    await expect(page.getByRole("grid").getByText(text, { exact: true })).toBeVisible();
  }
});
