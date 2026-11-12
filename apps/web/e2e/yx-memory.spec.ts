import { expect as baseExpect, test, type Page } from "@playwright/test";
import { lastResult, startFakeModel, type FakeModel } from "./fake-model.ts";

// Memory's acceptance: a Job of an agent that learns into its own memory writes an entry, and the
// next Job of that agent starts with it in its system prompt. A cloud harness on a scripted model.
const WAIT_MS = 20_000;
const expect = baseExpect.configure({ timeout: WAIT_MS });
test.describe.configure({ timeout: 120_000 });

let model: FakeModel | undefined;
test.afterAll(() => model?.close());

async function signIn(page: Page) {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function rpc<T>(page: Page, path: string, input?: unknown): Promise<T> {
  const res = await page.request.post(`/api/rpc/${path}`, { headers: { "x-csrf-token": "orpc" }, data: input === undefined ? {} : { json: input } });
  expect(res.ok(), `${path}: ${res.status()}`).toBe(true);
  return ((await res.json()) as { json: T }).json;
}

/** Starts a Job of the trigger and waits for it to succeed. */
async function runJob(page: Page, triggerId: string) {
  const { runId } = await rpc<{ runId: string }>(page, "jobs/start", { triggerId });
  await expect.poll(async () => (await rpc<{ status: string }>(page, "jobs/get", { id: runId })).status, { timeout: WAIT_MS }).toBe("succeeded");
}

test("a Job writes an entry to its agent's memory, and the agent's next Job reads it in its prompt", async ({ page }) => {
  model = await startFakeModel("memory-model");
  await signIn(page);
  const harness = await rpc<{ id: string }>(page, "harnesses/create", { type: "cloud", name: "Memory model", kind: "openai-compatible", baseUrl: model.baseUrl, model: "memory-model", systemPrompt: "" });
  const agent = await rpc<{ id: string }>(page, "agents/create", { name: "Bookkeeper", harnessId: harness.id, systemPrompt: "Keep the books.", selfLearning: ["agent"] });
  const trigger = await rpc<{ id: string }>(page, "triggers/create", { agentId: agent.id, name: "Close the month", instructions: "Close the month.", config: { kind: "manual", placement: "button" } });

  const body = "Invoices from Northwind are paid on the 15th, never earlier.";
  model.script(
    () => ({ text: "I'll remember that.", call: { name: "memory_add", args: { scope: "agent", path: "suppliers/northwind.md", name: "Northwind pays on the 15th", description: "When Northwind's invoices are paid", type: "fact", body } } }),
    () => ({ text: "Month closed." }),
  );
  await runJob(page, trigger.id);
  // The entry landed, and wasn't in this Job's prompt.
  expect(lastResult(model.requests[1]!)).toEqual({ path: "suppliers/northwind.md" });
  expect(model.requests[0]![0]).toMatchObject({ role: "system" });
  expect(model.requests[0]![0]!.content).not.toContain("Northwind");

  model.script(() => ({ text: "Month closed again." }));
  await runJob(page, trigger.id);
  const system = model.requests.at(-1)![0]!.content ?? "";
  expect(system).toContain("Keep the books.");
  expect(system).toContain("## This agent");
  expect(system).toContain("- [Northwind pays on the 15th](suppliers/northwind.md): When Northwind's invoices are paid");
  expect(system).toContain(`### suppliers/northwind.md\n\n${body}`);
});
