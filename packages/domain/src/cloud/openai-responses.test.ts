import { describe, expect, it } from "vitest";
import { collect, fakeFetch } from "./fake-fetch.ts";
import { createModelClient, type ChatItem, type ToolSpec } from "./model-client.ts";

const harness = { kind: "openai" as const, model: "gpt-5.6", systemPrompt: "", apiKey: "sk-test", effort: "low" as const, maxTokens: 8000 };
const tools: ToolSpec[] = [
  {
    name: "web_search",
    description: "Search the web",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
  },
];
const user: ChatItem = { role: "user", text: "Find dispand" };

describe("openai responses client", () => {
  it("sends text deltas to onText", async () => {
    const { fetch } = fakeFetch("responses-tool-use.sse");
    const c = collect();
    const turn = await createModelClient(harness, { fetch }).turn({ system: "", items: [user], tools, ...c });
    expect(c.deltas).toEqual(["Let me ", "search."]);
    expect(turn.text).toBe("Let me search.");
  });

  it("parses a tool call with its id and args", async () => {
    const { fetch } = fakeFetch("responses-tool-use.sse");
    const turn = await createModelClient(harness, { fetch }).turn({ system: "", items: [user], tools, ...collect() });
    expect(turn.stop).toBe("tool_use");
    expect(turn.toolCalls).toEqual([{ id: "call_01", name: "web_search", args: { query: "dispand", limit: 3 } }]);
  });

  it("replays the output items unchanged on the next turn", async () => {
    const { fetch, sent } = fakeFetch("responses-tool-use.sse", "responses-end.sse");
    const client = createModelClient(harness, { fetch });
    const first = await client.turn({ system: "", items: [user], tools, ...collect() });
    const items: ChatItem[] = [
      user,
      { role: "assistant", text: first.text, toolCalls: first.toolCalls, raw: first.raw },
      { role: "tool", callId: "call_01", name: "web_search", result: "3 results", isError: false },
    ];
    const second = await client.turn({ system: "", items, tools, ...collect() });
    expect(second.stop).toBe("end");
    expect(second.text).toBe("Done.");

    const input = sent[1]!.body.input as unknown[];
    expect(input).toEqual([
      { role: "user", content: "Find dispand" },
      ...(first.raw as unknown[]),
      { type: "function_call_output", call_id: "call_01", output: "3 results" },
    ]);
    expect(sent[1]!.text).toContain('{"type":"reasoning","id":"rs_01","summary":[],"encrypted_content":"gAAAAABencrypted=="}');
  });

  it("maps a refusal to stop refusal", async () => {
    const { fetch } = fakeFetch("responses-refusal.sse");
    const turn = await createModelClient(harness, { fetch }).turn({ system: "", items: [user], tools, ...collect() });
    expect(turn.stop).toBe("refusal");
  });

  it("turns invalid tool JSON into __invalid", async () => {
    const { fetch } = fakeFetch("responses-invalid-json.sse");
    const turn = await createModelClient(harness, { fetch }).turn({ system: "", items: [user], tools, ...collect() });
    expect(turn.stop).toBe("max_tokens");
    expect(turn.toolCalls).toEqual([{ id: "call_04", name: "web_search", args: { __invalid: '{"query":"unfinish' } }]);
  });

  it("sends instructions, strict tools, store false and effort", async () => {
    const { fetch, sent } = fakeFetch("responses-end.sse");
    await createModelClient({ ...harness, temperature: 0.3 }, { fetch }).turn({ system: "Be brief.", items: [user], tools, ...collect() });
    const body = sent[0]!.body;
    expect(sent[0]!.url).toBe("https://api.openai.com/v1/responses");
    expect(body).not.toHaveProperty("temperature");
    expect(body).toMatchObject({
      model: "gpt-5.6",
      instructions: "Be brief.",
      store: false,
      stream: true,
      max_output_tokens: 8000,
      reasoning: { effort: "low" },
      tools: [{ type: "function", name: "web_search", description: "Search the web", parameters: tools[0]!.inputSchema, strict: true }],
    });
  });

  it("uses the harness key, never the environment's", async () => {
    process.env.OPENAI_API_KEY = "sk-from-env";
    process.env.OPENAI_BASE_URL = "https://env.example/v1";
    try {
      const { fetch, sent } = fakeFetch("responses-end.sse");
      await createModelClient(harness, { fetch }).turn({ system: "", items: [user], tools: [], ...collect() });
      expect(sent[0]!.url).toBe("https://api.openai.com/v1/responses");
      expect(sent[0]!.headers.get("authorization")).toBe("Bearer sk-test");
      expect(sent[0]!.body).not.toHaveProperty("tools");
    } finally {
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_BASE_URL;
    }
  });

  it("leaves strict off for a schema strict mode refuses", async () => {
    const { fetch, sent } = fakeFetch("responses-end.sse");
    const loose = { name: "fetch", description: "Fetch a URL", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } };
    await createModelClient(harness, { fetch }).turn({ system: "", items: [user], tools: [...tools, loose], ...collect() });
    const sentTools = sent[0]!.body.tools as Record<string, unknown>[];
    expect(sentTools.map((t) => t.strict)).toEqual([true, false]);
  });

  it("throws instead of returning tool calls when the turn is cancelled", async () => {
    const { fetch } = fakeFetch("responses-tool-use.sse");
    const controller = new AbortController();
    const turn = createModelClient(harness, { fetch }).turn({
      system: "", items: [user], tools, signal: controller.signal, onText: () => controller.abort(),
    });
    await expect(turn).rejects.toThrow();
  });
});
