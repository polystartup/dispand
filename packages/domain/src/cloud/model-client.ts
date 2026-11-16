import { detectImage, type ImageType } from "../data/files.ts";
import type { CloudHarnessConfig } from "../harnesses/cloud.ts";
import { oneLine } from "../text.ts";
import { createAnthropicClient } from "./anthropic.ts";
import { createChatClient } from "./openai-chat.ts";
import { createResponsesClient } from "./openai-responses.ts";

export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };
export type ToolCall = { id: string; name: string; args: unknown };

// `raw` is the provider-native assistant output, replayed unchanged: the history is append-only.
/** A file attached to a user message: its attachment and name, with its bytes read for each model call (never stored in the transcript). */
export type ChatFile = { id: string; name: string; bytes?: Uint8Array };

export type ChatItem =
  | { role: "user"; text: string; files?: ChatFile[] }
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; raw: unknown }
  | { role: "tool"; callId: string; name: string; result: string; isError: boolean };

export type ModelTurn = {
  text: string;
  toolCalls: ToolCall[];
  raw: unknown;
  stop: "end" | "tool_use" | "max_tokens" | "refusal";
  /** The tokens the provider counted for this call (cached input included); absent when it sent none. */
  usage?: { input: number; output: number };
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
// as required and allows no others, and no string has a format (OpenAI's strict-mode rules, which
// Anthropic's also accept).
// Other schemas are sent without `strict`, rather than having the whole request refused.
export function strictCompatible(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.every(strictCompatible);
  if (typeof schema !== "object" || schema === null) return true;
  const node = schema as Record<string, unknown>;
  // A string format a provider doesn't know (`uri`) gets the whole request refused in strict mode.
  if (typeof node.format === "string") return false;
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

/**
 * What a model is given for an attached file, by its first bytes (never its name): a raster image
 * as image input, a PDF as document input, UTF-8 text as text; anything else, and a file gone, as
 * a line saying so. Every provider takes these three kinds of input.
 */
export type FileInput =
  | { kind: "image"; mime: ImageType; base64: string }
  | { kind: "pdf"; base64: string }
  | { kind: "text"; text: string }
  | { kind: "note"; text: string };

export function fileInput(file: ChatFile): FileInput {
  const named = `“${oneLine(file.name)}”`;
  if (!file.bytes) return { kind: "note", text: `The attached file ${named} is no longer available.` };
  const image = detectImage(file.bytes);
  if (image) return { kind: "image", mime: image, base64: Buffer.from(file.bytes).toString("base64") };
  if (Buffer.from(file.bytes.subarray(0, 5)).toString("latin1") === "%PDF-") return { kind: "pdf", base64: Buffer.from(file.bytes).toString("base64") };
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
    if (!text.includes("\0")) return { kind: "text", text: `The attached file ${named}:\n${text}` };
  } catch {
    // Not UTF-8: a binary file.
  }
  return { kind: "note", text: `The attached file ${named} (${file.bytes.length} bytes) is in a format this model can't read: only images, PDFs and text are.` };
}
