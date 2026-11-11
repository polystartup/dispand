import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { tools } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";
import { CATALOG, searchCatalog } from "./catalog.ts";
import type { ToolConnector, ToolTarget } from "./mcp.ts";
import { toolTarget } from "./procedures.ts";

/** Never the real servers: a connector that records where it was sent and lists one action. */
function recording() {
  const targets: ToolTarget[] = [];
  const connector: ToolConnector = {
    listActions: async (target) => {
      targets.push(target);
      return [{ name: "create_repository", description: "", inputSchema: { type: "object" } }];
    },
    callAction: async () => ({ text: "", isError: false }),
    authorize: async () => null,
    finishAuthorization: async () => undefined,
  };
  return { connector, targets };
}

async function setup() {
  const fake = recording();
  const context = { ...(await ownerContext()), tools: fake.connector };
  return { context, targets: fake.targets };
}

test('installing github seals "Bearer x" in Authorization', async () => {
  const { context, targets } = await setup();
  const result = await call(router.tools.installFromCatalog, { catalogId: "github", settings: { token: "ghp_x123" } }, { context });
  if (!("tool" in result)) throw new Error("expected a tool");
  expect(result.tool).toMatchObject({ name: "GitHub", url: "https://api.githubcopilot.com/mcp/", headerNames: ["authorization"], catalogId: "github" });
  expect(result.tool.actions.map((a) => a.name)).toEqual(["create_repository"]);
  expect(targets).toEqual([{ url: "https://api.githubcopilot.com/mcp/", transport: "streamable-http", headers: { authorization: "Bearer ghp_x123" } }]);
  expect(JSON.stringify(result)).not.toContain("ghp_x123");
  const [row] = await context.db.select().from(tools).where(eq(tools.id, result.tool.id));
  expect(JSON.stringify(row)).not.toContain("ghp_x123");
  expect(toolTarget(row!, context.secrets).headers).toEqual({ authorization: "Bearer ghp_x123" });
});

test("a missing setting is BAD_REQUEST naming it", async () => {
  const { context, targets } = await setup();
  await expect(call(router.tools.installFromCatalog, { catalogId: "github", settings: { token: " " } }, { context })).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: "Personal access token is required",
  });
  await expect(call(router.tools.installFromCatalog, { catalogId: "nope", settings: {} }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(targets).toEqual([]);
  expect(await call(router.tools.list, undefined, { context })).toEqual([]);
});

test("a name can be chosen, and a taken one is CONFLICT", async () => {
  const { context } = await setup();
  await call(router.tools.installFromCatalog, { catalogId: "firecrawl", settings: { apiKey: "fc-1" } }, { context });
  await expect(call(router.tools.installFromCatalog, { catalogId: "firecrawl", settings: { apiKey: "fc-1" } }, { context })).rejects.toMatchObject({
    code: "CONFLICT",
  });
  const second = await call(router.tools.installFromCatalog, { catalogId: "firecrawl", name: "Firecrawl (team)", settings: { apiKey: "fc-2" } }, { context });
  expect("tool" in second && second.tool.name).toBe("Firecrawl (team)");
});

test("search matches name and description, case-insensitive", async () => {
  expect(searchCatalog("GITHUB").map((e) => e.id)).toEqual(["github"]);
  expect(searchCatalog("markdown").map((e) => e.id).sort()).toEqual(["fetch", "firecrawl"]);
  expect(searchCatalog().length).toBe(CATALOG.length);
  const { context } = await setup();
  expect((await call(router.tools.catalog, { query: "brave" }, { context })).map((e) => e.id)).toEqual(["brave-search"]);
});

test("a runner entry returns a snippet without any value", async () => {
  const { context, targets } = await setup();
  const result = await call(router.tools.installFromCatalog, { catalogId: "brave-search", settings: { BRAVE_API_KEY: "should-not-appear" } }, { context });
  if (!("runnerSnippet" in result)) throw new Error("expected a snippet");
  expect(JSON.parse(result.runnerSnippet)).toEqual({
    "brave-search": { command: "npx", args: ["-y", "@brave/brave-search-mcp-server"], env: { BRAVE_API_KEY: "<your key>" } },
  });
  expect(result.runnerSnippet).not.toContain("should-not-appear");
  expect(targets).toEqual([]);
  expect(await call(router.tools.list, undefined, { context })).toEqual([]);
});
