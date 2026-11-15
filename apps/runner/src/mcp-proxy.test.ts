import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { call } from "@orpc/server";
import { handleJobFiles, router } from "@dispand/domain";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { JOB_FILES_PATH, MAX_FILE_BYTES } from "@dispand/runner-protocol";
import { expect, onTestFinished, test } from "vitest";
import { attachments, runs } from "../../../packages/domain/src/db/schema.ts";
import { jobTokenOf } from "../../../packages/domain/src/platform/token.ts";
import { asCli, ownerContext } from "../../../packages/domain/src/runners/test-support.ts";
import { mcpConfigFor } from "./mcp.ts";

const entry = { command: process.execPath, args: [resolve("src/main.ts"), "mcp-proxy"] };
const echo = (env: Record<string, string>) => ({ command: process.execPath, args: [resolve("src/fixtures/echo-mcp.ts")], env });

/** Dispand with one running Job, its files endpoint served over HTTP, counting the requests it gets. */
async function dispand() {
  const context = await ownerContext();
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "" }, { context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
  const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context });
  const run = (await context.db.select().from(runs)).find((r) => r.id === runId);
  let requests = 0;
  const http = createServer((req, res) => {
    requests++;
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)]));
      const reply = await handleJobFiles(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, body: Buffer.concat(chunks) }), context);
      res.writeHead(reply.status, { "content-type": "application/json" }).end(Buffer.from(await reply.arrayBuffer()));
    })();
  });
  await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
  onTestFinished(() => new Promise<void>((done) => http.close(() => done())));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}${JOB_FILES_PATH}`;
  const files = async () => (await context.db.select().from(attachments)).filter((a) => a.jobId === runId);
  return { files, requests: () => requests, url, token: jobTokenOf(context.secrets, run!)! };
}

/** An MCP client on the runner tool `server`, started as a session's CLI starts it: behind the proxy. */
async function session(server: ReturnType<typeof echo>, files?: { url: string; token: string }) {
  const config = mcpConfigFor([{ name: "echo", type: "runner", tool: "echo" }], { echo: server }, { dir: homedir(), entry, ...(files ? { files } : {}) }).echo as {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
  const client = new Client({ name: "cli", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: config.command, args: config.args, env: { ...(process.env as Record<string, string>), ...config.env }, stderr: "ignore" }));
  onTestFinished(() => client.close());
  return async () => (await client.callTool({ name: "echo", arguments: { text: "hi" } })).content as { type: string; text?: string; data?: string }[];
}

test("a fake stdio server returning an image yields a Job attachment, and the agent gets its reference in place of the bytes", async () => {
  const d = await dispand();
  const callEcho = await session(echo({ ECHO_IMAGE_BYTES: "64" }), { url: d.url, token: d.token });
  const content = await callEcho();
  const [kept] = await d.files();
  expect(kept).toMatchObject({ name: "image", mime: "image/png", image: true, size: 64, tableId: null });
  // The text as the server gave it (no DISPAND_* variable reached the server), then Dispand's in place of the image.
  expect(content).toEqual([
    { type: "text", text: "hi" },
    { type: "text", text: expect.stringContaining(`File 1 (“image”): attachment ${kept!.id}, image/png, 64 bytes`) },
  ]);
});

test("an oversized file is refused with a message, before anything is sent", async () => {
  const d = await dispand();
  const callEcho = await session(echo({ ECHO_IMAGE_BYTES: String(MAX_FILE_BYTES + 1) }), { url: d.url, token: d.token });
  expect((await callEcho())[1]).toEqual({ type: "text", text: "None of the files in this result were kept: file 1 (“image”) is larger than 10 MiB, the most a file may be." });
  expect(d.requests()).toBe(0);
  expect(await d.files()).toEqual([]);
});

test("outside a Job, a result goes through as the server gave it", async () => {
  const callEcho = await session(echo({ ECHO_IMAGE_BYTES: "64" }));
  const content = await callEcho();
  expect(content.map((part) => part.type)).toEqual(["text", "image"]);
  expect(Buffer.from(content[1]!.data!, "base64")).toHaveLength(64);
});

test("a server's last long line reaches a slow CLI whole, though the server exits right after it", async () => {
  // The server answers one line of 4 MiB and exits; the CLI reads nothing for a second.
  const script = `process.stdin.once("data", () => process.stdout.write("x".repeat(4 << 20) + "\\n", () => process.exit(0)));`;
  const spec = { command: process.execPath, args: ["-e", script], env: {}, cwd: homedir() };
  const proxy = spawn(entry.command, entry.args, { env: { ...process.env, DISPAND_PROXY: JSON.stringify(spec) }, stdio: ["pipe", "pipe", "ignore"] });
  proxy.stdout.pause();
  proxy.stdin.write("{}\n");
  await new Promise((done) => setTimeout(done, 1000));
  let size = 0;
  proxy.stdout.on("data", (chunk: Buffer) => (size += chunk.length)).resume();
  const code = await new Promise((done) => proxy.on("close", done));
  expect(code).toBe(0);
  expect(size).toBe((4 << 20) + 1);
});
