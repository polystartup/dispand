import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { rpc, stem, writer } from "./fixtures.ts";
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

/** What the pages show, made once for the run, by the first test that needs it. */
let made: Promise<{ agentId: string; tableId: string; workflowId: string; name: string }> | undefined;
function seed(page: Page) {
  made ??= (async () => {
    // A name of its own: a worker started after a failed test seeds again, on the same app.
    const name = `Axe scan ${Date.now()}`;
    await stem(page);
    const agent = await writer(page);
    const table = await rpc<{ id: string; fields: { id: string }[] }>(page, "tables/create", { name });
    const link = await rpc<{ id: string }>(page, "fields/create", { tableId: table.id, name: "Repository URL", type: "url" });
    await rpc(page, "rows/create", { tableId: table.id, values: { [table.fields[0]!.id]: "A row", [link.id]: "https://example.com/repository" } });
    const workflow = await rpc<{ id: string }>(page, "workflows/create", { name });
    await rpc(page, "workflows/update", {
      id: workflow.id,
      name,
      def: {
        trigger: { type: "manual", field: { id: "n_chat", key: "chat", type: "chat", label: "Chat", agentId: agent.id, prompt: "Help." } },
        steps: [],
        edges: [],
      },
    });
    const home = await rpc<{ id: string }>(page, "pages/home");
    await rpc(page, "widgets/create", { pageId: home.id, type: "workflow-form", workflowId: workflow.id });
    return { agentId: agent.id, tableId: table.id, workflowId: workflow.id, name };
  })();
  return made;
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
    test.beforeEach(async ({ page }) => {
      await seed(page);
    });

    for (const route of scheme === "light" ? ROUTES : ALSO_IN_DARK) {
      test(`${route} has no accessibility violation`, async ({ page }) => {
        const { name } = await seed(page);
        // Home shows the chat widget.
        await accessible(page, route, route === "/" ? { ready: page.getByRole("region", { name }) } : {});
      });
    }

    test("an agent's, a table's and a workflow's pages have none", async ({ page }) => {
      const { agentId, tableId, workflowId } = await seed(page);
      await accessible(page, `/settings/agents/${agentId}`, { ready: page.getByLabel("System prompt") });
      // A grid cell's accessible name is its column's, not its content: #620.
      await accessible(page, `/settings/data/${tableId}`, { ready: page.getByRole("link", { name: /example\.com/ }), known: ["label-content-name-mismatch"] });
      await accessible(page, `/settings/workflows/${workflowId}`, { ready: page.getByLabel("Workflow name") });
    });
  });
}

test("the sign-in page has none", async ({ page }) => {
  await page.context().clearCookies();
  await accessible(page, "/login");
});
