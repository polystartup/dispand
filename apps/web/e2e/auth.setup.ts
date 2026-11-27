import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expect, test as setup } from "@playwright/test";
import { authFile } from "./auth-file.ts";
import { hydrated } from "./hydrated.ts";

const email = "ada@example.com";
const password = "correct horse battery";

// The first thing every "main-N" project does: the owner exists and is signed in, and the cookies
// are saved for its specs (`playwright.config.ts`). Nothing else is asserted here, or a regression
// elsewhere would skip every spec of the project.
setup("the owner is created on a fresh app, or signed in, and kept for the project", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/(setup|login)$/);
  await hydrated(page);
  if (page.url().endsWith("/setup")) {
    await page.getByLabel("Name").fill("Ada");
    await page.getByLabel("Organization (optional)").fill("Northwind");
    await page.getByLabel("Workspace (optional)").fill("Engineering");
    await page.getByLabel("Setup code").fill("dev-setup-code-0123456789");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Create account" }).click();
  } else {
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
  }
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible({ timeout: 15_000 });

  // Only the cookies: what the page keeps of its own (the theme) is not the project's.
  const file = authFile(setup.info().project.name.replace(/^setup-/, ""));
  const state = await page.context().storageState();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ cookies: state.cookies, origins: [] }));
});
