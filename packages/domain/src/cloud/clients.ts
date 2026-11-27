import { APIConnectionError as AnthropicConnectionError, APIError as AnthropicError } from "@anthropic-ai/sdk";
import { APIConnectionError as OpenAIConnectionError } from "openai";
import { createAnthropicClient } from "./anthropic.ts";
import type { ClientDeps, ClientHarness, ModelClient } from "./model-client.ts";
import { createChatClient } from "./openai-chat.ts";
import { createResponsesClient } from "./openai-responses.ts";

// Apart from `model-client.ts`, which each of these clients imports.
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

/** Retries of a model call that failed transiently (`retryDelay`). */
export const MODEL_RETRIES = 5;
/** The longest wait before a retry: a provider that asks for more fails the call at once. */
export const MAX_RETRY_WAIT_MS = 5 * 60_000;

/**
 * How long to wait before making a failed model call again, or undefined when it isn't retried:
 * after `MODEL_RETRIES` retries, or when the error isn't transient. Transient errors are those
 * the SDKs retry: the status codes 408, 409, 429 and 5xx, and a connection that failed or timed
 * out. Anthropic's overload or server error streamed after its 200 is one too. A provider's
 * `x-should-retry` header overrides that. The wait is what the provider asks
 * for (`retry-after-ms`, `retry-after`), up to `MAX_RETRY_WAIT_MS`. Otherwise it is 5 s, doubled
 * on each retry, less up to a quarter, so retries spread out. The clients turn off their SDK's
 * own retries, which bound their waits each their own way (Anthropic's not at all).
 */
export function retryDelay(err: unknown, retried: number): number | undefined {
  if (retried >= MODEL_RETRIES) return undefined;
  const { status, headers } = (err ?? {}) as { status?: unknown; headers?: { get?: (name: string) => string | null } };
  const header = (name: string) => (typeof headers?.get === "function" ? headers.get(name) : null);
  const told = header("x-should-retry");
  const transient =
    told === "true" ||
    (told !== "false" &&
      ((typeof status === "number" && (status === 408 || status === 409 || status === 429 || status >= 500)) ||
        err instanceof AnthropicConnectionError ||
        err instanceof OpenAIConnectionError ||
        (err instanceof AnthropicError && err.status === undefined && (err.type === "overloaded_error" || err.type === "api_error"))));
  if (!transient) return undefined;
  const asked = askedWait(header("retry-after-ms"), header("retry-after"));
  if (asked !== undefined) return asked <= MAX_RETRY_WAIT_MS ? asked : undefined;
  return 5_000 * 2 ** retried * (1 - Math.random() * 0.25);
}

/** The wait a provider asks for, in milliseconds: `retry-after-ms`, else `retry-after` in seconds or as a date. */
function askedWait(ms: string | null, after: string | null): number | undefined {
  const millis = Number.parseFloat(ms ?? "");
  if (Number.isFinite(millis) && millis >= 0) return millis;
  if (!after) return undefined;
  const seconds = Number.parseFloat(after);
  const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(after) - Date.now();
  return Number.isNaN(wait) ? undefined : Math.max(wait, 0);
}
