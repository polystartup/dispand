import { expect, test } from "@playwright/test";
import { FakeRunner } from "./fake-runner.ts";

// Own app and database (see playwright.config.ts): first launch needs a fresh install.
const SERVER = "http://localhost:3101";

let runner: FakeRunner | undefined;
test.afterAll(() => runner?.close());

test("first launch: setup, the Assistant's page adds a harness and starts it, then Home is Home", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Name").fill("Ada");
  await page.getByLabel("Setup code").fill("dev-setup-code-0123456789");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();

  // The first page is the Assistant's: no harness yet, so it asks for one.
  await expect(page).toHaveURL(/\/assistant$/);
  await expect(page.getByText("Choose where the Assistant runs")).toBeVisible();
  await expect(page.getByRole("button", { name: /guided tour/ })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("first-launch.png"), animations: "disabled" });
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add a harness" }).click();

  // The harness sheet, through a paired runner.
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
  await expect(sheet).toHaveCount(0);

  // The new harness is picked, and nothing is made until the owner starts the Assistant.
  await expect(page.getByRole("combobox", { name: "Harness" })).toHaveValue(/^harness_/);
  const harnessId = await page.getByRole("combobox", { name: "Harness" }).inputValue();
  await expect(page).toHaveURL(/\/assistant$/);
  await page.getByRole("button", { name: "Start the Assistant" }).click();
  await expect(page.getByText("Describe your business or use case and how you'd like to automate it.")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("assistant-welcome.png"), animations: "disabled" });

  // Its platform skill is there at once, without a restart.
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Skills" }).click();
  await expect(page.getByText("dispand-platform")).toBeVisible();

  // With an Assistant, Home is Home again.
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Home" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Welcome, Ada" })).toBeVisible();

  // The rest of a custom setup: an agent, a manual workflow, a widget on Home.
  await page.goto(`/settings/agents/new?harness=${harnessId}`);
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
});
