import { expect, test, type Page } from "@playwright/test";
import { startFakeMcp } from "../../../packages/domain/src/tools/test-server.ts";

// Last of "main": after every other spec has run, with sentinel secrets and content of its own,
// nothing Dispand exported to its collector holds a secret or a business's content.

const COLLECTOR = "http://127.0.0.1:3199";

const SENTINELS = {
  header: "Bearer sentinel-tool-header-31",
  query: "sentinel-url-query-32",
  path: "sentinel-url-path-33",
  row: "sentinel-row-value-34",
  password: "correct horse battery",
  argument: "sentinel-tool-argument-36",
};

async function signIn(page: Page) {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill(SENTINELS.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function rpc<T>(page: Page, path: string, input?: unknown): Promise<T> {
  const res = await page.request.post(`/api/rpc/${path}`, { headers: { "x-csrf-token": "orpc" }, data: input === undefined ? {} : { json: input } });
  expect(res.ok(), `${path}: ${res.status()}`).toBe(true);
  return ((await res.json()) as { json: T }).json;
}

test("telemetry exported during the whole suite holds no secret and no content", async ({ page }) => {
  const calls: unknown[] = [];
  const server = await startFakeMcp([
    {
      name: "lookup",
      inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      call: (args) => (calls.push(args), { content: [{ type: "text", text: "sentinel-tool-answer-35" }] }),
    },
  ]);
  let toolId: string;
  try {
    await signIn(page);
    // A tool with a secret in its header, its path and its query: listing its actions calls it.
    ({ id: toolId } = await rpc<{ id: string }>(page, "tools/create", {
      name: "Sentinel",
      url: `${server.url}/${SENTINELS.path}?key=${SENTINELS.query}`,
      transport: "streamable-http",
      headers: { authorization: SENTINELS.header },
    }));
    // A row value.
    const table = await rpc<{ id: string }>(page, "tables/create", { name: "Telemetry sentinels" });
    const { fields } = await rpc<{ fields: { id: string }[] }>(page, "tables/get", { id: table.id });
    await rpc(page, "rows/create", { tableId: table.id, values: { [fields[0]!.id]: SENTINELS.row } });
    // The tool called with a sentinel argument, and answering with a sentinel: a workflow's Tool step.
    const workflow = await rpc<{ id: string }>(page, "workflows/create", { name: "Telemetry sentinels" });
    await rpc(page, "workflows/update", {
      id: workflow.id,
      name: "Telemetry sentinels",
      def: {
        trigger: { type: "manual", field: { id: "n_go", key: "go", type: "button", label: "Go" } },
        steps: [{ id: "n_look", key: "look", type: "tool", name: "Look up", toolId, action: "lookup", inputs: [{ param: "q", source: { type: "value", value: SENTINELS.argument } }] }],
        edges: [{ from: "n_go", to: "n_look" }],
      },
    });
    await rpc(page, "runs/start", { workflowId: workflow.id });
    await expect.poll(() => calls.length, { timeout: 20_000 }).toBe(1);
  } finally {
    await server.close();
  }
  // This test's own work is in once the tool call's span (named by the tool's id) arrived;
  // a later read takes whatever was still buffered then.
  const dump = async () => JSON.stringify(await (await fetch(`${COLLECTOR}/dump`)).json());
  await expect.poll(dump, { timeout: 20_000 }).toContain(toolId);
  await page.waitForTimeout(2_000);
  const exported = await dump();
  expect(exported).toContain("tool.call");
  for (const [what, sentinel] of Object.entries({ ...SENTINELS, answer: "sentinel-tool-answer-35" })) {
    expect(exported.includes(sentinel), `${what} found in exported telemetry`).toBe(false);
  }
});
