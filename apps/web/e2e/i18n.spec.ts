import { expect, test, type Page } from "@playwright/test";
import { openApp } from "./session.ts";

/** The app of the project this spec runs in ("main-1" to "main-4" each have their own). */
const server = () => test.info().project.use.baseURL!;

/** The first server render of a page, before any script runs, for a browser with these languages. */
async function firstRender(page: Page, acceptLanguage: string) {
  const res = await page.request.get("/settings/agents", { headers: { "accept-language": acceptLanguage } });
  expect(res.ok()).toBe(true);
  const html = await res.text();
  return { lang: /<html[^>]* lang="([a-z]+)"/.exec(html)?.[1], html };
}

test.describe.configure({ mode: "serial" });

test("the first server render follows the browser's languages, by quality", async ({ page }) => {
  await openApp(page);
  const canadian = await firstRender(page, "fr-CA,fr;q=0.9");
  expect(canadian.lang).toBe("fr");
  expect(canadian.html).toContain(">Paramètres<");
  expect((await firstRender(page, "en;q=0.5, fr;q=1")).lang).toBe("fr");
  const refused = await firstRender(page, "fr;q=0, en");
  expect(refused.lang).toBe("en");
  expect(refused.html).toContain(">Settings<");
  expect((await firstRender(page, "de")).lang).toBe("en");
});

test("a saved French wins over an English browser, from the first server render on", async ({ page }) => {
  await openApp(page);
  try {
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitemradio", { name: "Français" }).click();
    // The menu stays open on a choice (to show a failure), and its own labels switch first.
    await expect(page.getByRole("menuitemradio", { name: "Français" })).toBeChecked();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("navigation", { name: "Principal" }).getByText("Paramètres")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "fr");

    const english = await firstRender(page, "en");
    expect(english.lang).toBe("fr");
    expect(english.html).toContain(">Paramètres<");
    // The built-in agent's label, the same in French.
    expect(english.html).toContain(">Stem<");
  } finally {
    // Back to the browser's language for the specs that follow.
    const res = await page.request.post("/api/auth/update-user", { data: { language: null }, headers: { origin: server() } });
    expect(res.ok()).toBe(true);
  }
  expect((await firstRender(page, "en")).lang).toBe("en");
});
