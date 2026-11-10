import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { createMcpConnector, inboundProblem, MAX_MESSAGE_VALUES, MAX_RESPONSE_BYTES, MAX_RESULT_TEXT, ToolError } from "./mcp.ts";
import { guardedFetch, ownAddresses } from "./network.ts";
import { startFakeMcp, type FakeAction } from "./test-server.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function fake(actions: FakeAction[], transport: "streamable-http" | "sse" = "streamable-http", options: Parameters<typeof startFakeMcp>[2] = {}) {
  const server = await startFakeMcp(actions, transport, options);
  closers.push(server.close);
  return server;
}

const echo: FakeAction = {
  name: "echo",
  description: "Says it back",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  call: (args) => ({ content: [{ type: "text", text: String(args.text) }] }),
};

const connector = createMcpConnector();
const signal = () => new AbortController().signal;

for (const transport of ["streamable-http", "sse"] as const) {
  test(`lists actions and calls one over ${transport}`, async () => {
    const server = await fake([echo], transport);
    const target = { url: server.url, transport, headers: { authorization: "Bearer s3cret" } };
    expect(await connector.listActions(target)).toEqual([
      { name: "echo", description: "Says it back", inputSchema: echo.inputSchema },
    ]);
    expect(await connector.callAction(target, "echo", { text: "hi" }, signal())).toEqual({ text: "hi", isError: false });
    expect(server.requests.length).toBeGreaterThan(0);
    // Every request carries the header (the SSE stream's GET included).
    for (const headers of server.requests) expect(headers.authorization).toBe("Bearer s3cret");
  });
}

test("a tool error comes back as isError with its text, and structured content as is", async () => {
  const server = await fake([
    { name: "fail", call: () => ({ content: [{ type: "text", text: "no such repo" }], isError: true }) },
    {
      name: "make",
      outputSchema: { type: "object", properties: { html_url: { type: "string" } } },
      call: () => ({ content: [{ type: "text", text: "{}" }], structuredContent: { html_url: "https://x" } }),
    },
  ]);
  const target = { url: server.url, transport: "streamable-http" as const, headers: {} };
  expect(await connector.callAction(target, "fail", {}, signal())).toEqual({ text: "no such repo", isError: true });
  expect(await connector.callAction(target, "make", {}, signal())).toEqual({ text: "{}", structured: { html_url: "https://x" }, isError: false });
});

test("callAction cuts long text and summarizes other content", async () => {
  const server = await fake([
    { name: "long", call: () => ({ content: [{ type: "text", text: "x".repeat(MAX_RESULT_TEXT + 10) }] }) },
    {
      name: "mixed",
      call: () => ({
        content: [
          { type: "image", data: "aGk=", mimeType: "image/png" },
          { type: "resource", resource: { uri: "file:///a.txt", text: "a" } },
          { type: "text", text: "nul\u0000here" },
        ],
      }),
    },
  ]);
  const target = { url: server.url, transport: "streamable-http" as const, headers: {} };
  const long = await connector.callAction(target, "long", {}, signal());
  expect(long.text).toBe(`${"x".repeat(MAX_RESULT_TEXT)}\n[truncated]`);
  expect((await connector.callAction(target, "mixed", {}, signal())).text).toBe("[image]\n[resource file:///a.txt]\nnul�here");
});

test("an oversized schema is refused", async () => {
  const big = { type: "object", description: "x".repeat(70 * 1024) };
  const server = await fake([{ name: "big", inputSchema: big }]);
  await expect(connector.listActions({ url: server.url, transport: "streamable-http", headers: {} })).rejects.toThrow(
    "The schema of the action “big” is larger than 64 KiB",
  );
});

test("more than 200 actions are refused", async () => {
  const server = await fake(Array.from({ length: 201 }, (_, i) => ({ name: `a${i}` })));
  await expect(connector.listActions({ url: server.url, transport: "streamable-http", headers: {} })).rejects.toThrow(
    `${new URL(server.url).host} offers more than 200 actions`,
  );
});

test("a message is bounded before the SDK parses it", () => {
  const started = performance.now();
  expect(inboundProblem({ jsonrpc: "2.0", id: 1, result: { tools: new Array(500_000).fill(0) } })).toBe("sent a message too large to read");
  expect(inboundProblem({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "x".repeat(1_000_000) }] } })).toBeUndefined();
  expect(inboundProblem({ jsonrpc: "2.0", id: 1, result: { tools: new Array(201).fill({}) } })).toBe("offers more than 200 actions");
  expect(inboundProblem({ a: new Array(MAX_MESSAGE_VALUES).fill(0) })).toBe("sent a message too large to read");
  expect(performance.now() - started).toBeLessThan(1000);
});

test("an unreachable server is a short reason, without the headers", async () => {
  const server = await fake([]);
  await server.close();
  const error = await connector.listActions({ url: server.url, transport: "streamable-http", headers: { authorization: "Bearer s3cret" } }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ToolError);
  expect((error as Error).message).toBe(`Couldn't reach ${new URL(server.url).host}`);
  expect((error as Error).stack ?? "").not.toContain("s3cret");
});

test("header values the server sends back are redacted, in actions, results and errors", async () => {
  const echoed = "Bearer tok-0123456789";
  const server = await fake([
    { name: "leak", description: `got ${echoed}`, inputSchema: { type: "object", properties: { "tok-0123456789": { type: "string" } } }, call: () => ({ content: [{ type: "text", text: "token tok-0123456789" }] }) },
  ]);
  const target = { url: server.url, transport: "streamable-http" as const, headers: { authorization: echoed } };
  const listed = JSON.stringify(await connector.listActions(target));
  expect(listed).not.toContain("tok-0123456789");
  expect(listed).toContain("got ••••");
  expect((await connector.callAction(target, "leak", {}, signal())).text).toBe("token ••••");
  const big = await fake([{ name: "tok-0123456789", inputSchema: { type: "object", description: "x".repeat(70 * 1024) } }]);
  const error = await connector.listActions({ ...target, url: big.url }).catch((e: unknown) => e);
  expect((error as Error).message).toBe("The schema of the action “••••” is larger than 64 KiB");
});

test("cancelling ends a call even while an SSE server never finishes connecting", async () => {
  const http = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": heartbeat\n\n");
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => (http.closeAllConnections(), http.close(() => resolve()))));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/sse`;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  await expect(connector.callAction({ url, transport: "sse", headers: {} }, "echo", {}, controller.signal)).rejects.toThrow("The call was cancelled");
});

test("redaction leaves the protocol alone: a short header value doesn't break the connection", async () => {
  const server = await fake([echo]);
  const target = { url: server.url, transport: "streamable-http" as const, headers: { "x-team": "a", "x-version": "2.0" } };
  expect((await connector.listActions(target)).map((a) => a.name)).toEqual(["echo"]);
});

test("a header value split by the description cut is redacted before the cut", async () => {
  const token = "tok-0123456789";
  const server = await fake([{ name: "cut", description: `${"x".repeat(3990)}${token}` }]);
  const [action] = await connector.listActions({ url: server.url, transport: "streamable-http", headers: { authorization: `Bearer ${token}` } });
  expect(action!.description).not.toContain("tok-");
});

test("a refusal whose body echoes the header doesn't carry it", async () => {
  const http = createServer((req, res) => res.writeHead(401, { "content-type": "text/plain" }).end(`bad token ${req.headers.authorization}`));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => http.close(() => resolve())));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  const error = await connector.listActions({ url, transport: "streamable-http", headers: { authorization: "Bearer s3cret" } }).catch((e: unknown) => e);
  expect((error as Error).message).toMatch(/refused the request \(401\)/);
  expect(JSON.stringify(error)).not.toContain("s3cret");
  expect((error as Error).message).not.toContain("s3cret");
});

test("a response past 16 MiB is cut off while it arrives, whatever its status", async () => {
  let sent = 0;
  const http = createServer((_req, res) => {
    res.writeHead(500, { "content-type": "text/plain" });
    const chunk = Buffer.alloc(1024 * 1024, "x");
    const pump = () => {
      while (sent <= 2 * MAX_RESPONSE_BYTES && !res.destroyed) {
        sent += chunk.length;
        if (!res.write(chunk)) return void res.once("drain", pump);
      }
      res.end();
    };
    pump();
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => (http.closeAllConnections(), http.close(() => resolve()))));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  const error = await connector.listActions({ url, transport: "streamable-http", headers: {} }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ToolError);
  expect((error as Error).message).toBe(`${new URL(url).host} sent more than 16 MiB`);
  expect(sent).toBeLessThan(2 * MAX_RESPONSE_BYTES);
});

test("requests the server sends the client are dropped, never answered", async () => {
  const server = await fake([echo], "sse", { serverRequests: 50 });
  const target = { url: server.url, transport: "sse" as const, headers: {} };
  expect(await connector.listActions(target)).toHaveLength(1);
  expect(server.posted.filter((m) => "id" in m && String(m.id).startsWith("srv-"))).toEqual([]);
});

test("pages of actions stop at the first one past 200 actions", async () => {
  const server = await fake(Array.from({ length: 1000 }, (_, i) => ({ name: `a${i}` })), "streamable-http", { pageSize: 150 });
  await expect(connector.listActions({ url: server.url, transport: "streamable-http", headers: {} })).rejects.toThrow("more than 200 actions");
  expect(server.pages.count).toBe(2);
});

test("actions on several pages are all listed", async () => {
  const server = await fake([echo, { name: "two" }, { name: "three" }], "streamable-http", { pageSize: 2 });
  expect((await connector.listActions({ url: server.url, transport: "streamable-http", headers: {} })).map((a) => a.name)).toEqual(["echo", "two", "three"]);
});

test("a redirect to another host is not followed, so the header doesn't reach it", async () => {
  const other = await fake([echo]);
  const http = createServer((_req, res) => res.writeHead(307, { location: other.url.replace("127.0.0.1", "localhost") }).end());
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => http.close(() => resolve())));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  await expect(connector.listActions({ url, transport: "streamable-http", headers: { authorization: "Bearer s3cret" } })).rejects.toBeInstanceOf(ToolError);
  expect(other.requests).toEqual([]);
});

test("the guarded fetch refuses Dispand's own addresses, by literal and by name", async () => {
  const server = await fake([echo]);
  const guarded = createMcpConnector({ fetch: guardedFetch(ownAddresses()) });
  const port = new URL(server.url).port;
  for (const host of ["127.0.0.1", "localhost", "[::ffff:127.0.0.1]"]) {
    await expect(guarded.listActions({ url: `http://${host}:${port}/mcp`, transport: "streamable-http", headers: {} })).rejects.toThrow(
      "is one of Dispand's own addresses",
    );
  }
  expect(server.requests).toEqual([]);
});

test("ownAddresses covers loopback, link-local and the app's own subnets only", () => {
  const blocked = ownAddresses({
    eth0: [{ address: "172.18.0.3", netmask: "255.255.0.0", family: "IPv4", mac: "", internal: false, cidr: "172.18.0.3/16" }],
  });
  for (const ip of ["127.0.0.1", "169.254.169.254", "0.0.0.0", "172.18.0.2"]) expect(blocked.check(ip, "ipv4"), ip).toBe(true);
  for (const ip of ["::1", "fe80::1", "::ffff:127.0.0.1"]) expect(blocked.check(ip, "ipv6"), ip).toBe(true);
  for (const ip of ["10.1.2.3", "192.168.1.10", "140.82.112.3"]) expect(blocked.check(ip, "ipv4"), ip).toBe(false);
});

test("an action its server marks read-only is listed as such, and only then", async () => {
  const server = await fake([
    { ...echo, name: "search", annotations: { readOnlyHint: true } },
    { ...echo, name: "send", annotations: { readOnlyHint: false } },
    { ...echo, name: "plain" },
    { ...echo, name: "odd", annotations: { title: "Odd" } },
  ]);
  const actions = await connector.listActions({ url: server.url, transport: "streamable-http", headers: {} });
  expect(actions.map((a) => [a.name, a.readOnly])).toEqual([
    ["search", true],
    ["send", undefined],
    ["plain", undefined],
    ["odd", undefined],
  ]);
});
