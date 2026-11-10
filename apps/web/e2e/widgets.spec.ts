import { expect as baseExpect, test, type Page } from "@playwright/test";

const expect = baseExpect.configure({ timeout: 15_000 });
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

// A 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function shots(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}-light.png`), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(400);
  await page.screenshot({ path: test.info().outputPath(`${name}-dark.png`), animations: "disabled" });
  await page.setViewportSize({ width: 360, height: 780 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await page.screenshot({ path: test.info().outputPath(`${name}-phone-dark.png`), animations: "disabled", fullPage: true });
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForTimeout(400);
  await page.screenshot({ path: test.info().outputPath(`${name}-phone-light.png`), animations: "disabled", fullPage: true });
  await page.setViewportSize({ width: 1280, height: 1000 });
}

// Runs after the Data specs (the owner exists) and cleans up the table and workflow it makes.
test("grid and table widgets show a table's rows and follow every change live", async ({ page, context }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await signIn(page);

  // A table with a logo uploaded by hand, a page, and a workflow that adds a row.
  const table = await rpc<{ id: string; fields: { id: string }[] }>(page, "tables/create", { name: "Showcase" });
  const nameId = table.fields[0]!.id;
  const short = await rpc<{ id: string }>(page, "fields/create", { tableId: table.id, name: "Short description", type: "long-text" });
  await rpc(page, "fields/create", { tableId: table.id, name: "Logo", type: "attachment" });
  const first = await rpc<{ id: string }>(page, "rows/create", { tableId: table.id, values: { [nameId]: "Dispand", [short.id]: "Agents and workflows" } });
  await rpc(page, "rows/create", { tableId: table.id, values: { [nameId]: "Zeta" } });
  await page.goto(`/settings/data/${table.id}?row=${first.id}`);
  const detail = page.getByRole("dialog");
  await detail.getByLabel("Upload to Logo").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
  await expect(detail.getByRole("img", { name: "logo.png" })).toBeVisible();

  const workflow = await rpc<{ id: string }>(page, "workflows/create", { name: "Add a showcase row" });
  await rpc(page, "workflows/update", {
    id: workflow.id,
    name: "Add a showcase row",
    def: {
      trigger: { type: "manual", field: { id: "n_go", key: "go", type: "button", label: "Add a row" } },
      steps: [{ id: "n_add", key: "add", type: "data", name: "Add", action: "create-row", tableId: table.id, inputs: [{ fieldId: nameId, source: { type: "value", value: "Added by a workflow" } }] }],
      edges: [{ from: "n_go", to: "n_add" }],
    },
  });
  const created = await rpc<{ id: string }>(page, "pages/create", { title: "Showcase page" });
  await page.goto(`/p/${created.id}`);

  // A Grid widget: the name and description, the logo as cover.
  await page.getByRole("button", { name: "Add widget" }).click();
  await page.getByRole("button", { name: "Grid", exact: true }).click();
  await page.getByRole("combobox", { name: "Table", exact: true }).selectOption({ label: "Showcase" });
  await page.getByRole("checkbox", { name: "Logo" }).uncheck();
  await page.getByRole("combobox", { name: "Cover" }).selectOption({ label: "Logo" });
  await page.getByRole("button", { name: "Add widget" }).click();
  const grid = page.getByRole("region", { name: "Showcase" }).first();
  await expect(grid.getByText("Dispand", { exact: true })).toBeVisible();
  await expect(grid.getByText("Agents and workflows")).toBeVisible();
  await expect(grid.getByRole("img", { name: "logo.png" })).toBeVisible();

  // A Table widget, sorted by name from its form, and the workflow's button.
  await page.getByRole("button", { name: "Add widget" }).click();
  await page.getByRole("button", { name: "Table", exact: true }).click();
  await page.getByRole("combobox", { name: "Table", exact: true }).selectOption({ label: "Showcase" });
  await page.getByRole("checkbox", { name: "Logo" }).uncheck();
  await page.getByRole("combobox", { name: "Sort by" }).selectOption({ label: "Name" });
  await page.getByRole("combobox", { name: "Direction" }).selectOption({ label: "Descending" });
  await page.getByRole("button", { name: "Add widget" }).click();
  await expect(page.getByRole("region", { name: "Showcase" })).toHaveCount(2);
  const list = page.getByRole("region", { name: "Showcase" }).nth(1);
  const names = () => list.getByRole("row").locator("td:first-child").allInnerTexts();
  await expect.poll(names).toEqual(["Zeta", "Dispand"]);
  // Header clicks sort for this viewer: ascending, descending, then the widget's own order.
  await list.getByRole("button", { name: "Name" }).click();
  await expect.poll(names).toEqual(["Dispand", "Zeta"]);
  await list.getByRole("button", { name: "Name" }).click();
  await expect.poll(names).toEqual(["Zeta", "Dispand"]);
  await page.getByRole("button", { name: "Add widget" }).click();
  await page.getByRole("button", { name: "Workflow: Add a showcase row" }).click();
  await expect(page.getByRole("region", { name: "Add a showcase row" })).toBeVisible();
  await shots(page, "task-11-widgets");

  // A name edited in Data in a second tab shows in both widgets, without a reload.
  const other = await context.newPage();
  await other.goto(`/settings/data/${table.id}`);
  const nameCell = other.getByRole("gridcell", { name: "Name", exact: true }).first();
  await nameCell.click();
  await other.keyboard.press("Enter");
  await other.getByRole("textbox", { name: "Name", exact: true }).fill("Dispand 2");
  await other.keyboard.press("Enter");
  await expect(grid.getByText("Dispand 2", { exact: true })).toBeVisible();
  await expect(list.getByText("Dispand 2", { exact: true })).toBeVisible();
  await other.close();

  // The workflow's new row appears as a card and a table row.
  await page.getByRole("region", { name: "Add a showcase row" }).getByRole("button", { name: "Add a row" }).click();
  await expect(grid.getByText("Added by a workflow")).toBeVisible();
  await expect(list.getByText("Added by a workflow")).toBeVisible();

  // A table row opens its detail in Data.
  await list.getByRole("cell", { name: "Dispand 2" }).click();
  await expect(page).toHaveURL(new RegExp(`/settings/data/${table.id}\\?row=${first.id}`));
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Dispand 2" })).toBeVisible();

  // Once no workflow uses the table, deleting it deletes its widgets.
  await rpc(page, "workflows/delete", { id: workflow.id });
  await rpc(page, "tables/delete", { id: table.id });
  await page.goto(`/p/${created.id}`);
  await expect(page.getByText("Nothing here yet")).toBeVisible();
  await rpc(page, "pages/delete", { id: created.id });
});
