// A sandboxed session's tools reach its CLI only over the CLI's own control channel: the
// supervisor connects to every MCP server the session gets (the Job's, tools by URL with their
// headers, runner tools through `mcp-proxy`), and offers them to Claude Code as in-process SDK
// servers, to Codex as dynamic tools. No process in the worker holds a tool's address, token or
// command, so none can call one without the CLI, whose calls the permission broker decides.
import type { McpSdkServerConfigWithInstance, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { DynamicToolSpec } from "../codex/protocol/v2/DynamicToolSpec.ts";
import type { JsonValue } from "../codex/protocol/serde_json/JsonValue.ts";

type Listed = { name: string; description?: string; inputSchema: Record<string, unknown> };
type Result = Awaited<ReturnType<Client["callTool"]>>;

export type SessionTools = {
  /** Claude Code: one in-process server per tool server, over the SDK's control channel. */
  claude(): Record<string, McpSdkServerConfigWithInstance>;
  /** Codex: one dynamic-tool namespace per server. */
  codex(): DynamicToolSpec[];
  /** Whether a Codex dynamic call names one of these servers' tools. */
  has(server: string, tool: string): boolean;
  /** Runs a call the broker allowed. */
  call(server: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Result>;
  close(): Promise<void>;
};

/** Connects to each of the session's servers (as the CLI would have) and lists their tools. */
export async function connectTools(config: Record<string, McpServerConfig>): Promise<SessionTools> {
  const servers = new Map<string, { client: Client; tools: Listed[] }>();
  const close = async () => {
    await Promise.all([...servers.values()].map((s) => s.client.close().catch(() => undefined)));
  };
  try {
    for (const [name, entry] of Object.entries(config)) {
      const client = new Client({ name: "dispand-runner", version: "1.0.0" });
      if (entry.type === "http") {
        await client.connect(new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: entry.headers ?? {} } }));
      } else if (entry.type === undefined || entry.type === "stdio") {
        // `mcp-proxy`, as the CLI started it: its guards stay, and the server runs in the supervisor.
        await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args ?? [], env: { ...getDefaultEnvironment(), ...entry.env }, stderr: "ignore" }));
      } else {
        throw new Error(`the MCP server ${name} can't be offered to a worker`);
      }
      servers.set(name, { client, tools: [] });
      servers.get(name)!.tools = (await client.listTools()).tools as Listed[];
    }
  } catch (err) {
    await close();
    throw err;
  }
  const call = (server: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal) =>
    servers.get(server)!.client.callTool({ name: tool, arguments: args }, signal ? { signal } : undefined);
  return {
    claude: () => Object.fromEntries([...servers].map(([name, { tools }]) => {
      const proxy = new McpServer({ name, version: "1.0.0" }, { capabilities: { tools: {} } });
      // The CLI's permission hooks decide each call before it gets here, as for any MCP tool.
      proxy.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
      proxy.server.setRequestHandler(CallToolRequestSchema, (req, extra) => call(name, req.params.name, req.params.arguments ?? {}, extra.signal) as never);
      return [name, { type: "sdk", name, instance: proxy }];
    })),
    codex: () => [...servers].map(([name, { tools }]) => ({
      type: "namespace" as const,
      name,
      description: `Tools of the ${name} server`,
      tools: tools.map((t) => ({ type: "function" as const, name: t.name, description: t.description ?? t.name, inputSchema: t.inputSchema as JsonValue })),
    })),
    has: (server, tool) => servers.get(server)?.tools.some((t) => t.name === tool) ?? false,
    call,
    close,
  };
}
