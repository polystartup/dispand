import OpenAI from "openai";
import { fileInput, parseArgs, type ChatFile, type ChatItem, type ClientDeps, type ClientHarness, type ModelClient, type ModelTurn } from "./model-client.ts";
import { openAIClient } from "./openai-responses.ts";

type Message = OpenAI.Chat.ChatCompletionMessageParam;
type Assistant = OpenAI.Chat.ChatCompletionAssistantMessageParam;

// Chat Completions on any OpenAI-compatible server (base URL required, key optional). The
// assistant message is rebuilt from the stream and replayed as such.

// The servers that refused `stream_options` (some strict gateways do), by base URL and model: asked without it from then on, as a client is made per call.
const refusesUsage = new Set<string>();

export function createChatClient(h: ClientHarness, deps: ClientDeps): ModelClient {
  const client = openAIClient(h, h.baseUrl ?? "", deps);
  const server = JSON.stringify([h.baseUrl ?? "", h.model]);
  return {
    async turn({ system, items, tools, signal, onText }) {
      const create = (withUsage: boolean) => client.chat.completions.create(
        {
          model: h.model,
          messages: [...(system ? [{ role: "system" as const, content: system }] : []), ...toMessages(items)],
          stream: true,
          ...(withUsage ? { stream_options: { include_usage: true } } : {}),
          ...(tools.length > 0
            ? { tools: tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.inputSchema } })) }
            : {}),
          ...(h.temperature !== undefined ? { temperature: h.temperature } : {}),
          ...(h.maxTokens ? { max_tokens: h.maxTokens } : {}),
        },
        { signal },
      );
      // Retried on what this request sent: another turn may have learned of the refusal meanwhile.
      const withUsage = !refusesUsage.has(server);
      const stream = await create(withUsage).catch((err: unknown) => {
        if (!withUsage || !(err instanceof OpenAI.APIError) || err.status !== 400 || !/stream_options|include_usage/i.test(err.message)) throw err;
        refusesUsage.add(server);
        return create(false);
      });
      let text = "";
      let refusal = "";
      let finish: string | null = null;
      let usage: ModelTurn["usage"];
      const calls: { id: string; name: string; arguments: string }[] = [];
      for await (const chunk of stream) {
        // The last chunk, with no choice, carries the counts.
        if (chunk.usage) usage = { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens };
        const choice = chunk.choices[0];
        if (!choice) continue;
        const { delta } = choice;
        if (delta.content) {
          text += delta.content;
          onText(delta.content);
        }
        if (delta.refusal) refusal += delta.refusal;
        for (const tc of delta.tool_calls ?? []) {
          const call = (calls[tc.index] ??= { id: "", name: "", arguments: "" });
          if (tc.id) call.id = tc.id;
          if (tc.function?.name) call.name += tc.function.name;
          if (tc.function?.arguments) call.arguments += tc.function.arguments;
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
      // A cancelled or cut stream can end without an error: its tool calls must not run.
      signal.throwIfAborted();
      if (finish === null) throw new Error("The model's stream ended before the response did");
      const present = calls.filter(Boolean);
      const raw: Assistant = {
        role: "assistant",
        content: text,
        ...(refusal ? { refusal } : {}),
        ...(present.length > 0
          ? { tool_calls: present.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments } })) }
          : {}),
      };
      const stop: ModelTurn["stop"] =
        finish === "length" ? "max_tokens"
        : finish === "content_filter" || refusal ? "refusal"
        : present.length > 0 ? "tool_use"
        : "end";
      return { text, toolCalls: present.map((c) => ({ id: c.id, name: c.name, args: parseArgs(c.arguments) })), raw, stop, ...(usage ? { usage } : {}) };
    },
  };
}

function filePart(file: ChatFile): OpenAI.Chat.ChatCompletionContentPart {
  // Not every server behind this API takes a PDF part, and one it refuses would end the session: none is sent.
  const input = fileInput(file, { pdf: false });
  if (input.kind === "image") return { type: "image_url", image_url: { url: `data:${input.mime};base64,${input.base64}` } };
  return { type: "text", text: "text" in input ? input.text : "" };
}

function toMessages(items: ChatItem[]): Message[] {
  return items.map((item): Message => {
    if (item.role === "user") {
      if (!item.files?.length) return { role: "user", content: item.text };
      return { role: "user", content: [{ type: "text", text: item.text }, ...item.files.map(filePart)] };
    }
    if (item.role === "assistant") return item.raw === undefined ? { role: "assistant", content: item.text } : item.raw as Assistant;
    return { role: "tool", tool_call_id: item.callId, content: item.result };
  });
}
