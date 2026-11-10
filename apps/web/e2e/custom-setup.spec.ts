import { expect, test } from "@playwright/test";
import { FakeRunner } from "./fake-runner.ts";

// Own app and database (see playwright.config.ts): the first-launch Home needs a fresh install.
const SERVER = "http://localhost:3101";

let runner: FakeRunner | undefined;
test.afterAll(() => runner?.close());

test("custom setup: first launch, harness, agent, manual workflow, then a widget on Home", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Name").fill("Ada");
  await page.getByLabel("Setup code").fill("dev-setup-code-0123456789");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/$/);

  // First launch: two choices, the tour is not available yet.
  await expect(page.getByRole("heading", { name: "Let's set up your first workflow" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Take the guided tour" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Add widget" })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("task-11-first-launch.png"), animations: "disabled" });
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "Start from scratch" }).click();
  await expect(page).toHaveURL(/\/settings\/harnesses$/);

  // Harness, through a paired runner.
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "New harness" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: /^CLI/ }).click();
  await sheet.getByLabel("Name").fill("Claude on Workstation");
  await sheet.getByLabel("Runner").click();
  await page.getByRole("option", { name: "Add a runner…" }).click();
  await sheet.getByLabel("Runner name").fill("Workstation");
  await sheet.getByRole("button", { name: "Get the install command" }).click();
  const code = /DISPAND_PAIRING_CODE=([A-Z0-9]{8})/.exec(await sheet.getByLabel("Install command").innerText())?.[1];
  expect(code).toBeTruthy();
  runner = await FakeRunner.pair(SERVER, code!.toLowerCase());
  await expect(sheet.getByLabel("Runner", { exact: true })).toContainText("Workstation", { timeout: 15_000 });
  await sheet.getByRole("button", { name: "Create harness" }).click();

  // CTA: an agent.
  await page.getByRole("link", { name: "Create an agent" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Name").fill("Writer");
  await page.getByLabel("System prompt").fill("You write short, clear notes.");
  await page.getByRole("button", { name: "Create agent" }).click();

  // CTA: a manual workflow, named "xyz".
  await page.getByRole("link", { name: "Configure a manual workflow" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "New workflow" }).click();
  await expect(page).toHaveURL(/\/settings\/workflows\/wf_/);
  await page.getByLabel("Workflow name").fill("xyz");
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({ timeout: 5_000 });

  // CTA: add it to Home, where the owner renames the widget.
  await page.getByRole("button", { name: "Add it to Home" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("region", { name: "xyz" })).toBeVisible();
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Widget title").fill("Start xyz now");
  await page.getByLabel("Widget title").press("Enter");
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("region", { name: "Start xyz now" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Let's set up your first workflow" })).toHaveCount(0);
});
