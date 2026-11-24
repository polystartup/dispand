// Test fixture: a stdio MCP server with one action, `echo`, which returns its text and the value
// of `ECHO_PREFIX`, then the names of the `DISPAND_*` variables it sees, if any.
// `ECHO_LEAK=<VAR>` puts that variable's value in its description; `ECHO_MCP_HANG=1` makes it never answer;
// `ECHO_READ_ONLY=1` marks `echo` read-only (`readOnlyHint`); `ECHO_META=<key>` adds `_meta: { <key>: "x" }` to its result's item;
// `ECHO_HAS_MORE=1` adds `_meta: { result_has_more: true }` to the result itself;
// `ECHO_IMAGE_BYTES=<n>` adds an image of n bytes (a PNG signature, then zeros) after the text.
// `ECHO_ALIASES=1` also lists `send.mail` and `send_mail`, which Claude Code names alike.
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

function image(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  return bytes;
}

if (process.env.ECHO_MCP_HANG === "1") setInterval(() => {}, 60_000);
else {
  const server = new Server({ name: "echo", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", () => ({
    tools: [
      {
        name: "echo",
        description: process.env.ECHO_LEAK ? `Uses key ${process.env[process.env.ECHO_LEAK]} for itself` : "Returns its text.",
        inputSchema: { type: "object" as const, properties: { text: { type: "string" } }, required: ["text"] },
        ...(process.env.ECHO_READ_ONLY === "1" ? { annotations: { readOnlyHint: true } } : {}),
      },
      ...(process.env.ECHO_ALIASES === "1"
        ? ["send.mail", "send_mail"].map((name) => ({ name, description: "Sends a mail.", inputSchema: { type: "object" as const, properties: {} } }))
        : []),
    ],
  }));
  server.setRequestHandler("tools/call", (request) => ({
    content: [
      {
        type: "text" as const,
        text: [`${process.env.ECHO_PREFIX ?? ""}${String(request.params.arguments?.text ?? "")}`, ...Object.keys(process.env).filter((k) => k.startsWith("DISPAND_"))].join(" "),
        ...(process.env.ECHO_META ? { _meta: { [process.env.ECHO_META]: "x" } } : {}),
      },
      ...(process.env.ECHO_IMAGE_BYTES ? [{ type: "image" as const, mimeType: "image/png", data: image(Number(process.env.ECHO_IMAGE_BYTES)).toString("base64") }] : []),
    ],
    ...(process.env.ECHO_HAS_MORE === "1" ? { _meta: { result_has_more: true } } : {}),
  }));
  await server.connect(new StdioServerTransport());
}
