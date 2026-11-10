import { describe, expect, it, vi } from "vitest";
import { collect, fakeFetch, fixture } from "./fake-fetch.ts";
import { createModelClient, type ChatItem, type ToolSpec } from "./model-client.ts";

const harness = { kind: "anthropic" as const, model: "claude-opus-5-5", systemPrompt: "", apiKey: "sk-ant-test", effort: "high" as const };
const tools: ToolSpec[] = [
  {
    name: "web_search",
    description: "Search the web",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
  },
];
const user: ChatItem = { role: "user", text: "Find dispand" };

describe("anthropic client", () => {
  it("sends text deltas to onText", async () => {
    const { fetch } = fakeFetch("anthropic-tool-use.sse");
    const c = collect();
    const turn = await createModelClient(harness, { fetch }).turn({ system: "Be brief.", items: [user], tools, ...c });
    expect(c.deltas).toEqual(["Let me ", "search."]);
    expect(turn.text).toBe("Let me search.");
  });

  it("parses a tool call with its id and args", async () => {
    const { fetch } = fakeFetch("anthropic-tool-use.sse");
    const turn = await createModelClient(harness, { fetch }).turn({ system: "", items: [user], tools, ...collect() });
    expect(turn.stop).toBe("tool_use");
    expect(turn.toolCalls).toEqual([{ id: "toolu_01", name: "web_search", args: { query: "dispand", limit: 3 } }]);
  });

  it("replays the assistant's raw content unchanged on the next turn", async () => {
    const { fetch, sent } = fakeFetch("anthropic-tool-use.sse", "anthropic-end.sse");
    const client = createModelClient(harness, { fetch });
    const first = await client.turn({ system: "", items: [user], tools, ...collect() });
    const items: ChatItem[] = [
      user,
      { role: "assistant", text: first.text, toolCalls: first.toolCalls, raw: first.raw },
      { role: "tool", callId: "toolu_01", name: "web_search", result: "3 results", isError: false },
    ];
    const second = await client.turn({ system: "", items, tools, ...collect() });
    expect(second.stop).toBe("end");

    const messages = sent[1]!.body.messages as { role: string; content: unknown }[];
    expect(messages[1]).toEqual({ role: "assistant", content: first.raw });
    // The thinking block goes back byte for byte, signature included.
    const thinking = '{"type":"thinking","thinking":"The user wants a search.","signature":"EqQBCkYIBxgCKkDu3sig+/=="}';
    expect(sent[1]!.text).toContain(thinking);
    expect(fixture("anthropic-tool-use.sse")).toContain('"thinking":"The user wants a search."');
    expect(messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "3 results", is_error: false }],
    });
  });

  it("maps a refusal to stop refusal", async () => {
    const { fetch } = fakeFetch("anthropic-refusal.sse");
    const turn = await createModelClient(harness, { fetch }).turn({ system: "", items: [user], tools, ...collect() });
    expect(turn.stop).toBe("refusal");
  });

  it("turns invalid tool JSON into __invalid", async () => {
    const { fetch } = fakeFetch("anthropic-invalid-json.sse");
    const turn = await createModelClient(harness, { fetch }).turn({ system: "", items: [user], tools, ...collect() });
    expect(turn.stop).toBe("max_tokens");
    expect(turn.toolCalls).toEqual([{ id: "toolu_02", name: "web_search", args: { __invalid: '{"query": "unfinish' } }]);
  });

  it("sends no temperature, tool_choice auto, strict tools, effort and top-level caching", async () => {
    const { fetch, sent } = fakeFetch("anthropic-end.sse");
    await createModelClient({ ...harness, temperature: 0.2 }, { fetch }).turn({ system: "Be brief.", items: [user], tools, ...collect() });
    const body = sent[0]!.body;
    expect(sent[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(body).not.toHaveProperty("temperature");
    expect(body).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 64000,
      stream: true,
      system: "Be brief.",
      tool_choice: { type: "auto" },
      output_config: { effort: "high" },
      cache_control: { type: "ephemeral" },
      tools: [{ name: "web_search", description: "Search the web", input_schema: tools[0]!.inputSchema, strict: true }],
      messages: [{ role: "user", content: [{ type: "text", text: "Find dispand" }] }],
    });
  });

  it("uses the harness key and base URL, never the environment's", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-from-env";
    process.env.ANTHROPIC_BASE_URL = "https://env.example";
    try {
      const { fetch, sent } = fakeFetch("anthropic-end.sse");
      await createModelClient({ ...harness, baseUrl: "https://proxy.example/anthropic" }, { fetch }).turn({ system: "", items: [user], tools: [], ...collect() });
      expect(sent[0]!.url).toBe("https://proxy.example/anthropic/v1/messages");
      expect(JSON.stringify([...sent[0]!.headers])).toContain("sk-ant-test");
      expect(JSON.stringify([...sent[0]!.headers])).not.toContain("sk-ant-from-env");
      expect(sent[0]!.body).not.toHaveProperty("tools");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_BASE_URL;
    }
  });

  it("leaves strict off for a schema strict mode refuses", async () => {
    const { fetch, sent } = fakeFetch("anthropic-end.sse");
    const loose = { name: "fetch", description: "Fetch a URL", inputSchema: { type: "object", properties: { url: { type: "string" }, max: { type: "number" } }, required: ["url"] } };
    await createModelClient(harness, { fetch }).turn({ system: "", items: [user], tools: [...tools, loose], ...collect() });
    const sentTools = sent[0]!.body.tools as Record<string, unknown>[];
    expect(sentTools[0]).toHaveProperty("strict", true);
    expect(sentTools[1]).not.toHaveProperty("strict");
  });

  it("throws instead of returning tool calls when the turn is cancelled", async () => {
    const { fetch } = fakeFetch("anthropic-tool-use.sse");
    const controller = new AbortController();
    const turn = createModelClient(harness, { fetch }).turn({
      system: "", items: [user], tools, signal: controller.signal, onText: () => controller.abort(),
    });
    await expect(turn).rejects.toThrow();
  });

  it("logs nothing when the provider sends data it can't parse (it may echo the key)", async () => {
    const body = `event: content_block_delta\ndata: {not json sk-ant-test\n\n`;
    const fetch = (async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof globalThis.fetch;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    // The environment can turn the SDK's console logging on: the harness's client stays silent.
    process.env.ANTHROPIC_LOG = "debug";
    try {
      await expect(createModelClient(harness, { fetch }).turn({ system: "", items: [user], tools, ...collect() })).rejects.toThrow();
      expect(JSON.stringify([logged.mock.calls, warned.mock.calls])).not.toContain("sk-ant-test");
    } finally {
      delete process.env.ANTHROPIC_LOG;
      logged.mockRestore();
      warned.mockRestore();
    }
  });
});
