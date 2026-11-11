import { expect, test, type Page } from "@playwright/test";
import { startFakeMcp, type FakeMcp } from "../../../packages/domain/src/tools/test-server.ts";
import { FakeRunner } from "./fake-runner.ts";

/** Signs in as the owner created by auth.spec.ts. */
async function signIn(page: Page) {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function shots(page: Page, name: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: test.info().outputPath(`${name}-light.png`), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(500);
  await page.screenshot({ path: test.info().outputPath(`${name}-dark.png`), animations: "disabled" });
  await page.setViewportSize({ width: 360, height: 780 });
  await page.screenshot({ path: test.info().outputPath(`${name}-phone-dark.png`), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForTimeout(500);
  await page.screenshot({ path: test.info().outputPath(`${name}-phone-light.png`), animations: "disabled" });
  await page.setViewportSize({ width: 1280, height: 720 });
}

let server: FakeMcp | undefined;
test.afterAll(() => server?.close());

test("adding a tool with a header lists its actions, and the header shows as set after reload", async ({ page }) => {
  // A local fake MCP server: the e2e app runs in development, which may call loopback addresses.
  server = await startFakeMcp([
    {
      name: "create_repository",
      description: "Create a GitHub repository",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "Repository name" }, private: { type: "boolean" } },
        required: ["name"],
      },
    },
  ]);
  await signIn(page);
  await page.goto("/settings/tools");
  await expect(page.getByText("No tool yet")).toBeVisible();
  await shots(page, "tools-empty");

  await page.getByRole("button", { name: "Add MCP server" }).click();
  await page.getByLabel("Name").fill("GitHub");
  await page.getByLabel("URL").fill(server.url);
  await page.getByRole("button", { name: "Add header" }).click();
  await page.getByLabel("Header name").fill("Authorization");
  await page.getByLabel("Value of Authorization").fill("Bearer e2e-s3cret");
  await page.getByRole("button", { name: "Add server" }).click();

  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("heading", { name: "Actions (1)" })).toBeVisible();
  await expect(sheet.getByRole("region", { name: /^Actions/ }).getByText("create_repository")).toBeVisible();
  // A poll may read it only if the server says it is read-only: it does not, so it is offered unticked.
  await expect(sheet.getByRole("region", { name: "What polls may read" }).getByRole("checkbox", { name: /create_repository/ })).not.toBeChecked();
  await expect(sheet.getByText("Repository name")).toBeVisible();
  expect(server.requests.length).toBeGreaterThan(0);
  expect(server.requests.every((h) => h.authorization === "Bearer e2e-s3cret")).toBe(true);
  await shots(page, "tools-sheet");

  await page.reload();
  await expect(page.getByRole("button", { name: /^GitHub/ })).toContainText("1 action");
  await shots(page, "tools-list");
  await page.getByRole("button", { name: /^GitHub/ }).click();
  const value = page.getByLabel("Value of authorization");
  await expect(value).toHaveValue("");
  await expect(value).toHaveAttribute("placeholder", "Set: leave empty to keep");
  await expect(page.locator("body")).not.toContainText("e2e-s3cret");

  // Refreshing lists again with the stored header.
  const before = server.requests.length;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(() => server!.requests.length).toBeGreaterThan(before);
  expect(server.requests.every((h) => h.authorization === "Bearer e2e-s3cret")).toBe(true);

  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("No tool yet")).toBeVisible();
});

test("the catalog searches its entries, shows a runner snippet without a key, and asks for an HTTP entry's settings", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings/tools");
  await page.getByRole("button", { name: "Browse catalog" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("button", { name: /^GitHub/ })).toBeVisible();
  await shots(page, "catalog-list");

  await sheet.getByLabel("Search the catalog").fill("BRAVE");
  await expect(sheet.getByRole("button", { name: /^GitHub/ })).toHaveCount(0);
  await sheet.getByRole("button", { name: /^Brave Search/ }).click();
  const snippet = sheet.getByLabel("Runner config for Brave Search");
  await expect(snippet).toContainText('"BRAVE_API_KEY": "<your key>"');
  await expect(snippet).toContainText("@brave/brave-search-mcp-server");
  await shots(page, "catalog-runner");

  await sheet.getByRole("button", { name: "All tools" }).click();
  await sheet.getByLabel("Search the catalog").fill("");
  await sheet.getByRole("button", { name: /^GitHub/ }).click();
  await expect(sheet.getByLabel("Personal access token")).toHaveAttribute("type", "password");
  await expect(sheet.getByLabel("Name")).toHaveValue("GitHub");
  await shots(page, "catalog-install");
  // Installing would call GitHub itself: the install path is covered by the domain tests with a fake connector.
});

/** Calls an API procedure as the signed-in owner (setup that has no screen worth driving). */
async function rpc<T>(page: Page, path: string, input?: unknown): Promise<T> {
  const res = await page.request.post(`/api/rpc/${path}`, {
    headers: { "x-csrf-token": "orpc" },
    data: input === undefined ? {} : { json: input },
  });
  expect(res.ok(), `${path}: ${res.status()}`).toBe(true);
  return ((await res.json()) as { json: T }).json;
}

test("an agent gets a skill with its tool locked, and another tool; neither tool can be deleted meanwhile", async ({ page }) => {
  server ??= await startFakeMcp([{ name: "append_note" }]);
  await signIn(page);
  const notes = await rpc<{ id: string }>(page, "tools/create", { name: "Notes", url: server.url, transport: "streamable-http", headers: {} });
  const search = await rpc<{ id: string }>(page, "tools/create", { name: "Search", url: server.url, transport: "streamable-http", headers: {} });
  const { packageId } = await rpc<{ packageId: string }>(page, "skills/create", {
    name: "take-notes",
    description: "Use when the run should leave notes.",
    instructions: "Append a note with append_note.",
    requiredToolIds: [notes.id],
  });

  // Writer, from settings.spec.ts.
  await page.goto("/settings/agents");
  await page.getByRole("link", { name: /Writer/ }).click();
  await page.getByRole("checkbox", { name: /take-notes/ }).check();
  const tools = page.getByRole("region", { name: "Tools" });
  await expect(tools.getByRole("listitem").filter({ hasText: "Notes" })).toContainText("from skill take-notes");
  await expect(tools.getByRole("button", { name: "Remove Notes" })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Add a tool" }).click();
  await page.getByRole("option", { name: "Search" }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Agent saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("checkbox", { name: /take-notes/ })).toBeChecked();
  await expect(tools.getByRole("listitem")).toHaveText([/Notes.*from skill take-notes/, /Search/]);
  await shots(page, "agent-skills-tools");

  // The tool the agent chose: its action asks before use until the owner says otherwise, and that is kept.
  const chosen = tools.getByRole("listitem").filter({ hasText: "Search" });
  await chosen.getByText("1 action, 1 asks before use").click();
  // Whatever the one action the shared fake server lists is called.
  const ask = chosen.getByRole("switch", { name: /^Ask before Search / });
  await expect(ask).toBeChecked();
  await ask.click();
  await expect(chosen.getByText("1 action, 0 ask before use")).toBeVisible();
  await page.reload();
  await chosen.getByText("1 action, 0 ask before use").click();
  await expect(ask).not.toBeChecked();

  await page.goto("/settings/tools");
  await page.getByRole("button", { name: /^Notes/ }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("The skill “take-notes” requires this tool");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Search/ }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("The agent “Writer” uses this tool");
  await page.keyboard.press("Escape");

  // Back as it was for the specs that follow.
  await page.goto("/settings/agents");
  await page.getByRole("link", { name: /Writer/ }).click();
  await page.getByRole("checkbox", { name: /take-notes/ }).uncheck();
  await page.getByRole("button", { name: "Remove Search" }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Agent saved.")).toBeVisible();
  await rpc(page, "skills/delete", { packageId });
  await rpc(page, "tools/delete", { id: notes.id });
  await rpc(page, "tools/delete", { id: search.id });
});

test("a catalog runner entry becomes a runner tool once a runner reports it; its actions come through the runner", async ({ page }) => {
  await signIn(page);
  const { runnerId, pairingCode } = await rpc<{ runnerId: string; pairingCode: string }>(page, "runners/create", { name: "Toolbox" });
  const runner = await FakeRunner.pair("http://localhost:3100", pairingCode, { claude: "2.1.0" }, ["brave-search"]);
  try {
    await page.goto("/settings/tools");
    await page.getByRole("button", { name: "Browse catalog" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("button", { name: /^Brave Search/ }).click();
    await sheet.getByRole("button", { name: "Pick the runner" }).click();
    await expect(sheet.getByLabel("Name")).toHaveValue("Brave Search");
    await sheet.getByRole("combobox", { name: "Runner" }).click();
    await page.getByRole("option", { name: "Toolbox" }).click();
    await expect(sheet.getByRole("combobox", { name: "MCP server" })).toHaveText("brave-search");
    await shots(page, "runner-tool-add");

    await sheet.getByRole("button", { name: "Add tool" }).click();
    const discover = await runner.waitFor("tool.discover");
    expect(discover.tool).toBe("brave-search");
    runner.reply({
      type: "tool.discovered",
      requestId: discover.requestId,
      actions: [{ name: "brave_web_search", description: "Searches the web with Brave", inputSchema: { type: "object", properties: { query: { type: "string" } } } }],
    });
    await expect(sheet.getByText("brave_web_search")).toBeVisible();
    await shots(page, "runner-tool-actions");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: /^Brave Search/ })).toContainText("Runner · brave-search · 1 action");
  } finally {
    runner.close();
    const tools = await rpc<{ id: string; kind: string }[]>(page, "tools/list");
    for (const t of tools.filter((t) => t.kind === "runner")) await rpc(page, "tools/delete", { id: t.id });
    await rpc(page, "runners/revoke", { runnerId });
  }
});
