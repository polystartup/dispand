import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Options, query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { attachmentPath, type HarnessEvent, type SessionFile } from "@dispand/runner-protocol";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { AttachmentsRefused, copyAttachments, writeAnchored, writeAttachments } from "./attachments.ts";
import { Sessions } from "./sessions.ts";

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function runDir() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "attachments-")));
  made.push(dir);
  await mkdir(join(dir, ".dispand", "plans"), { recursive: true });
  return dir;
}

/** Every path under `dir`, relative to it. */
async function tree(dir: string, at = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(at, { withFileTypes: true })) {
    const path = join(at, entry.name);
    out.push(relative(dir, path));
    if (entry.isDirectory()) out.push(...(await tree(dir, path)));
  }
  return out;
}

/** A Dispand that serves these files to the runner's token only. */
async function dispand(files: Record<string, Buffer>) {
  const server = createServer((req, res) => {
    const id = req.url?.replace(/^\/runner\/attachments\//, "") ?? "";
    if (req.headers.authorization !== "Bearer rt_1") return void res.writeHead(401).end();
    if (!files[id]) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/octet-stream" }).end(files[id]);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  onTestFinished(() => new Promise<void>((r) => server.close(() => r())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const CONTROL = /(^|\/)(\.claude|\.codex|\.mcp\.json|claude\.md|agents\.md|agents\.override\.md)(\/|$)/i;

test("files named .mcp.json, CLAUDE.md or AGENTS.md land read-only under generated names, inside the attachments folder only", async () => {
  const dir = await runDir();
  const named = { att_1: ".mcp.json", att_2: "CLAUDE.md", att_3: "AGENTS.md", att_4: "photo.png" };
  const files = Object.entries(named).map(([id, name]) => ({ file: { attachmentId: id, path: attachmentPath(id, name) }, bytes: Buffer.from(`${name} body`) }));
  await writeAttachments(dir, files);
  const written = (await tree(dir)).filter((p) => !p.startsWith(".dispand/plans"));
  expect(written.sort()).toEqual([
    ".dispand",
    ".dispand/attachments",
    ".dispand/attachments/att_1",
    ".dispand/attachments/att_1/file.json",
    ".dispand/attachments/att_2",
    ".dispand/attachments/att_2/file.md",
    ".dispand/attachments/att_3",
    ".dispand/attachments/att_3/file.md",
    ".dispand/attachments/att_4",
    ".dispand/attachments/att_4/file.png",
  ]);
  // Nothing either CLI reads as configuration or instructions, at any depth.
  expect(written.filter((p) => CONTROL.test(p))).toEqual([]);
  expect(await readFile(join(dir, ".dispand/attachments/att_2/file.md"), "utf8")).toBe("CLAUDE.md body");
  expect((await lstat(join(dir, ".dispand/attachments/att_2/file.md"))).mode & 0o777).toBe(0o444);
  // The same message again: what is there stays.
  await writeAttachments(dir, files);
});

test("a crafted target path naming a control file is refused before anything is written", async () => {
  const dir = await runDir();
  for (const path of [".dispand/attachments/att_1/CLAUDE.md", ".dispand/attachments/att_1/AGENTS.md", ".mcp.json", ".claude/settings.json", ".codex/config.toml", ".dispand/attachments/att_1/../../CLAUDE.md"]) {
    const files = [
      { file: { attachmentId: "att_0", path: ".dispand/attachments/att_0/file.txt" }, bytes: Buffer.from("x") },
      { file: { attachmentId: "att_1", path } as SessionFile, bytes: Buffer.from("x") },
    ];
    await expect(writeAttachments(dir, files), path).rejects.toThrow(AttachmentsRefused);
  }
  expect(await readdir(join(dir, ".dispand"))).toEqual(["plans"]);
});

test("a .dispand or an attachment folder that is a link is refused, and nothing is written where it leads", async () => {
  const dir = await runDir();
  const elsewhere = await runDir();
  await mkdir(join(dir, ".dispand", "attachments"));
  await symlink(elsewhere, join(dir, ".dispand", "attachments", "att_1"));
  await expect(writeAttachments(dir, [{ file: { attachmentId: "att_1", path: ".dispand/attachments/att_1/file.txt" }, bytes: Buffer.from("x") }])).rejects.toThrow(AttachmentsRefused);
  expect(await readdir(elsewhere)).toEqual([".dispand"]);
  await rm(join(dir, ".dispand"), { recursive: true });
  await symlink(elsewhere, join(dir, ".dispand"));
  await expect(writeAttachments(dir, [{ file: { attachmentId: "att_2", path: ".dispand/attachments/att_2/file.txt" }, bytes: Buffer.from("x") }])).rejects.toThrow(AttachmentsRefused);
  expect(await readdir(join(elsewhere, ".dispand"))).toEqual(["plans"]);
});

test("a folder swapped for a link after the checks gets nothing: the write is anchored to the folder it checked", async () => {
  const dir = await runDir();
  const elsewhere = await runDir();
  await mkdir(join(dir, ".dispand", "attachments"));
  // What a live session could do between the runner's checks and its write.
  await symlink(join(elsewhere, ".dispand"), join(dir, ".dispand", "attachments", "att_1"));
  await expect(writeAnchored([{ dir: join(dir, ".dispand", "attachments", "att_1"), name: "file.md", base64: "eA==" }])).rejects.toThrow(AttachmentsRefused);
  expect(await readdir(join(elsewhere, ".dispand"))).toEqual(["plans"]);
  // A real folder: written there, read-only through its descriptor.
  await mkdir(join(dir, ".dispand", "attachments", "att_2"));
  await writeAnchored([{ dir: join(dir, ".dispand", "attachments", "att_2"), name: "file.md", base64: "eA==" }]);
  expect(await readFile(join(dir, ".dispand", "attachments", "att_2", "file.md"), "utf8")).toBe("x");
  expect((await lstat(join(dir, ".dispand", "attachments", "att_2", "file.md"))).mode & 0o777).toBe(0o444);
});

test("a file Dispand doesn't serve leaves a line for the agent; files are copied one at a time, those before it stay", async () => {
  const dir = await runDir();
  const server = await dispand({ att_1: Buffer.from("one") });
  const note = await copyAttachments(dir, [{ attachmentId: "att_1", path: ".dispand/attachments/att_1/file.txt" }, { attachmentId: "att_9", path: ".dispand/attachments/att_9/file.txt" }], { server, token: "rt_1" });
  expect(note).toBe("(The runner couldn't copy the attached files into your working folder: Dispand refused a file (404). Tell the person.)");
  expect(await readdir(join(dir, ".dispand", "attachments"))).toEqual(["att_1"]);
});

test("a CLI chat message's files are in the run folder before its text, which names their paths, reaches the CLI", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "sessions-")));
  made.push(base);
  const server = await dispand({ att_1: Buffer.from("PNGDATA") });
  const seen: { text: string; files: string[] }[] = [];
  let cwd = "";
  const fake = (({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => {
    cwd = options!.cwd!;
    async function* script(): AsyncGenerator<SDKMessage> {
      yield { type: "system", subtype: "init", session_id: "cli-1" } as SDKMessage;
      for await (const input of prompt) {
        // What the CLI finds in its folder when the text arrives.
        seen.push({ text: String(input.message.content), files: (await tree(cwd)).filter((p) => p.includes("attachments/")) });
        yield { type: "result", subtype: "success", result: "ok", session_id: "cli-1" } as SDKMessage;
      }
    }
    return Object.assign(script(), { interrupt: vi.fn(async () => undefined), setMcpServers: vi.fn(async () => ({ added: [], removed: [], errors: {} })) });
  }) as unknown as typeof query;
  const events: [string, HarnessEvent][] = [];
  const sessions = new Sessions({ server, roots: [join(base, "root")], allowBypass: false }, (id, e) => events.push([id, e]), {
    claude: { query: fake },
    resumeMap: join(base, "state", "sessions.json"),
    claudeVersion: "2.1.311",
    skills: { server, token: "rt_1", stateDir: join(base, "state") },
  });
  await sessions.handle({ type: "session.start", start: { sessionId: "ses_1", harness: "claude-code", cwd: { mode: "per-run", runKey: "run_a" }, systemPrompt: "", prompt: "", expectedOutputs: [], interactive: true, permissionMode: "default", skills: [], mcpServers: [] } });
  const path = attachmentPath("att_1", "CLAUDE.md");
  await sessions.handle({ type: "session.send", sessionId: "ses_1", text: `look\n\n- ${path}`, files: [{ attachmentId: "att_1", path }] });
  await vi.waitFor(() => expect(seen.some((s) => s.text.startsWith("look"))).toBe(true), { timeout: 20_000 });
  const message = seen.find((s) => s.text.startsWith("look"))!;
  expect(message.text).toContain(".dispand/attachments/att_1/file.md");
  expect(message.files).toEqual([".dispand/attachments/att_1", ".dispand/attachments/att_1/file.md"]);
  expect(await readFile(join(cwd, path), "utf8")).toBe("PNGDATA");
  sessions.stopAll("done");
  await sessions.shutdown();
});

test("a stop isn't held up by a message whose files are still being fetched, and that message then goes nowhere", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "sessions-")));
  made.push(base);
  // A Dispand that never answers for the file.
  const server = createServer(() => undefined);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  onTestFinished(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const inputs: string[] = [];
  let aborted!: () => void;
  const fake = (({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => {
    const gone = new Promise<void>((r) => (aborted = r));
    options!.abortController?.signal.addEventListener("abort", () => aborted());
    async function* script(): AsyncGenerator<SDKMessage> {
      yield { type: "system", subtype: "init", session_id: "cli-1" } as SDKMessage;
      const it = prompt[Symbol.asyncIterator]();
      for (;;) {
        const next = await Promise.race([it.next(), gone.then(() => ({ done: true as const, value: undefined }))]);
        if (next.done) return;
        inputs.push(String(next.value.message.content));
        yield { type: "result", subtype: "success", result: "ok", session_id: "cli-1" } as SDKMessage;
      }
    }
    return Object.assign(script(), { interrupt: vi.fn(async () => undefined), setMcpServers: vi.fn(async () => ({ added: [], removed: [], errors: {} })) });
  }) as unknown as typeof query;
  const events: [string, HarnessEvent][] = [];
  const sessions = new Sessions({ server: url, roots: [join(base, "root")], allowBypass: false }, (id, e) => events.push([id, e]), {
    claude: { query: fake },
    resumeMap: join(base, "state", "sessions.json"),
    claudeVersion: "2.1.311",
    skills: { server: url, token: "rt_1", stateDir: join(base, "state") },
  });
  await sessions.handle({ type: "session.start", start: { sessionId: "ses_1", harness: "claude-code", cwd: { mode: "per-run", runKey: "run_a" }, systemPrompt: "", prompt: "", expectedOutputs: [], interactive: true, permissionMode: "default", skills: [], mcpServers: [] } });
  const pending = sessions.handle({ type: "session.send", sessionId: "ses_1", text: "look", files: [{ attachmentId: "att_1", path: ".dispand/attachments/att_1/file.png" }] });
  const started = Date.now();
  await sessions.handle({ type: "session.stop", sessionId: "ses_1" });
  await vi.waitFor(() => expect(events.some(([, e]) => e.type === "session-ended")).toBe(true), { timeout: 10_000 });
  expect(Date.now() - started).toBeLessThan(10_000);
  server.closeAllConnections();
  await pending;
  expect(inputs).toEqual([]);
  await sessions.shutdown();
});
