import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { hydrated } from "./hydrated.ts";

// The pages a person lands on, scanned with axe (WCAG 2.2 A and AA), once the chain before it has made
// an agent, a table and a workflow: all of them in light, the ones that vary with colour (axe checks
// contrast) in dark too. A page with a violation fails with the rule, the elements and what to do.
// Dialogs and sheets are not scanned yet.

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function violations(page: Page, known: string[]) {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return violations
    .filter((v) => !known.includes(v.id))
    .map((v) => `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.map((n) => n.target.join(" ")).join("\n  ")}`);
}

async function rpc<T>(page: Page, path: string): Promise<T> {
  const res = await page.request.post(`/api/rpc/${path}`, { headers: { "x-csrf-token": "orpc" }, data: {} });
  expect(res.ok(), `${path}: ${res.status()}`).toBe(true);
  return ((await res.json()) as { json: T }).json;
}

/**
 * `ready`: what shows the page's own content has rendered (a heading by default): the shell's `main`
 * is there before a route's data loads. `known`: rules a page is allowed to break until its issue is fixed.
 */
async function accessible(page: Page, route: string, { ready = page.getByRole("heading").first(), known = [] as string[] } = {}) {
  await page.goto(route);
  await hydrated(page);
  await expect(page.getByRole("main")).toBeVisible();
  await expect(ready).toBeVisible();
  // A page is scanned again until what it loads has landed.
  await expect.poll(() => violations(page, known), { timeout: 15_000 }).toEqual([]);
}

const ROUTES = [
  "/",
  "/assistant",
  "/inbox",
  "/audit",
  "/help",
  "/settings/agents",
  "/settings/agents/new",
  "/settings/harnesses",
  "/settings/harnesses/runners",
  "/settings/skills",
  "/settings/tools",
  "/settings/data",
  "/settings/workflows",
  "/settings/workflows/runs",
  "/settings/people",
  "/settings/memory",
  "/settings/plugins",
  "/settings/plugins/installed",
  "/settings/system",
];
const ALSO_IN_DARK = ["/", "/assistant", "/audit", "/settings/agents", "/settings/data"];

for (const scheme of ["light", "dark"] as const) {
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme });

    for (const route of scheme === "light" ? ROUTES : ALSO_IN_DARK) {
      test(`${route} has no accessibility violation`, async ({ page }) => {
        await accessible(page, route);
      });
    }

    test("an agent's, a table's and a workflow's pages have none", async ({ page }) => {
      const [agent] = await rpc<{ id: string }[]>(page, "agents/list");
      const tables = await rpc<{ id: string; name: string }[]>(page, "tables/list");
      // Ventures is the table with a row in it (yy-data-steps.spec.ts).
      const table = tables.find((t) => t.name === "Ventures");
      const [workflow] = await rpc<{ id: string }[]>(page, "workflows/list");
      // The chain before this spec made each of them.
      expect([agent, table, workflow].every(Boolean)).toBe(true);
      await accessible(page, `/settings/agents/${agent!.id}`, { ready: page.getByLabel("System prompt") });
      // A grid cell's accessible name is its column's, not its content: #620.
      await accessible(page, `/settings/data/${table!.id}`, { ready: page.getByRole("gridcell").first(), known: ["label-content-name-mismatch"] });
      await accessible(page, `/settings/workflows/${workflow!.id}`, { ready: page.getByLabel("Workflow name") });
    });
  });
}

test("the sign-in page has none", async ({ page }) => {
  await page.context().clearCookies();
  await accessible(page, "/login");
});
