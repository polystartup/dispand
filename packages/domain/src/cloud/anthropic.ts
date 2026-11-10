import Anthropic from "@anthropic-ai/sdk";
import { parseArgs, strictCompatible, type ChatItem, type ClientDeps, type ClientHarness, type ModelClient, type ModelTurn } from "./model-client.ts";

const DEFAULT_MAX_TOKENS = 64_000;

// Messages API. No `temperature`: API version 2026-10-21 refuses sampling parameters; `effort`
// takes its place. Thinking is adaptive and its blocks go back unchanged in `raw`.
export function createAnthropicClient(h: ClientHarness, deps: ClientDeps): ModelClient {
  // The harness's key and URL only: an empty key fails at the provider instead of falling back
  // to the server's environment or a local `ant` profile.
  // The SDK logs nothing: it would write raw provider data (which may echo the key) to the console.
  const client = new Anthropic({ apiKey: h.apiKey ?? "", baseURL: h.baseUrl ?? "https://api.anthropic.com", fetch: deps.fetch, logLevel: "off" });
  return {
    async turn({ system, items, tools, signal, onText }) {
      const stream = client.messages.stream(
        {
          model: h.model,
          max_tokens: h.maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(system ? { system } : {}),
          messages: toMessages(items),
          ...(tools.length > 0
            ? {
                tools: tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
                  ...(strictCompatible(t.inputSchema) ? { strict: true } : {}),
                })),
                tool_choice: { type: "auto" as const },
              }
            : {}),
          thinking: { type: "adaptive" },
          ...(h.effort ? { output_config: { effort: h.effort } } : {}),
          cache_control: { type: "ephemeral" },
        },
        { signal },
      );
      // Tool input as the model wrote it, so a cut or malformed one is seen as such (the SDK's
      // own parse is tolerant and would hand back a partial object).
      const json = new Map<number, string>();
      for await (const event of stream) {
        if (event.type !== "content_block_delta") continue;
        if (event.delta.type === "text_delta") onText(event.delta.text);
        else if (event.delta.type === "input_json_delta") json.set(event.index, (json.get(event.index) ?? "") + event.delta.partial_json);
      }
      const message = await stream.finalMessage();
      signal.throwIfAborted();
      const toolCalls = message.content.flatMap((block, i) =>
        block.type === "tool_use" ? [{ id: block.id, name: block.name, args: json.has(i) ? parseArgs(json.get(i)!) : block.input }] : [],
      );
      const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      return { text, toolCalls, raw: message.content, stop: stopOf(message.stop_reason) };
    },
  };
}

function stopOf(reason: Anthropic.StopReason | null): ModelTurn["stop"] {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "end";
  }
}

// Tool results and the user text that follows them share one user message, as the API expects.
function toMessages(items: ChatItem[]): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  const userBlocks = (): Anthropic.ContentBlockParam[] => {
    const last = messages.at(-1);
    if (last?.role === "user" && Array.isArray(last.content)) return last.content;
    const content: Anthropic.ContentBlockParam[] = [];
    messages.push({ role: "user", content });
    return content;
  };
  for (const item of items) {
    if (item.role === "assistant") messages.push({ role: "assistant", content: item.raw as Anthropic.ContentBlockParam[] });
    else if (item.role === "user") userBlocks().push({ type: "text", text: item.text });
    else userBlocks().push({ type: "tool_result", tool_use_id: item.callId, content: item.result, is_error: item.isError });
  }
  return messages;
}
