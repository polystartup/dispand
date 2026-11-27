import { expect, type Page } from "@playwright/test";

/** Calls an API procedure as the page's owner. */
export async function rpc<T>(page: Page, path: string, input?: unknown): Promise<T> {
  // maxRetries retries only ECONNRESET: a reused keep-alive socket the server closed while idle.
  const res = await page.request.post(`/api/rpc/${path}`, {
    maxRetries: 1,
    headers: { "x-csrf-token": "orpc" },
    data: input === undefined ? {} : { json: input },
  });
  expect(res.ok(), `${path}: ${res.status()}`).toBe(true);
  return ((await res.json()) as { json: T }).json;
}

/**
 * The agent "Writer", for a spec that needs an agent to pick: the one that is there, or a new one on a
 * cloud harness nothing is asked of, so the spec doesn't wait for settings.spec.ts to have made it.
 */
export async function writer(page: Page) {
  const found = (await rpc<{ id: string; name: string; harnessId: string }[]>(page, "agents/list")).find((a) => a.name === "Writer");
  if (found) return found;
  const harness = await rpc<{ id: string }>(page, "harnesses/create", {
    type: "cloud",
    name: "Writer's model",
    kind: "openai-compatible",
    baseUrl: "http://127.0.0.1:9/v1",
    model: "writer-model",
    systemPrompt: "",
  });
  const agent = await rpc<{ id: string; name: string; harnessId: string }>(page, "agents/create", {
    name: "Writer",
    harnessId: harness.id,
    systemPrompt: "You write short, clear notes.",
  });
  return agent;
}

/** Stem, started on that harness (Writer's by default) when it isn't yet: Home is Home from then on, and its platform skill is there. */
export async function stem(page: Page, harnessId?: string) {
  await rpc(page, "agents/ensureAssistant", { harnessId: harnessId ?? (await writer(page)).harnessId });
}
