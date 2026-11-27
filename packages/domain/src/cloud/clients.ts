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
