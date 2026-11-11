// Test fixture: a stdio MCP server with one action, `echo`, which returns its text and the value
// of `ECHO_PREFIX`, then the names of the `DISPAND_*` variables it sees, if any.
// `ECHO_LEAK=<VAR>` puts that variable's value in its description; `ECHO_MCP_HANG=1` makes it never answer;
// `ECHO_READ_ONLY=1` marks `echo` read-only (`readOnlyHint`); `ECHO_META=<key>` adds `_meta: { <key>: "x" }` to its result's item.
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

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
    ],
  }));
  server.setRequestHandler("tools/call", (request) => ({
    content: [
      {
        type: "text" as const,
        text: [`${process.env.ECHO_PREFIX ?? ""}${String(request.params.arguments?.text ?? "")}`, ...Object.keys(process.env).filter((k) => k.startsWith("DISPAND_"))].join(" "),
        ...(process.env.ECHO_META ? { _meta: { [process.env.ECHO_META]: "x" } } : {}),
      },
    ],
  }));
  await server.connect(new StdioServerTransport());
}
