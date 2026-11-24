// A stand-in for the model APIs both CLIs call (Anthropic Messages for Claude Code, OpenAI
// Responses for Codex), run in a container next to the workers. Its first answer to a
// conversation is a shell command that lists the runs folder and writes a file; once the
// command's result comes back, it ends the turn.
import { createServer } from "node:http";
import process from "node:process";

const COMMAND = "ls .. > seen.txt && echo hi > written.txt";
const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

function claude(body, res) {
  const last = body.messages?.at(-1);
  const answered = Array.isArray(last?.content) && last.content.some((c) => c.type === "tool_result");
  const wantsBash = !answered && (body.tools ?? []).some((t) => t.name === "Bash");
  const block = wantsBash ? { type: "tool_use", id: "toolu_1", name: "Bash", input: {} } : { type: "text", text: "" };
  const delta = wantsBash
    ? { type: "input_json_delta", partial_json: JSON.stringify({ command: COMMAND, description: "List and write" }) }
    : { type: "text_delta", text: "Done" };
  const message = { id: "msg_1", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
  if (!body.stream) {
    const content = wantsBash ? [{ ...block, input: { command: COMMAND, description: "List and write" } }] : [{ type: "text", text: "Done" }];
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...message, content, stop_reason: wantsBash ? "tool_use" : "end_turn" }));
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(
    sse("message_start", { message }) +
    sse("content_block_start", { index: 0, content_block: block }) +
    sse("content_block_delta", { index: 0, delta }) +
    sse("content_block_stop", { index: 0 }) +
    sse("message_delta", { delta: { stop_reason: wantsBash ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }) +
    sse("message_stop", {}),
  );
}

function codex(body, res) {
  const answered = (body.input ?? []).some((i) => i.type === "function_call_output");
  for (const i of body.input ?? []) if (i.type === "function_call_output") process.stdout.write(`codex output: ${JSON.stringify(i.output).slice(0, 600)}\n`);
  const names = (body.tools ?? []).map((t) => t.name);
  let item = { type: "message", role: "assistant", id: "msg_1", content: [{ type: "output_text", text: "Done" }] };
  if (!answered) {
    const name = ["exec_command", "shell_command", "shell"].find((n) => names.includes(n));
    const args = name === "exec_command" ? { cmd: COMMAND } : name === "shell_command" ? { command: COMMAND } : { command: ["sh", "-c", COMMAND] };
    if (name) item = { type: "function_call", id: "fc_1", call_id: "call_1", name, arguments: JSON.stringify(args) };
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const usage = { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 };
  res.end(sse("response.created", { response: { id: "r1" } }) + sse("response.output_item.done", { item }) + sse("response.completed", { response: { id: "r1", usage } }));
}

createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch { /* not JSON */ }
    process.stdout.write(`${req.method} ${req.url}\n`);
    if (req.method === "POST" && /\/v1\/messages(\?|$)/.test(req.url ?? "")) return claude(body, res);
    if (req.method === "POST" && /\/responses(\?|$)/.test(req.url ?? "")) return codex(body, res);
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
}).listen(8080, "0.0.0.0");
