import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** A message of a chat completions request, as the app's cloud sessions send it. */
export type ChatMessage = { role: string; content?: string | null; tool_call_id?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };

/** One model turn: text, then at most one tool call. */
export type Turn = { text?: string; call?: { name: string; args: unknown } };

/** Answers one request, from what it holds (the results of the turns before). */
export type Step = (messages: ChatMessage[]) => Turn | Promise<Turn>;

export type FakeModel = {
  /** The base URL to give an OpenAI-compatible cloud harness. */
  baseUrl: string;
  /** Queues the next turns. */
  script(...steps: Step[]): void;
  /** Every request's messages, in order. */
  requests: ChatMessage[][];
  close(): Promise<void>;
};

/** The last tool result of a request: its JSON parsed, or its text. */
export function lastResult<T = unknown>(messages: ChatMessage[]): T {
  const content = messages.findLast((m) => m.role === "tool")?.content ?? "";
  try {
    return JSON.parse(content) as T;
  } catch {
    return content as T;
  }
}

/**
 * A scripted OpenAI-compatible model, over HTTP for the app's own process: it lists `model`, and
 * answers each chat completions request with the next step, streamed in the chunks of
 * `packages/domain/src/cloud/fixtures/chat-tool-use.sse` and `chat-end.sse`. Past its script, a 500.
 */
export async function startFakeModel(model: string): Promise<FakeModel> {
  const steps: Step[] = [];
  const requests: ChatMessage[][] = [];
  let n = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      void (async () => {
        if (req.method === "GET" && req.url === "/v1/models") {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ data: [{ id: model }] }));
        }
        const step = req.method === "POST" && req.url === "/v1/chat/completions" ? steps.shift() : undefined;
        if (!step) {
          res.writeHead(500, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: { message: "no turn left" } }));
        }
        const messages = (JSON.parse(body) as { messages: ChatMessage[] }).messages;
        requests.push(messages);
        const turn = await step(messages);
        const id = `chatcmpl-${++n}`;
        const chunk = (delta: unknown, finish: string | null) =>
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1793000000, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(chunk({ role: "assistant", content: turn.text ?? "" }, null));
        if (turn.call) {
          const call = { index: 0, id: `call_${n}`, type: "function", function: { name: turn.call.name, arguments: JSON.stringify(turn.call.args) } };
          res.write(chunk({ tool_calls: [call] }, null));
        }
        res.write(chunk({}, turn.call ? "tool_calls" : "stop"));
        res.end("data: [DONE]\n\n");
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    script: (...more) => steps.push(...more),
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
