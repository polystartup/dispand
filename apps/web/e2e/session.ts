import { expect, type Page } from "@playwright/test";
import { hydrated } from "./hydrated.ts";

/** Opens the app as the owner `auth.setup.ts` created (each project's `storageState`): Home, or Stem's page until Stem is started. */
export async function openApp(page: Page) {
  await page.goto("/");
  await hydrated(page);
  await expect(page).toHaveURL(/\/(assistant)?$/);
}
