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
import { mcpActionName } from "@dispand/runner-protocol";
import type { DynamicToolSpec } from "../codex/protocol/v2/DynamicToolSpec.ts";
import type { JsonValue } from "../codex/protocol/serde_json/JsonValue.ts";

type Listed = { name: string; description?: string; inputSchema: Record<string, unknown> };
type Result = Awaited<ReturnType<Client["callTool"]>>;

/** The permission broker's decision on one call, made by the supervisor at the call (`ToolPolicy.decide`). */
export type Decide = (server: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<{ allow: boolean; message?: string }>;

export type SessionTools = {
  /**
   * Claude Code: one in-process server per tool server, over the SDK's control channel. Each
   * call is decided here, by `decide`: a message on the channel is never taken as an approval.
   */
  claude(decide: Decide): Record<string, McpSdkServerConfigWithInstance>;
  /** Codex: one dynamic-tool namespace per server. */
  codex(): DynamicToolSpec[];
  /** Whether a Codex dynamic call names one of these servers' tools. */
  has(server: string, tool: string): boolean;
  /** Runs a call the broker allowed. */
  call(server: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Result>;
  /** Keeps only these servers (a narrowing of the session's tools): the others are gone at once. */
  keep(names: Iterable<string>): void;
  close(): Promise<void>;
};

const CALL_FAILED = "the tool call failed";

/**
 * Connects to each of the session's servers (as the CLI would have) and lists their tools.
 * `fetchFor` vets a server's URL before the supervisor sends it anything, and gives the
 * `fetch` its requests go through.
 */
export async function connectTools(config: Record<string, McpServerConfig>, fetchFor: (url: URL) => Promise<typeof fetch>): Promise<SessionTools> {
  const servers = new Map<string, { client: Client; tools: Listed[] }>();
  const close = async () => {
    await Promise.all([...servers.values()].map((s) => s.client.close().catch(() => undefined)));
  };
  try {
    for (const [name, entry] of Object.entries(config)) {
      const client = new Client({ name: "dispand-runner", version: "1.0.0" });
      if (entry.type !== "http" && entry.type !== undefined && entry.type !== "stdio") throw new Error(`the MCP server ${name} can't be offered to a worker`);
      const fetcher = entry.type === "http" ? await fetchFor(new URL(entry.url)) : undefined;
      servers.set(name, { client, tools: [] });
      try {
        if (entry.type === "http") await client.connect(new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: entry.headers ?? {} }, fetch: fetcher! }));
        // `mcp-proxy`, as the CLI started it: its guards stay, and the server runs in the supervisor.
        else await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args ?? [], env: { ...getDefaultEnvironment(), ...entry.env }, stderr: "ignore" }));
        servers.get(name)!.tools = (await client.listTools()).tools as Listed[];
      } catch {
        // Not the server's words: they may quote its URL or a credential it echoed.
        throw new Error(`the MCP server ${name} didn't connect`);
      }
    }
  } catch (err) {
    await close();
    throw err;
  }
  // Checked at each use: a server the session no longer has is gone from every listing and call.
  const has = (server: string, tool: string) => servers.get(server)?.tools.some((t) => t.name === tool) ?? false;
  const call = async (server: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Result> => {
    if (!has(server, tool)) throw new Error(CALL_FAILED);
    try {
      return await servers.get(server)!.client.callTool({ name: tool, arguments: args }, signal ? { signal } : undefined);
    } catch {
      throw new Error(CALL_FAILED);
    }
  };
  const refusal = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
  return {
    claude: (decide) => Object.fromEntries([...servers.keys()].map((name) => {
      const proxy = new McpServer({ name, version: "1.0.0" }, { capabilities: { tools: {} } });
      // Claude's name for an action (`mcpActionName`) is what permissions are kept under: two
      // actions sharing one would share a grant. Neither is offered, whatever the catalog held.
      const offered = () => {
        const tools = servers.get(name)?.tools ?? [];
        const count = new Map<string, number>();
        for (const t of tools) count.set(mcpActionName(t.name, "claude-code"), (count.get(mcpActionName(t.name, "claude-code")) ?? 0) + 1);
        return tools.filter((t) => count.get(mcpActionName(t.name, "claude-code")) === 1);
      };
      proxy.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: offered() }));
      proxy.server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
        const args = req.params.arguments ?? {};
        if (!offered().some((t) => t.name === req.params.name)) return refusal(CALL_FAILED);
        const decision = await decide(name, req.params.name, args, extra.signal);
        if (!decision.allow) return refusal(decision.message ?? "The owner didn't allow this tool call.");
        return (await call(name, req.params.name, args, extra.signal).catch(() => refusal(CALL_FAILED))) as never;
      });
      return [name, { type: "sdk", name, instance: proxy }];
    })),
    codex: () => [...servers].map(([name, { tools }]) => ({
      type: "namespace" as const,
      name,
      description: `Tools of the ${name} server`,
      tools: tools.map((t) => ({ type: "function" as const, name: t.name, description: t.description ?? t.name, inputSchema: t.inputSchema as JsonValue })),
    })),
    has,
    call,
    keep: (names) => {
      const kept = new Set(names);
      for (const [name, { client }] of servers) {
        if (kept.has(name)) continue;
        servers.delete(name);
        void client.close().catch(() => undefined);
      }
    },
    close,
  };
}
