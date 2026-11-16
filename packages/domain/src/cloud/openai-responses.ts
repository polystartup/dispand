import OpenAI from "openai";
import type { ResponseInputItem, ResponseOutputItem } from "openai/resources/responses/responses";
import { fileInput, parseArgs, strictCompatible, type ChatFile, type ChatItem, type ClientDeps, type ClientHarness, type ModelClient, type ModelTurn } from "./model-client.ts";

// Responses API, stateless: `store: false`, so every turn sends the whole history, and the
// output items (reasoning items carry their `encrypted_content` when nothing is stored) go
// back unchanged as input.
export function createResponsesClient(h: ClientHarness, deps: ClientDeps): ModelClient {
  const client = openAIClient(h, h.baseUrl ?? "https://api.openai.com/v1", deps);
  return {
    async turn({ system, items, tools, signal, onText }) {
      const stream = await client.responses.create(
        {
          model: h.model,
          ...(system ? { instructions: system } : {}),
          input: toInput(items),
          store: false,
          stream: true,
          ...(tools.length > 0
            ? { tools: tools.map((t) => ({ type: "function" as const, name: t.name, description: t.description, parameters: t.inputSchema, strict: strictCompatible(t.inputSchema) })) }
            : {}),
          ...(h.maxTokens ? { max_output_tokens: h.maxTokens } : {}),
          ...(h.effort ? { reasoning: { effort: h.effort } } : {}),
        },
        { signal },
      );
      let final: OpenAI.Responses.Response | undefined;
      for await (const event of stream) {
        if (event.type === "response.output_text.delta") onText(event.delta);
        else if (event.type === "response.completed" || event.type === "response.incomplete") final = event.response;
        else if (event.type === "response.failed") throw new Error(`The model failed (${event.response.error?.code ?? "unknown"})`);
      }
      signal.throwIfAborted();
      if (!final) throw new Error("The model's stream ended before the response did");
      return toTurn(final);
    },
  };
}

// Only what the harness says: no key, organization, project or URL from the server's environment.
export function openAIClient(h: ClientHarness, baseURL: string, deps: ClientDeps): OpenAI {
  return new OpenAI({
    // The SDK logs nothing: it would write raw provider data (which may echo the key) to the console.
    logLevel: "off",
    // The SDK insists on a credential; without one the Authorization header is removed below.
    apiKey: h.apiKey || "none",
    ...(h.apiKey ? {} : { defaultHeaders: { Authorization: null } }),
    adminAPIKey: null,
    organization: null,
    project: null,
    webhookSecret: null,
    baseURL,
    fetch: deps.fetch,
  });
}

function filePart(file: ChatFile): OpenAI.Responses.ResponseInputContent {
  const input = fileInput(file);
  if (input.kind === "image") return { type: "input_image", detail: "auto", image_url: `data:${input.mime};base64,${input.base64}` };
  if (input.kind === "pdf") return { type: "input_file", filename: file.name.slice(0, 255), file_data: `data:application/pdf;base64,${input.base64}` };
  return { type: "input_text", text: input.text };
}

function toInput(items: ChatItem[]): ResponseInputItem[] {
  return items.flatMap((item): ResponseInputItem[] => {
    if (item.role === "user") {
      if (!item.files?.length) return [{ role: "user", content: item.text }];
      return [{ role: "user", content: [{ type: "input_text", text: item.text }, ...item.files.map(filePart)] }];
    }
    if (item.role === "assistant") return item.raw as ResponseInputItem[];
    return [{ type: "function_call_output", call_id: item.callId, output: item.result }];
  });
}

function toTurn(response: OpenAI.Responses.Response): ModelTurn {
  const output: ResponseOutputItem[] = response.output;
  let text = "";
  let refused = false;
  const toolCalls: ModelTurn["toolCalls"] = [];
  for (const item of output) {
    if (item.type === "message") {
      for (const part of item.content) {
        if (part.type === "output_text") text += part.text;
        else if (part.type === "refusal") refused = true;
      }
    } else if (item.type === "function_call") {
      toolCalls.push({ id: item.call_id, name: item.name, args: parseArgs(item.arguments) });
    }
  }
  const reason = response.status === "incomplete" ? response.incomplete_details?.reason : undefined;
  const stop: ModelTurn["stop"] =
    reason === "max_output_tokens" ? "max_tokens"
    : reason === "content_filter" || refused ? "refusal"
    : toolCalls.length > 0 ? "tool_use"
    : "end";
  return { text, toolCalls, raw: output, stop, ...(response.usage ? { usage: { input: response.usage.input_tokens, output: response.usage.output_tokens } } : {}) };
}
