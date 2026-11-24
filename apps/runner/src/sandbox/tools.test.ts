import { resolve } from "node:path";
import { expect, test } from "vitest";
import { connectTools } from "./tools.ts";

test("a session's tool server is offered to Claude Code in-process and to Codex as a namespace, and called by the supervisor", async () => {
  const tools = await connectTools({ echo: { type: "stdio", command: process.execPath, args: [resolve("src/fixtures/echo-mcp.ts")] } }, async () => fetch);
  try {
    expect(tools.codex()).toEqual([expect.objectContaining({ type: "namespace", name: "echo", tools: [expect.objectContaining({ type: "function", name: "echo" })] })]);
    expect(tools.claude(async () => ({ allow: true })).echo).toMatchObject({ type: "sdk", name: "echo" });
    expect(tools.has("echo", "echo")).toBe(true);
    expect(tools.has("echo", "other")).toBe(false);
    expect(tools.has("other", "echo")).toBe(false);
    const result = await tools.call("echo", "echo", { text: "hi" });
    expect(JSON.stringify(result.content)).toContain("hi");
    // Narrowed away: gone from every use at once.
    tools.keep([]);
    expect(tools.has("echo", "echo")).toBe(false);
    await expect(tools.call("echo", "echo", { text: "hi" })).rejects.toThrow("the tool call failed");
  } finally {
    await tools.close();
  }
});

test("a tool URL the supervisor would be sent to loopback or metadata is refused before anything is sent", async () => {
  let asked = 0;
  await expect(connectTools({ x: { type: "http", url: "http://127.0.0.1:9/mcp" } }, async (url) => {
    asked++;
    const { checkDestination } = await import("./egress.ts");
    await checkDestination(url, ["198.51.100.7"]);
    return fetch;
  })).rejects.toThrow("refused");
  expect(asked).toBe(1);
});

test("a name that resolves to a refused address reaches nothing through the guarded fetch, whatever was checked before", async () => {
  const { guardedFetch } = await import("./egress.ts");
  await expect(guardedFetch(["198.51.100.7"])("http://localhost:9/mcp")).rejects.toThrow();
});

test("two actions Claude Code names alike are neither offered nor callable through the relay, as they'd share one grant", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const tools = await connectTools({ echo: { type: "stdio", command: process.execPath, args: [resolve("src/fixtures/echo-mcp.ts")], env: { ECHO_ALIASES: "1" } } }, async () => fetch);
  const decided: string[] = [];
  const { instance } = tools.claude(async (_server, tool) => {
    decided.push(tool);
    return { allow: true };
  }).echo!;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await instance.connect(serverSide);
  const client = new Client({ name: "cli", version: "1.0.0" });
  await client.connect(clientSide);
  try {
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
    for (const name of ["send.mail", "send_mail"]) expect(await client.callTool({ name, arguments: {} })).toMatchObject({ isError: true });
    // Refused before the broker is even asked; an ordinary action still goes through it.
    expect(decided).toEqual([]);
    expect(JSON.stringify((await client.callTool({ name: "echo", arguments: { text: "hi" } })).content)).toContain("hi");
    expect(decided).toEqual(["echo"]);
  } finally {
    await client.close();
    await tools.close();
  }
});
