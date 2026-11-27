import { expect, type Page } from "@playwright/test";

/**
 * Waits until the page's handlers are attached (`data-hydrated`, set by the root route once React has
 * taken the server's page over): before that, a click does nothing and a form submits natively.
 * The first load of a page compiles it on the dev server, seconds on a busy machine.
 */
export const hydrated = (page: Page) => expect(page.locator("html")).toHaveAttribute("data-hydrated", { timeout: 20_000 });
