import { expect, test } from "vitest";
import { listModels, ModelListError } from "./models.ts";

const KEY = "sk-secret-0123456789";

function fake(status: number, body: unknown, calls: { url: string; init: RequestInit }[] = []) {
  return (async (url: URL | string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("anthropic lists /v1/models with its headers and display names", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const models = await listModels("anthropic", undefined, KEY, fake(200, { data: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }], has_more: false }, calls));
  expect(models).toEqual([{ id: "claude-opus-5-5", label: "Claude Opus 5.5" }]);
  expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/models?limit=1000");
  expect(calls[0]!.init.headers).toMatchObject({ "x-api-key": KEY, "anthropic-version": "2023-06-01" });
  expect(calls[0]!.init.redirect).toBe("error");
});

test("openai and compatible list /models with a bearer key", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  expect(await listModels("openai", undefined, KEY, fake(200, { data: [{ id: "gpt-6" }] }, calls))).toEqual([{ id: "gpt-6", label: "gpt-6" }]);
  expect(calls[0]!.url).toBe("https://api.openai.com/v1/models");
  expect(calls[0]!.init.headers).toEqual({ authorization: `Bearer ${KEY}` });
  await listModels("openai-compatible", "http://127.0.0.1:9/v1/", undefined, fake(200, { data: [] }, calls));
  expect(calls[1]!.url).toBe("http://127.0.0.1:9/v1/models");
  expect(calls[1]!.init.headers).toEqual({});
});

test("models maps a provider 401 to a clean error", async () => {
  const body = { error: { message: `Incorrect API key provided: ${KEY}` } };
  for (const status of [401, 403]) {
    const error = await listModels("openai", undefined, KEY, fake(status, body)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelListError);
    expect((error as Error).message).toBe("The provider refused the key");
  }
  for (const [status, reply] of [[500, body], [200, `not json ${KEY}`], [200, { data: `${KEY}` }]] as const) {
    const error = (await listModels("openai", "https://llm.test/v1", KEY, fake(status, reply)).catch((e: unknown) => e)) as Error;
    expect(error.message).toBe("Couldn't reach llm.test");
    expect(error.message).not.toContain(KEY);
  }
  const down = (async () => {
    throw new Error(`connect ECONNREFUSED with ${KEY}`);
  }) as typeof fetch;
  const error = (await listModels("anthropic", "https://llm.test", KEY, down).catch((e: unknown) => e)) as Error;
  expect(error.message).toBe("Couldn't reach llm.test");
});
