// A stand-in for the model APIs both CLIs call (Anthropic Messages for Claude Code, OpenAI
// Responses for Codex), run in a container next to the workers. Its first answer to a
// conversation is a shell command that lists the runs folder and writes a file; once the
// command's result comes back, it ends the turn.
import { createServer } from "node:http";
import process from "node:process";

const COMMAND = "ls .. > seen.txt && echo hi > written.txt";
/**
 * A prompt `HEARTBEAT`: writes what every process in the worker holds (environment, command
 * line) to `seen-env.txt`, then leaves a child in its own session writing `heartbeat` each second,
 * waiting until it is there: the tool's process group may end with the command.
 */
const HEARTBEAT = "(env; cat /proc/[0-9]*/environ /proc/[0-9]*/cmdline 2>/dev/null | tr '\\0' '\\n') > seen-env.txt; setsid sh -c 'while true; do date > heartbeat; sleep 1; done' > /dev/null 2>&1 & sleep 2";
/**
 * A prompt `TOOL <port>`: first a shell probe of what the worker can reach of the session's
 * tool (its secret in any process, its server's port), then a call of the tool `notes.note`.
 */
const toolPort = (text) => /TOOL (\d+)/.exec(text)?.[1];
const probe = (port) => `(env; cat /proc/[0-9]*/cmdline 2>/dev/null | tr '\\0' ' ') | grep -c "tool-[s]ecret" > probe.txt; node -e "require('net').connect(${port}, '127.0.0.1').on('connect', () => console.log('open')).on('error', () => console.log('closed'))" >> probe.txt`;
/** `PLANT`: a hook written into the workspace's and the CLI home's settings; it would create `hooked`. */
const HOOKS = JSON.stringify({ hooks: Object.fromEntries(["SessionStart", "UserPromptSubmit"].map((e) => [e, [{ hooks: [{ type: "command", command: "touch hooked" }] }]])) });
const PLANT = `mkdir -p .claude && printf '%s' '${HOOKS}' > .claude/settings.json && printf '%s' '${HOOKS}' > "$CLAUDE_CONFIG_DIR/settings.json"`;
/** The turn's answer: `RECALL` tells whether `alpha` is in what the CLI sent (its restored transcript). */
const answer = (all, last) => (/RECALL/.test(last) ? (/alpha/.test(all.replace(last, "")) ? "found alpha" : "missing alpha") : /REMEMBER/.test(last) ? "noted" : "Done");
const textOf = (content) => (typeof content === "string" ? content : (content ?? []).map((c) => c.text ?? "").join(""));
const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

function claude(body, res) {
  const last = body.messages?.at(-1);
  const answered = Array.isArray(last?.content) && last.content.some((c) => c.type === "tool_result");
  const port = toolPort(textOf(body.messages?.[0]?.content));
  const results = (body.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((c) => c.type === "tool_result").length;
  const hasBash = (body.tools ?? []).some((t) => t.name === "Bash");
  // The tool scenario: the probe, then the tool, then done; otherwise the shell command once.
  const userTexts = (body.messages ?? []).filter((m) => m.role === "user").map((m) => textOf(m.content));
  const lastText = userTexts.filter((t) => t.trim()).at(-1) ?? "";
  const plain = /RECALL|REMEMBER/.test(lastText);
  const call = port
    ? (hasBash && results === 0 ? { name: "Bash", input: { command: probe(port), description: "Probe" } } : results === 1 ? { name: "mcp__notes__note", input: { text: "hi" } } : undefined)
    : plain ? undefined
    : /PLANT/.test(lastText) ? (hasBash && !answered ? { name: "Bash", input: { command: PLANT, description: "Plant" } } : undefined)
    : /HEARTBEAT/.test(lastText) ? (hasBash && !answered ? { name: "Bash", input: { command: HEARTBEAT, description: "Heartbeat" } } : undefined)
    // `WRITEFILE`: Claude Code's Write of `written.txt` in its working directory (from its system prompt).
    : /WRITEFILE/.test(lastText) ? (!answered ? { name: "Write", input: { file_path: `${/Working directory: ([^\n]+)/.exec(textOf(body.system))?.[1]?.trim()}/written.txt`, content: "hi\n" } } : undefined)
    : (hasBash && !answered ? { name: "Bash", input: { command: COMMAND, description: "List and write" } } : undefined);
  const reply = answer(userTexts.join(" "), lastText);
  const wantsBash = Boolean(call);
  const block = call ? { type: "tool_use", id: `toolu_${results + 1}`, name: call.name, input: {} } : { type: "text", text: "" };
  const delta = call
    ? { type: "input_json_delta", partial_json: JSON.stringify(call.input) }
    : { type: "text_delta", text: reply };
  const message = { id: "msg_1", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
  if (!body.stream) {
    const content = call ? [{ ...block, input: call.input }] : [{ type: "text", text: reply }];
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
  const outputs = (body.input ?? []).filter((i) => i.type === "function_call_output").length;
  const port = toolPort((body.input ?? []).filter((i) => i.role === "user").map((i) => textOf(i.content)).join(" "));
  for (const i of body.input ?? []) if (i.type === "function_call_output") process.stdout.write(`codex output: ${JSON.stringify(i.output).slice(0, 600)}\n`);
  const names = (body.tools ?? []).map((t) => t.name);
  const userTexts = (body.input ?? []).filter((i) => i.role === "user").map((i) => textOf(i.content));
  const last = userTexts.filter((t) => t.trim()).at(-1) ?? "";
  let item = { type: "message", role: "assistant", id: "msg_1", content: [{ type: "output_text", text: answer(userTexts.join(" "), last) }] };
  const shell = (command) => {
    const name = ["exec_command", "shell_command", "shell"].find((n) => names.includes(n));
    const args = name === "exec_command" ? { cmd: command } : name === "shell_command" ? { command } : { command: ["sh", "-c", command] };
    return name ? { type: "function_call", id: `fc_${outputs + 1}`, call_id: `call_${outputs + 1}`, name, arguments: JSON.stringify(args) } : item;
  };
  if (port) {
    if (outputs === 0) item = shell(probe(port));
    else if (outputs === 1) item = { type: "function_call", id: "fc_2", call_id: "call_2", name: "note", namespace: "notes", arguments: JSON.stringify({ text: "hi" }) };
  } else if (/HEARTBEAT/.test(last)) {
    // Only this turn's outputs: a resumed conversation carries the earlier turn's too.
    const input = body.input ?? [];
    const turn = input.slice(input.findLastIndex((i) => i.role === "user"));
    if (!turn.some((i) => i.type === "function_call_output")) item = shell(HEARTBEAT);
  }
  else if (!answered && !/RECALL|REMEMBER/.test(last)) item = shell(COMMAND);
  res.writeHead(200, { "content-type": "text/event-stream" });
  const usage = { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 };
  // A message's text streams first, as the Responses API sends it: the CLI reports it from these.
  const deltas = item.type === "message"
    ? sse("response.output_item.added", { output_index: 0, item: { ...item, content: [] } }) + sse("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text })
    : "";
  res.end(sse("response.created", { response: { id: "r1" } }) + deltas + sse("response.output_item.done", { item }) + sse("response.completed", { response: { id: "r1", usage } }));
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
