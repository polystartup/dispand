import { resolve } from "node:path";
import { expect, test } from "vitest";
import { connectTools } from "./tools.ts";

test("a session's tool server is offered to Claude Code in-process and to Codex as a namespace, and called by the supervisor", async () => {
  const tools = await connectTools({ echo: { type: "stdio", command: process.execPath, args: [resolve("src/fixtures/echo-mcp.ts")] } });
  try {
    expect(tools.codex()).toEqual([expect.objectContaining({ type: "namespace", name: "echo", tools: [expect.objectContaining({ type: "function", name: "echo" })] })]);
    expect(tools.claude().echo).toMatchObject({ type: "sdk", name: "echo" });
    expect(tools.has("echo", "echo")).toBe(true);
    expect(tools.has("echo", "other")).toBe(false);
    expect(tools.has("other", "echo")).toBe(false);
    const result = await tools.call("echo", "echo", { text: "hi" });
    expect(JSON.stringify(result.content)).toContain("hi");
  } finally {
    await tools.close();
  }
});
