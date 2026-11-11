import { randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { Server, type CallToolResult, type JSONRPCMessage, type Transport } from "@modelcontextprotocol/server";

/** One action of the fake server: what `tools/list` says, and what a call returns. */
export type FakeAction = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  call?: (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;
};

export type FakeMcp = {
  url: string;
  /** The headers of every HTTP request the server received. */
  requests: IncomingHttpHeaders[];
  /** Every JSON-RPC message posted to the SSE endpoint. */
  posted: JSONRPCMessage[];
  /** `tools/list` requests answered. */
  pages: { count: number };
  close(): Promise<void>;
};

type Options = {
  /** SSE only: requests the server sends the client as soon as the stream opens (`ping`, ids `srv-<n>`). */
  serverRequests?: number;
  /** Actions per `tools/list` page, the next one always announced (default: one page). */
  pageSize?: number;
  /**
   * Streamable HTTP only: the server is an OAuth protected resource of `authorizationServer`. A
   * request without a bearer `accepts` gets a 401 naming its resource metadata.
   */
  oauth?: { authorizationServer: string; accepts: (token: string) => boolean };
};

function mcpServer(actions: FakeAction[], options: Options, pages: { count: number }): Server {
  const server = new Server({ name: "fake", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", (request) => {
    pages.count++;
    const size = options.pageSize ?? Infinity;
    const start = Number(request.params?.cursor ?? 0);
    const page = actions.slice(start, start + size);
    return {
    ...(start + size < actions.length ? { nextCursor: String(start + size) } : {}),
    tools: page.map((a) => ({
      name: a.name,
      ...(a.description === undefined ? {} : { description: a.description }),
      inputSchema: (a.inputSchema ?? { type: "object" }) as { type: "object" },
      ...(a.outputSchema ? { outputSchema: a.outputSchema as { type: "object" } } : {}),
      ...(a.annotations ? { annotations: a.annotations } : {}),
    })),
    };
  });
  server.setRequestHandler("tools/call", async (request) => {
    const action = actions.find((a) => a.name === request.params.name);
    if (!action?.call) return { content: [{ type: "text", text: `unknown action ${request.params.name}` }], isError: true };
    return action.call(request.params.arguments ?? {});
  });
  return server;
}

/** The legacy HTTP+SSE transport (GET opens the stream, POSTs carry messages), which the v2 server SDK no longer ships. */
class LegacySseTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  constructor(private readonly res: ServerResponse) {}
  async start() {}
  async send(message: JSONRPCMessage) {
    this.res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  }
  async close() {
    this.res.end();
    this.onclose?.();
  }
}

/**
 * A local MCP server for tests (never a real one on the internet), on an ephemeral loopback
 * port: Streamable HTTP at `/mcp`, or legacy SSE at `/sse`.
 */
export async function startFakeMcp(
  actions: FakeAction[],
  transport: "streamable-http" | "sse" = "streamable-http",
  options: Options = {},
): Promise<FakeMcp> {
  const pages = { count: 0 };
  const requests: IncomingHttpHeaders[] = [];
  const posted: JSONRPCMessage[] = [];
  const sse = new Map<string, LegacySseTransport>();
  const http = createServer((req, res) => {
    requests.push(req.headers);
    void (async () => {
      if (transport === "streamable-http") {
        if (options.oauth && !protectedResource(req.url ?? "/", req.headers.authorization, res)) return;
        const server = mcpServer(actions, options, pages);
        const t = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(t);
        await t.handleRequest(req, res);
        return;
      }
      const url = new URL(req.url ?? "/", "http://fake");
      if (req.method === "GET" && url.pathname === "/sse") {
        const id = randomUUID();
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(`event: endpoint\ndata: /messages?sessionId=${id}\n\n`);
        for (let i = 0; i < (options.serverRequests ?? 0); i++) res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: `srv-${i}`, method: "ping" })}\n\n`);
        const t = new LegacySseTransport(res);
        sse.set(id, t);
        res.on("close", () => sse.delete(id));
        await mcpServer(actions, options, pages).connect(t);
        return;
      }
      const t = sse.get(url.searchParams.get("sessionId") ?? "");
      if (req.method !== "POST" || !t) {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      for await (const chunk of req) body += String(chunk);
      res.writeHead(202).end();
      const message = JSON.parse(body) as JSONRPCMessage;
      posted.push(message);
      t.onmessage?.(message);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/${transport === "sse" ? "sse" : "mcp"}`;
  const metadataPath = "/.well-known/oauth-protected-resource/mcp";
  /** Answers the resource metadata, or a request without an accepted token; true when the request goes on. */
  function protectedResource(path: string, authorization: string | undefined, res: ServerResponse): boolean {
    const oauth = options.oauth!;
    if (path === metadataPath) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ resource: url, authorization_servers: [oauth.authorizationServer] }));
      return false;
    }
    const token = authorization?.match(/^Bearer (.+)$/)?.[1];
    if (token && oauth.accepts(token)) return true;
    res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="http://127.0.0.1:${port}${metadataPath}"` }).end();
    return false;
  }
  return {
    url,
    requests,
    posted,
    pages,
    close: () =>
      new Promise((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}
