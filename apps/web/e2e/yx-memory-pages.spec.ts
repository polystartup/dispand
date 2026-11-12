import { expect as baseExpect, test, type Page } from "@playwright/test";
import { startFakeModel, type FakeModel } from "./fake-model.ts";

// Memory on the table page and the agent page (Settings → Data → a table, Settings → Agents → an
// agent): each has a Memory tab with the entries of its scope.
const WAIT_MS = 20_000;
const expect = baseExpect.configure({ timeout: WAIT_MS });
test.describe.configure({ timeout: 120_000 });

let model: FakeModel | undefined;
test.afterAll(() => model?.close());

async function signIn(page: Page) {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
}

async function rpc<T>(page: Page, path: string, input?: unknown): Promise<T> {
  const res = await page.request.post(`/api/rpc/${path}`, { headers: { "x-csrf-token": "orpc" }, data: input === undefined ? {} : { json: input } });
  expect(res.ok(), `${path}: ${res.status()}`).toBe(true);
  return ((await res.json()) as { json: T }).json;
}

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}-light.png`), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: test.info().outputPath(`${name}-dark.png`), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "light" });
}

test("a table's page keeps its memory: add, edit, remove and restore an entry", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  const table = await rpc<{ id: string }>(page, "tables/create", { name: "Suppliers" });
  await page.goto(`/settings/data/${table.id}`);
  await page.getByRole("tab", { name: "Memory" }).click();
  await expect(page.getByText("Nothing kept yet")).toBeVisible();

  await page.getByRole("button", { name: "Add entry" }).first().click();
  await page.getByLabel("Path").fill("payment-terms.md");
  await page.getByLabel("Name", { exact: true }).fill("Payment terms");
  await page.getByLabel("Description").fill("When suppliers are paid");
  await page.getByLabel("Body").fill("Net 30, except Northwind: the 15th.");
  await page.getByRole("button", { name: "Save" }).click();
  const entry = page.getByRole("button", { name: /Payment terms/ });
  await expect(entry).toBeVisible();
  // Another table's memory is its own.
  const other = await rpc<{ id: string }>(page, "tables/create", { name: "Clients" });
  expect(await rpc<{ entries: unknown[] }>(page, "memories/list", { scope: "table", tableId: other.id })).toMatchObject({ entries: [] });
  await shoot(page, "table-memory");

  await entry.click();
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Body").fill("Net 45.");
  await page.getByRole("button", { name: "Save" }).click();
  await entry.click();
  await expect(page.getByText("Net 45.")).toBeVisible();
  await page.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Nothing kept yet")).toBeVisible();
  await page.getByRole("region", { name: "Removed" }).getByRole("button", { name: /Payment terms/ }).click();
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByRole("region", { name: "Removed" })).toHaveCount(0);
  await expect(entry).toBeVisible();

  // The rows come back with their tab.
  await page.getByRole("tab", { name: "Rows" }).click();
  await expect(page.getByRole("button", { name: "Add entry" })).toHaveCount(0);
  await page.getByRole("tab", { name: "Rows" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Memory" })).toHaveAttribute("aria-selected", "true");
  await expect(entry).toBeVisible();
});

test("an agent's page lists what its Job kept, not read by agents that configure until accepted", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  model = await startFakeModel("memory-pages-model");
  await signIn(page);
  const harness = await rpc<{ id: string }>(page, "harnesses/create", { type: "cloud", name: "Memory pages model", kind: "openai-compatible", baseUrl: model.baseUrl, model: "memory-pages-model", systemPrompt: "" });
  const agent = await rpc<{ id: string }>(page, "agents/create", { name: "Archivist", harnessId: harness.id, systemPrompt: "Keep notes.", selfLearning: ["agent"] });
  const trigger = await rpc<{ id: string }>(page, "triggers/create", { agentId: agent.id, name: "Note", instructions: "Note it.", config: { kind: "manual", placement: "button" } });
  model.script(
    () => ({ call: { name: "memory_add", args: { scope: "agent", path: "style.md", name: "House style", description: "How notes are written", type: "practice", body: "Short sentences." } } }),
    () => ({ text: "Noted." }),
  );
  const { runId } = await rpc<{ runId: string }>(page, "jobs/start", { triggerId: trigger.id });
  await expect.poll(async () => (await rpc<{ status: string }>(page, "jobs/get", { id: runId })).status).toBe("succeeded");

  await page.goto(`/settings/agents/${agent.id}`);
  await page.getByRole("tab", { name: "Memory" }).click();
  const entry = page.getByRole("button", { name: /House style/ });
  await expect(entry).toContainText("Archivist");
  await expect(entry).toContainText("Not read by agents that configure");
  await shoot(page, "agent-memory");

  await entry.click();
  await expect(page.getByRole("dialog").getByText("Not read by agents that configure")).toBeVisible();
  await page.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(entry).not.toContainText("Not read by agents that configure");
  await entry.click();
  await expect(page.getByRole("button", { name: "Accept" })).toHaveCount(0);
  await page.getByRole("button", { name: "Revert" }).click();
  await expect(page.getByText("Nothing kept yet")).toBeVisible();
});
