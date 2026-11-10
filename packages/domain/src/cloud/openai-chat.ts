import type OpenAI from "openai";
import { parseArgs, type ChatItem, type ClientDeps, type ClientHarness, type ModelClient, type ModelTurn } from "./model-client.ts";
import { openAIClient } from "./openai-responses.ts";

type Message = OpenAI.Chat.ChatCompletionMessageParam;
type Assistant = OpenAI.Chat.ChatCompletionAssistantMessageParam;

// Chat Completions on any OpenAI-compatible server (base URL required, key optional). The
// assistant message is rebuilt from the stream and replayed as such.
export function createChatClient(h: ClientHarness, deps: ClientDeps): ModelClient {
  const client = openAIClient(h, h.baseUrl ?? "", deps);
  return {
    async turn({ system, items, tools, signal, onText }) {
      const stream = await client.chat.completions.create(
        {
          model: h.model,
          messages: [...(system ? [{ role: "system" as const, content: system }] : []), ...toMessages(items)],
          stream: true,
          ...(tools.length > 0
            ? { tools: tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.inputSchema } })) }
            : {}),
          ...(h.temperature !== undefined ? { temperature: h.temperature } : {}),
          ...(h.maxTokens ? { max_tokens: h.maxTokens } : {}),
        },
        { signal },
      );
      let text = "";
      let refusal = "";
      let finish: string | null = null;
      const calls: { id: string; name: string; arguments: string }[] = [];
      for await (const chunk of stream) {
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
      return { text, toolCalls: present.map((c) => ({ id: c.id, name: c.name, args: parseArgs(c.arguments) })), raw, stop };
    },
  };
}

function toMessages(items: ChatItem[]): Message[] {
  return items.map((item): Message => {
    if (item.role === "user") return { role: "user", content: item.text };
    if (item.role === "assistant") return item.raw as Assistant;
    return { role: "tool", tool_call_id: item.callId, content: item.result };
  });
}
