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
  const server = await startFakeMcp([{ name: "lookup", call: () => ({ content: [{ type: "text", text: "sentinel-tool-answer-35" }] }) }]);
  try {
    await signIn(page);
    // A tool with a secret in its header, its path and its query: listing its actions calls it.
    await rpc(page, "tools/create", { name: "Sentinel", url: `${server.url}/${SENTINELS.path}?key=${SENTINELS.query}`, transport: "streamable-http", headers: { authorization: SENTINELS.header } });
    // A row value.
    const table = await rpc<{ id: string }>(page, "tables/create", { name: "Telemetry sentinels" });
    const { fields } = await rpc<{ fields: { id: string }[] }>(page, "tables/get", { id: table.id });
    await rpc(page, "rows/create", { tableId: table.id, values: { [fields[0]!.id]: SENTINELS.row } });
  } finally {
    await server.close();
  }
  // Spans, logs and metrics are sent every fraction of a second: wait until the calls above are in.
  let dump = "";
  await expect(async () => {
    dump = JSON.stringify(await (await fetch(`${COLLECTOR}/dump`)).json());
    expect(dump).toContain("rows.create");
    expect(dump).toContain("dispand.rpc.duration");
  }).toPass({ timeout: 20_000 });
  for (const [what, sentinel] of Object.entries({ ...SENTINELS, answer: "sentinel-tool-answer-35" })) {
    expect(dump.includes(sentinel), `${what} found in exported telemetry`).toBe(false);
  }
});
