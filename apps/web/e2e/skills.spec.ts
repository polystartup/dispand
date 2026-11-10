import { expect, test, type Page } from "@playwright/test";

/** Signs in as the owner created by auth.spec.ts. */
async function signIn(page: Page) {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function shots(page: Page, name: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: test.info().outputPath(`${name}-light.png`), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(500);
  await page.screenshot({ path: test.info().outputPath(`${name}-dark.png`), animations: "disabled" });
  await page.setViewportSize({ width: 360, height: 780 });
  await page.screenshot({ path: test.info().outputPath(`${name}-phone-dark.png`), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForTimeout(500);
  await page.screenshot({ path: test.info().outputPath(`${name}-phone-light.png`), animations: "disabled" });
  await page.setViewportSize({ width: 1280, height: 720 });
}

test("create a skill with a file, see it in the list, edit it and delete it", async ({ page }) => {
  await signIn(page);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Skills" }).click();
  await expect(page.getByText("No skill yet")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Create skill" }).click();

  const sheet = page.getByRole("dialog");
  await sheet.getByLabel("Name").fill("hello-check");
  await sheet.getByLabel("Description").fill("Use when asked to check the greeting: answers HELLO-CHECK.");
  await sheet.getByLabel("Instructions").fill("# Hello check\n\nAnswer HELLO-CHECK, then run `scripts/greet.sh`.");
  // A file the runner's boundary protects is refused by the server, which names it.
  await sheet.getByLabel("Add files").setInputFiles({ name: ".mcp.json", mimeType: "application/json", buffer: Buffer.from("{}") });
  await sheet.getByRole("button", { name: "Create skill" }).click();
  await expect(sheet.getByRole("alert")).toContainText("hello-check/.mcp.json: unsafe path");
  await sheet.getByRole("button", { name: "Remove .mcp.json" }).click();
  await sheet.getByLabel("Add files").setInputFiles({ name: "greet.sh", mimeType: "text/x-sh", buffer: Buffer.from("echo HELLO-CHECK\n") });
  await expect(sheet.getByText("greet.sh", { exact: true })).toBeVisible();
  await sheet.getByRole("button", { name: "Create skill" }).click();
  await expect(sheet).toBeHidden();

  const row = page.getByRole("button", { name: /^hello-check/ });
  await expect(row).toContainText("answers HELLO-CHECK");
  await row.click();
  await expect(row).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#" + (await row.getAttribute("aria-controls")))).toContainText("hello-check");
  await page.mouse.move(0, 0);
  await shots(page, "slice-4-task-7-skills");

  await page.getByRole("button", { name: "Edit hello-check" }).click();
  await expect(sheet.getByLabel("Instructions")).toHaveValue("# Hello check\n\nAnswer HELLO-CHECK, then run `scripts/greet.sh`.\n");
  await expect(sheet.getByText("greet.sh", { exact: true })).toBeVisible();
  await expect(sheet.getByText("17 B")).toBeVisible();
  await shots(page, "slice-4-task-7-skill-editor");
  await sheet.getByLabel("Description").fill("Answers HELLO-CHECK.");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();
  await expect(row).toContainText("Answers HELLO-CHECK.");

  // The saved file is kept by an edit that doesn't touch the files.
  await page.getByRole("button", { name: "Edit hello-check" }).click();
  await expect(sheet.getByText("greet.sh", { exact: true })).toBeVisible();
  await sheet.getByRole("button", { name: "Delete" }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByText("No skill yet")).toBeVisible();
});
