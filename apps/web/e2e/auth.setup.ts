import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expect, test as setup } from "@playwright/test";
import { authFile } from "./auth-file.ts";
import { hydrated } from "./hydrated.ts";

// The first thing every "main-N" project does, on its fresh app: the setup flow, which the whole
// chain then shares (`playwright.config.ts` gives each project the state this saves).

setup("fresh app asks for setup, shows the shell, and signs out to login, then signs in for the project", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  await hydrated(page);

  await page.getByLabel("Name").fill("Ada");
  await page.getByLabel("Organization (optional)").fill("Northwind");
  await page.getByLabel("Workspace (optional)").fill("Engineering");
  await page.getByLabel("Setup code").fill("dev-setup-code-0123456789");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();

  // The first page is the Assistant's, which asks where it runs: there is no harness yet.
  await expect(page).toHaveURL(/\/assistant$/);
  const sidebar = page.getByRole("navigation", { name: "Main" });
  // The first visit to the shell compiles it on the dev server: seconds on a busy machine.
  await expect(sidebar.getByRole("link", { name: "Home" })).toBeVisible({ timeout: 15_000 });
  for (const name of ["Stem", "System", "Harnesses", "Agents", "Skills", "Tools", "Data", "Workflows", "Help"]) {
    await expect(sidebar.getByRole("link", { name, exact: true })).toBeVisible();
  }
  await expect(page.getByText("Choose where Stem runs")).toBeVisible();

  await page.getByRole("link", { name: "Skills" }).click();
  await expect(page).toHaveURL(/\/settings\/skills$/);
  await expect(page.getByText("No skill yet")).toBeVisible();

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitemradio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await hydrated(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);

  // Sign-in comes back to the page that asked for it.
  await page.goto("/settings/agents");
  await expect(page).toHaveURL(/\/login\?redirect=%2Fsettings%2Fagents$/);
  await hydrated(page);
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/settings\/agents$/);

  // What the project's specs start with: the owner signed in. Only the cookies: the theme chosen above stays in this page.
  const file = authFile(setup.info().project.name.replace(/^setup-/, ""));
  const state = await page.context().storageState();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ cookies: state.cookies, origins: [] }));
});
