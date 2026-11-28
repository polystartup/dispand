import AxeBuilder from "@axe-core/playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { startFakeMcp, type FakeMcp } from "../../../packages/domain/src/tools/test-server.ts";
import { FakeRunner } from "./fake-runner.ts";
import { rpc, stem, writer } from "./fixtures.ts";
import { hydrated } from "./hydrated.ts";

// The pages a person lands on, scanned with axe (WCAG 2.2 A and AA), once the chain before it has made
// an agent, a table and a workflow: all of them in light, the ones that vary with colour (axe checks
// contrast) in dark too. A page with a violation fails with the rule, the elements and what to do.
// The dialogs, sheets and menus opened from them are scanned while open, in both too.

// A menu is not a modal to axe, so the page behind it, hidden from assistive technology, counts as
// hiding focusable content (the dialogs and sheets pass): #646.
const MENU_KNOWN = ["aria-hidden-focus"];
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
 * `open`: opens what is scanned with the page (a dialog, a sheet, a menu) and waits for it to show.
 */
async function accessible(
  page: Page,
  route: string,
  { ready = page.getByRole("heading").first(), known = [] as string[], open }: { ready?: Locator; known?: string[]; open?: () => Promise<void> } = {},
) {
  await page.goto(route);
  await hydrated(page);
  await expect(page.getByRole("main")).toBeVisible();
  await expect(ready).toBeVisible();
  await open?.();
  await scanned(page, known);
}

/** What is showing is scanned again until what it loads has landed. */
const scanned = (page: Page, known: string[] = []) => expect.poll(() => violations(page, known), { timeout: 15_000 }).toEqual([]);

/**
 * A local Git repository holding the law-firm plugin and, in another, a marketplace listing it (the dev server
 * takes file:// URLs for e2e only), and `update`, a new commit of the plugin that rewords a skill file.
 */
function lawFirmMarketplace(dir: string) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "T",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "T",
    GIT_COMMITTER_EMAIL: "t@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const repo = (dir: string, files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    for (const args of [
      ["init", "-q", "-b", "main"],
      ["add", "-A"],
      ["commit", "-q", "-m", "fixture"],
    ])
      execFileSync("git", args, { cwd: dir, env });
    return pathToFileURL(dir).href;
  };
  const root = join(import.meta.dirname, "../../../packages/domain/src/plugins/fixtures/law-firm");
  const files = Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => [relative(root, join(d.parentPath, d.name)), readFileSync(join(d.parentPath, d.name), "utf8")]),
  );
  const plugin = repo(join(dir, "plugin"), files);
  const url = repo(join(dir, "market"), {
    ".claude-plugin/marketplace.json": JSON.stringify({ name: "axe-firms", plugins: [{ name: "law-firm", source: { source: "url", url: plugin } }] }),
  });
  const update = () => {
    const skill = "skills/legal-research/SKILL.md";
    writeFileSync(join(dir, "plugin", skill), `${files[skill]!}\nRecord each decision's holding.\n`);
    for (const args of [
      ["add", skill],
      ["commit", "-q", "-m", "update"],
    ])
      execFileSync("git", args, { cwd: join(dir, "plugin"), env });
  };
  return { url, update };
}

let runner: FakeRunner | undefined;
let mcp: FakeMcp | undefined;
test.afterAll(async () => {
  runner?.close();
  await mcp?.close();
});

/** What the pages show, made once for the run, by the first test that needs it. */
let made:
  | Promise<{
      agentId: string;
      tableId: string;
      workflowId: string;
      name: string;
      harnessName: string;
      skillName: string;
      runnerName: string;
      toolName: string;
      stemId: string;
      teammate: string;
    }>
  | undefined;
function seed(page: Page) {
  made ??= (async () => {
    // A name of its own: a worker started after a failed test seeds again, on the same app.
    const name = `Axe scan ${Date.now()}`;
    await stem(page);
    const agent = await writer(page);
    // A cloud harness of its own: the Writer's depends on which spec made it.
    const harnessName = `${name} model`;
    await rpc(page, "harnesses/create", {
      type: "cloud",
      name: harnessName,
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:9/v1",
      model: "axe-model",
      systemPrompt: "",
    });
    const skillName = `axe-scan-${Date.now()}`;
    await rpc(page, "skills/create", {
      name: skillName,
      description: "Use when scanning: answers AXE.",
      instructions: "# Axe\n\nAnswer AXE.",
      requiredToolIds: [],
    });
    // A runner online (paired by a fake one, which needs a page on the app) and a tool whose actions are listed.
    const runnerName = `${name} runner`;
    await page.goto("/help");
    const { pairingCode } = await rpc<{ pairingCode: string }>(page, "runners/create", { name: runnerName });
    runner = await FakeRunner.pair(page, pairingCode);
    mcp = await startFakeMcp([{ name: "search_cases", description: "Search the cases", annotations: { readOnlyHint: true } }]);
    const toolName = `${name} tool`;
    await rpc(page, "tools/add", { name: toolName, url: mcp.url, transport: "streamable-http" });
    // A teammate, who joined through an invitation: someone to remove or delete.
    const teammate = `${name} teammate`;
    const [scope] = await rpc<{ workspaceId: string; organizationId: string }[]>(page, "workspace/managed");
    const email = `axe-${Date.now()}@example.com`;
    const { token } = await rpc<{ token: string }>(page, "workspace/invite", {
      workspaceId: scope!.workspaceId,
      organizationId: scope!.organizationId,
      email,
      role: "member",
    });
    const joined = await fetch(new URL("/api/rpc/workspace/registerInvitation", page.url()), {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": "orpc" },
      body: JSON.stringify({ json: { token, email, name: teammate, password: "a-teammate-password" } }),
    });
    expect(joined.ok, `registerInvitation: ${joined.status}`).toBe(true);
    const { agentId: stemId } = await rpc<{ agentId: string }>(page, "agents/assistant");
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
    return { agentId: agent.id, tableId: table.id, workflowId: workflow.id, name, harnessName, skillName, runnerName, toolName, stemId, teammate };
  })();
  return made;
}

const ROUTES = [
  "/",
  "/assistant?run=new",
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
const ALSO_IN_DARK = ["/", "/assistant?run=new", "/audit", "/settings/agents", "/settings/data"];

for (const scheme of ["light", "dark"] as const) {
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme });
    test.beforeEach(async ({ page }) => {
      await seed(page);
    });

    for (const route of scheme === "light" ? ROUTES : ALSO_IN_DARK) {
      test(`${route} has no accessibility violation`, async ({ page }) => {
        const { name } = await seed(page);
        // Home shows the chat widget; a new conversation of Stem (not the latest saved one, which other specs may have left) its welcome.
        const ready =
          route === "/" ? page.getByRole("region", { name }) : route.endsWith("run=new") ? page.getByText(/Describe your business or use case/) : undefined;
        await accessible(page, route, ready ? { ready } : {});
      });
    }

    // What opens on top of a page: a dialog or sheet (the rest of the page is hidden from axe while it
    // is open) or a menu.
    const dialog = (page: Page) => page.getByRole("dialog");
    const link = (page: Page) => page.getByRole("link", { name: /example\.com/ });
    const overlays: {
      name: string;
      route: (ids: Awaited<ReturnType<typeof seed>>) => string;
      /** Opens it and returns it, once it shows what it loads. */
      open: (page: Page, ids: Awaited<ReturnType<typeof seed>>) => Promise<Locator>;
      /** What shows the page itself has loaded: a heading by default. */
      ready?: (page: Page) => Locator;
      known?: string[];
    }[] = [
      {
        name: "the new harness sheet",
        route: () => "/settings/harnesses",
        open: async (page) => {
          await page.getByRole("button", { name: "New harness" }).click();
          return dialog(page);
        },
      },
      {
        name: "a cloud harness's sheet",
        route: () => "/settings/harnesses",
        open: async (page, { harnessName }) => {
          await page.getByRole("button", { name: new RegExp(harnessName) }).click();
          return dialog(page);
        },
      },
      {
        name: "the new trigger sheet of an agent",
        route: ({ agentId }) => `/settings/agents/${agentId}`,
        open: async (page) => {
          await page.getByRole("tab", { name: "Triggers" }).click();
          await page.getByRole("button", { name: "New trigger" }).click();
          return dialog(page);
        },
      },
      {
        name: "the Add widget sheet of Home",
        route: () => "/",
        open: async (page, { name }) => {
          await page.getByRole("button", { name: "Add widget" }).click();
          await expect(dialog(page).getByRole("button", { name: `Workflow: ${name}` })).toBeVisible();
          return dialog(page);
        },
      },
      {
        name: "the confirmation to delete rows",
        route: ({ tableId }) => `/settings/data/${tableId}`,
        ready: link,
        open: async (page) => {
          await page.getByRole("checkbox", { name: "Select row" }).first().check();
          await page.getByRole("button", { name: "Delete 1 row" }).click();
          return dialog(page);
        },
      },
      {
        name: "the confirmation to delete a field",
        route: ({ tableId }) => `/settings/data/${tableId}`,
        ready: link,
        open: async (page) => {
          await page.getByRole("button", { name: "Field menu: Repository URL" }).click();
          await page.getByRole("menuitem", { name: "Delete field" }).click();
          return dialog(page);
        },
      },
      {
        name: "a field's menu",
        route: ({ tableId }) => `/settings/data/${tableId}`,
        ready: link,
        open: async (page) => {
          await page.getByRole("button", { name: "Field menu: Repository URL" }).click();
          return page.getByRole("menu");
        },
        known: MENU_KNOWN,
      },
      {
        name: "the account menu",
        route: () => "/help",
        open: async (page) => {
          await page.getByRole("button", { name: "Account menu" }).click();
          return page.getByRole("menu");
        },
        known: MENU_KNOWN,
      },
      {
        name: "a row's detail sheet",
        route: ({ tableId }) => `/settings/data/${tableId}`,
        ready: link,
        open: async (page) => {
          await page.getByRole("button", { name: "Open row" }).first().click();
          return dialog(page);
        },
      },
      {
        name: "the new row dialog",
        route: ({ tableId }) => `/settings/data/${tableId}`,
        ready: link,
        open: async (page) => {
          await page.getByRole("button", { name: "New row" }).click();
          return dialog(page);
        },
      },
      {
        name: "the dialog to change a field's type",
        route: ({ tableId }) => `/settings/data/${tableId}`,
        ready: link,
        open: async (page) => {
          await page.getByRole("button", { name: "Field menu: Repository URL" }).click();
          await page.getByRole("menuitem", { name: "Change type" }).click();
          return dialog(page);
        },
      },
      {
        name: "the dialog of a table's events and parent",
        route: ({ tableId }) => `/settings/data/${tableId}`,
        ready: link,
        open: async (page) => {
          await page.getByRole("button", { name: "Table menu" }).click();
          await page.getByRole("menuitem", { name: "Events and parent" }).click();
          return dialog(page);
        },
      },
      {
        name: "the new skill sheet",
        route: () => "/settings/skills",
        open: async (page) => {
          await page.getByRole("button", { name: "Create skill" }).first().click();
          return dialog(page);
        },
      },
      {
        name: "a skill's editor",
        route: () => "/settings/skills",
        open: async (page, { skillName }) => {
          await page.getByRole("button", { name: `Edit ${skillName}` }).click();
          await expect(dialog(page).getByLabel("Instructions")).toHaveValue(/Answer AXE/);
          return dialog(page);
        },
      },
      {
        name: "the memory's new entry sheet",
        route: () => "/settings/memory",
        open: async (page) => {
          await page.getByRole("button", { name: "Add entry" }).first().click();
          return dialog(page);
        },
      },
      {
        name: "a runner's sheet",
        route: () => "/settings/harnesses/runners",
        open: async (page, { runnerName }) => {
          await page.getByRole("button", { name: new RegExp(runnerName) }).click();
          return dialog(page);
        },
      },
      {
        name: "the new MCP server sheet",
        route: () => "/settings/tools",
        open: async (page) => {
          await page.getByRole("button", { name: "Add MCP server" }).click();
          return dialog(page);
        },
      },
      {
        name: "an MCP server's sheet",
        route: () => "/settings/tools",
        open: async (page, { toolName }) => {
          await page.getByRole("button", { name: new RegExp(`^${toolName}`) }).click();
          await expect(
            dialog(page)
              .getByRole("region", { name: /^Actions/ })
              .getByText("search_cases"),
          ).toBeVisible();
          return dialog(page);
        },
      },
      {
        name: "the new runner tool sheet",
        route: () => "/settings/tools",
        open: async (page) => {
          await page.getByRole("button", { name: "Add runner tool" }).click();
          return dialog(page);
        },
      },
      {
        name: "the tool catalog",
        route: () => "/settings/tools",
        open: async (page) => {
          await page.getByRole("button", { name: "Browse catalog" }).click();
          await expect(dialog(page).getByRole("button", { name: /^GitHub/ })).toBeVisible();
          return dialog(page);
        },
      },
      {
        name: "a catalog tool's form",
        route: () => "/settings/tools",
        open: async (page) => {
          await page.getByRole("button", { name: "Browse catalog" }).click();
          await dialog(page)
            .getByRole("button", { name: /^GitHub/ })
            .click();
          await expect(dialog(page).getByLabel("Personal access token")).toBeVisible();
          return dialog(page);
        },
      },
      {
        name: "the confirmation to delete a workflow",
        route: ({ workflowId }) => `/settings/workflows/${workflowId}`,
        ready: (page) => page.getByLabel("Workflow name"),
        open: async (page) => {
          await page.getByRole("button", { name: "Workflow menu" }).click();
          await page.getByRole("menuitem", { name: "Delete workflow" }).click();
          return dialog(page);
        },
      },
      {
        name: "the invitation dialog",
        route: () => "/settings/people",
        open: async (page) => {
          await page.getByRole("button", { name: "Invite person" }).click();
          return dialog(page);
        },
      },
      {
        name: "the invitation dialog once its link is made",
        route: () => "/settings/people",
        open: async (page) => {
          await page.getByRole("button", { name: "Invite person" }).click();
          await dialog(page).getByLabel("Email address").fill("axe-invitee@example.com");
          await dialog(page).getByRole("button", { name: "Create link" }).click();
          await expect(dialog(page).getByLabel("Invitation link")).toBeVisible();
          return dialog(page);
        },
      },
      {
        name: "the confirmation to remove a person's workspace access",
        route: () => "/settings/people",
        open: async (page, { teammate }) => {
          await page.getByRole("button", { name: `Remove access for ${teammate}` }).click();
          return dialog(page);
        },
      },
      {
        name: "the confirmation to delete a person from the organization",
        route: () => "/settings/people",
        open: async (page, { teammate }) => {
          await page.getByRole("button", { name: `Delete ${teammate} from the organization` }).click();
          return dialog(page);
        },
      },
      {
        name: "the profile dialog",
        route: () => "/help",
        open: async (page) => {
          await page.getByRole("button", { name: "Account menu" }).click();
          await page.getByRole("menuitem", { name: "Your profile" }).click();
          await expect(dialog(page).getByRole("textbox")).toBeEnabled();
          return dialog(page);
        },
      },
    ];
    for (const { name, route, open, ready, known } of overlays) {
      test(`${name} has no accessibility violation`, async ({ page }) => {
        const ids = await seed(page);
        await accessible(page, route(ids), { ready: ready?.(page), known, open: async () => expect(await open(page, ids)).toBeVisible() });
      });
    }

    test("the plugin's install, set up, skill files, update and remove sheets have none", async ({ page }) => {
      test.setTimeout(120_000);
      await seed(page);
      const firms = lawFirmMarketplace(test.info().outputPath("market"));
      const market = await rpc<{ id: string }>(page, "marketplaces/add", { url: firms.url });
      try {
        await page.goto("/settings/plugins");
        await hydrated(page);
        await page.getByRole("button", { name: "Install law-firm" }).click();
        const sheet = page.getByRole("dialog");
        await expect(sheet.getByRole("checkbox", { name: /legal-research/ })).toBeVisible();
        await scanned(page);
        // No runner here to install it natively on.
        await sheet.getByRole("checkbox", { name: /Install the complete native plugin/ }).uncheck();
        await sheet.getByRole("button", { name: "Install", exact: true }).click();
        await expect(sheet.getByText("Installed in the workspace.")).toBeVisible();
        await page.keyboard.press("Escape");

        // The plugin's skills, whose files the owner may change.
        await page.goto("/settings/skills");
        await page
          .getByRole("button", { name: /^Files of / })
          .first()
          .click();
        await expect(sheet.getByRole("button", { name: /^Edit / }).first()).toBeVisible();
        await scanned(page);
        await page.keyboard.press("Escape");

        await page.goto("/settings/plugins/installed");
        firms.update();
        await page.getByRole("button", { name: "Update law-firm" }).click();
        await expect(sheet.getByRole("heading", { name: "Update law-firm" })).toBeVisible();
        await scanned(page);
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "Set up law-firm" }).click();
        await expect(sheet.getByRole("heading", { name: "Set up law-firm" })).toBeVisible();
        await scanned(page);
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "Remove law-firm" }).click();
        await expect(sheet.getByRole("button", { name: "Remove plugin" })).toBeVisible();
        await scanned(page);
        await sheet.getByRole("button", { name: "Remove plugin" }).click();
        await expect(sheet).toBeHidden();
        await expect(page.getByRole("listitem", { name: "law-firm" })).toHaveCount(0);
      } finally {
        await rpc(page, "marketplaces/remove", { id: market.id });
      }
    });

    test("an agent's, Stem's, a table's and a workflow's pages have none", async ({ page }) => {
      const { agentId, stemId, tableId, workflowId } = await seed(page);
      await accessible(page, `/settings/agents/${agentId}`, { ready: page.getByLabel("System prompt") });
      await accessible(page, `/settings/agents/${stemId}`, { ready: page.getByLabel("System prompt") });
      await accessible(page, `/settings/data/${tableId}`, { ready: page.getByRole("link", { name: /example\.com/ }) });
      await accessible(page, `/settings/workflows/${workflowId}`, { ready: page.getByLabel("Workflow name") });
    });
  });
}

test("the sign-in page has none", async ({ page }) => {
  await page.context().clearCookies();
  await accessible(page, "/login");
});
