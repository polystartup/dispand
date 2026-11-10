import type { CloudHarnessConfig } from "../harnesses/cloud.ts";
import { createAnthropicClient } from "./anthropic.ts";
import { createChatClient } from "./openai-chat.ts";
import { createResponsesClient } from "./openai-responses.ts";

export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };
export type ToolCall = { id: string; name: string; args: unknown };

// `raw` is the provider-native assistant output, replayed unchanged: the history is append-only.
export type ChatItem =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; raw: unknown }
  | { role: "tool"; callId: string; name: string; result: string; isError: boolean };

export type ModelTurn = {
  text: string;
  toolCalls: ToolCall[];
  raw: unknown;
  stop: "end" | "tool_use" | "max_tokens" | "refusal";
};

export type TurnInput = {
  system: string;
  items: ChatItem[];
  tools: ToolSpec[];
  signal: AbortSignal;
  onText(delta: string): void;
};

export interface ModelClient {
  turn(input: TurnInput): Promise<ModelTurn>;
}

export type ClientHarness = CloudHarnessConfig & { apiKey?: string };
export type ClientDeps = { fetch?: typeof fetch };

export function createModelClient(h: ClientHarness, deps: ClientDeps = {}): ModelClient {
  switch (h.kind) {
    case "anthropic":
      return createAnthropicClient(h, deps);
    case "openai":
      return createResponsesClient(h, deps);
    case "openai-compatible":
      return createChatClient(h, deps);
  }
}

// Whether providers accept this schema with `strict: true`: every object lists all its properties
// as required and allows no others (OpenAI's strict-mode rules, which Anthropic's also accept).
// Other schemas are sent without `strict`, rather than having the whole request refused.
export function strictCompatible(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.every(strictCompatible);
  if (typeof schema !== "object" || schema === null) return true;
  const node = schema as Record<string, unknown>;
  if (node.type === "object" || "properties" in node) {
    const keys = Object.keys((node.properties as Record<string, unknown> | undefined) ?? {});
    const required = Array.isArray(node.required) ? node.required : [];
    if (node.additionalProperties !== false || !keys.every((k) => required.includes(k))) return false;
  }
  return Object.values(node).every(strictCompatible);
}

// Tool arguments the model sent as text that isn't JSON: the loop answers them with an error.
export function parseArgs(text: string): unknown {
  try {
    return JSON.parse(text === "" ? "{}" : text);
  } catch {
    return { __invalid: text };
  }
}
