import { describe, expect, it, vi } from "vitest";
import { collect, fakeFetch } from "./fake-fetch.ts";
import { createModelClient, type ChatItem, type ToolSpec } from "./model-client.ts";

const harness = {
  kind: "openai-compatible" as const,
  baseUrl: "http://llm.local:8000/v1",
  model: "llama-4",
  systemPrompt: "",
  temperature: 0.2,
  maxTokens: 4000,
};
const tools: ToolSpec[] = [
  {
    name: "web_search",
    description: "Search the web",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
];
const user: ChatItem = { role: "user", text: "Find dispand" };

describe("openai-compatible chat client", () => {
  it("sends text deltas to onText", async () => {
    const { fetch } = fakeFetch("chat-tool-use.sse");
    const c = collect();
    const turn = await createModelClient(harness, { fetch }).turn({ system: "", items: [user], tools, ...c });
    expect(c.deltas).toEqual(["Let me ", "search."]);
    expect(turn.text).toBe("Let me search.");
  });

  it("parses a tool call with its id and args", async () => {
    const { fetch } = fakeFetch("chat-tool-use.sse");
    const turn = await createModelClient(harness, { fetch }).turn({ system: "", items: [user], tools, ...collect() });
    expect(turn.stop).toBe("tool_use");
    expect(turn.toolCalls).toEqual([{ id: "call_01", name: "web_search", args: { query: "dispand", limit: 3 } }]);
  });

  it("replays the assistant message unchanged on the next turn", async () => {
    const { fetch, sent } = fakeFetch("chat-tool-use.sse", "chat-end.sse");
    const client = createModelClient(harness, { fetch });
    const first = await client.turn({ system: "Be brief.", items: [user], tools, ...collect() });
    const items: ChatItem[] = [
      user,
      { role: "assistant", text: first.text, toolCalls: first.toolCalls, raw: first.raw },
      { role: "tool", callId: "call_01", name: "web_search", result: "3 results", isError: false },
    ];
    const second = await client.turn({ system: "Be brief.", items, tools, ...collect() });
    expect(second.stop).toBe("end");

    expect(first.raw).toEqual({
      role: "assistant",
      content: "Let me search.",
      tool_calls: [{ id: "call_01", type: "function", function: { name: "web_search", arguments: '{"query":"dispand","limit":3}' } }],
    });
    expect(sent[1]!.body.messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "Find dispand" },
      first.raw,
      { role: "tool", tool_call_id: "call_01", content: "3 results" },
    ]);
  });

  it("maps a refusal to stop refusal", async () => {
    const { fetch } = fakeFetch("chat-refusal.sse");
    const turn = await createModelClient(harness, { fetch }).turn({ system: "", items: [user], tools, ...collect() });
    expect(turn.stop).toBe("refusal");
  });

  it("turns invalid tool JSON into __invalid", async () => {
    const { fetch } = fakeFetch("chat-invalid-json.sse");
    const turn = await createModelClient(harness, { fetch }).turn({ system: "", items: [user], tools, ...collect() });
    expect(turn.stop).toBe("max_tokens");
    expect(turn.toolCalls).toEqual([{ id: "call_04", name: "web_search", args: { __invalid: '{"query":"unfinish' } }]);
  });

  it("sends tools, temperature and max tokens to the base URL, without a key when it has none", async () => {
    process.env.OPENAI_API_KEY = "sk-from-env";
    try {
      const { fetch, sent } = fakeFetch("chat-end.sse");
      await createModelClient(harness, { fetch }).turn({ system: "", items: [user], tools, ...collect() });
      expect(sent[0]!.url).toBe("http://llm.local:8000/v1/chat/completions");
      expect(sent[0]!.headers.get("authorization")).toBeNull();
      expect(sent[0]!.body).toMatchObject({
        model: "llama-4",
        stream: true,
        temperature: 0.2,
        max_tokens: 4000,
        tools: [{ type: "function", function: { name: "web_search", description: "Search the web", parameters: tools[0]!.inputSchema } }],
        messages: [{ role: "user", content: "Find dispand" }],
      });
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("sends the harness key when it has one", async () => {
    const { fetch, sent } = fakeFetch("chat-end.sse");
    await createModelClient({ ...harness, apiKey: "sk-local" }, { fetch }).turn({ system: "", items: [user], tools: [], ...collect() });
    expect(sent[0]!.headers.get("authorization")).toBe("Bearer sk-local");
    expect(sent[0]!.body).not.toHaveProperty("tools");
  });

  it("throws instead of returning tool calls when the turn is cancelled", async () => {
    const { fetch } = fakeFetch("chat-tool-use.sse");
    const controller = new AbortController();
    const turn = createModelClient(harness, { fetch }).turn({
      system: "", items: [user], tools, signal: controller.signal, onText: () => controller.abort(),
    });
    await expect(turn).rejects.toThrow();
  });

  it("throws when the stream ends before a finish reason", async () => {
    const { fetch } = fakeFetch("chat-cut.sse");
    await expect(createModelClient(harness, { fetch }).turn({ system: "", items: [user], tools, ...collect() })).rejects.toThrow(
      "The model's stream ended before the response did",
    );
  });

  it("logs nothing when the server sends data it can't parse (it may echo the key)", async () => {
    const body = `data: {not json sk-compat-test\n\n`;
    const fetch = (async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof globalThis.fetch;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.OPENAI_LOG = "debug";
    try {
      await expect(createModelClient({ ...harness, apiKey: "sk-compat-test" }, { fetch }).turn({ system: "", items: [user], tools, ...collect() })).rejects.toThrow();
      expect(JSON.stringify([logged.mock.calls, warned.mock.calls])).not.toContain("sk-compat-test");
    } finally {
      delete process.env.OPENAI_LOG;
      logged.mockRestore();
      warned.mockRestore();
    }
  });
});

