import { expect, test, type Page } from "@playwright/test";

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

// Runs after the workflow specs (it adds a workflow) and before zz-questions.
test("pages: new page from the sidebar, rename, a widget on it, delete", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  await rpc(page, "workflows/create", { name: "Show on a page" });
  const nav = page.getByRole("navigation", { name: "Main" });

  // Home is fixed: no page menu.
  await expect(page.getByRole("button", { name: "Add widget" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Page options" })).toHaveCount(0);

  await nav.getByRole("button", { name: "New page" }).click();
  await nav.getByLabel("New page title").fill("Projects");
  await nav.getByLabel("New page title").press("Enter");
  await expect(page).toHaveURL(/\/p\/page_/);
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(page.getByText("Nothing here yet")).toBeVisible();
  await expect(nav.getByRole("link", { name: "Projects" })).toHaveAttribute("aria-current", "page");

  // Renamed from its menu: the sidebar follows.
  await page.getByRole("button", { name: "Page options" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page.getByLabel("Page title").fill("Portfolio");
  await page.getByLabel("Page title").press("Enter");
  await expect(page.getByRole("heading", { name: "Portfolio" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Portfolio" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Projects" })).toHaveCount(0);

  // A workflow widget there, kept on reload.
  await page.getByRole("button", { name: "Add widget" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Workflow: Show on a page" }).click();
  await expect(page.getByRole("region", { name: "Show on a page" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("region", { name: "Show on a page" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("pages-light.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: test.info().outputPath("pages-dark.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 360, height: 740 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await page.screenshot({ path: test.info().outputPath("pages-phone-light.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: test.info().outputPath("pages-phone-dark.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 900 });

  // Deleted: back Home, gone from the sidebar, its link a dead end.
  const url = page.url();
  await page.getByRole("button", { name: "Page options" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect(page.getByRole("dialog")).toContainText("Delete “Portfolio” and its widgets?");
  await page.getByRole("button", { name: "Delete page" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(nav.getByRole("link", { name: "Portfolio" })).toHaveCount(0);
  await page.goto(url);
  await expect(page.getByText("This page doesn't exist")).toBeVisible();
  await page.getByRole("link", { name: "Go Home" }).click();
  await expect(page).toHaveURL(/\/$/);
});
