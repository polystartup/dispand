import { resolve } from "node:path";
import { expect, test } from "vitest";
import { connectTools } from "./tools.ts";

test("a session's tool server is offered to Claude Code in-process and to Codex as a namespace, and called by the supervisor", async () => {
  const tools = await connectTools({ echo: { type: "stdio", command: process.execPath, args: [resolve("src/fixtures/echo-mcp.ts")] } }, async () => undefined);
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
  })).rejects.toThrow("refused");
  expect(asked).toBe(1);
});
