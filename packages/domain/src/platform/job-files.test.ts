import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { say } from "../messages/index.ts";
import { afterEach, expect, onTestFinished, test } from "vitest";
import { MAX_FILE_BYTES, MAX_JOB_BYTES, sweepAttachments } from "../data/files.ts";
import { writeRow } from "../data/rows.ts";
import { attachments, runs } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { router } from "../rpc/router.ts";
import { runnerWithClis, asCli, ownerContext, recordScopes } from "../runners/test-support.ts";
import { inScope, SYSTEM } from "../db/scope.ts";
import { startFakeMcp, type FakeMcp } from "../tools/test-server.ts";
import { jobTokenOf } from "./token.ts";
import { handleJobToolsMcp } from "./tools-mcp.ts";
import { handleJobFiles } from "./job-files.ts";

const servers: FakeMcp[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

// The smallest valid PNG header: signature, then the IHDR chunk's start.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const PDF = Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj << >> endobj\n");
const HOUR = 3600_000;

/**
 * A CLI agent with a mail tool whose read-only actions return files (so they run unasked), a
 * table with a file field, and an MCP client on the tools endpoint for each Job started.
 */
async function setup() {
  const context = await ownerContext();
  const server = await startFakeMcp([
    {
      name: "get_mail",
      annotations: { readOnlyHint: true },
      call: () => ({
        content: [
          { type: "text", text: "Your invoice." },
          { type: "image", data: PNG.toString("base64"), mimeType: "image/png" },
          { type: "resource", resource: { uri: "mail://inbox/42/invoice.pdf?part=2", mimeType: "application/pdf", blob: PDF.toString("base64") } },
        ],
      }),
    },
    {
      name: "get_big",
      annotations: { readOnlyHint: true },
      call: () => ({ content: [{ type: "resource", resource: { uri: "mail://inbox/43/scan.tiff", blob: Buffer.alloc(MAX_FILE_BYTES + 1).toString("base64") } }] }),
    },
  ]);
  servers.push(server);
  const { runnerId } = await runnerWithClis(context);
  const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
  const tool = await call(router.tools.create, { name: "Mail", url: server.url, transport: "streamable-http", headers: {} }, { context });
  const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "", toolIds: [tool.id] }, { context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
  const table = await call(router.tables.create, { name: "Invoices" }, { context });
  const scan = await call(router.fields.create, { tableId: table.id, name: "Scan", type: "attachment" }, { context });

  /** A new Job of the agent and a client of its tools endpoint. */
  const job = async () => {
    const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context });
    const [run] = await context.db.select().from(runs).where(eq(runs.id, runId));
    const token = jobTokenOf(context.secrets, run!)!;
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("https://dispand.test/mcp/job/tools"), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
        fetch: (input, init) => handleJobToolsMcp(new Request(input as string | URL, init as RequestInit), context),
      }),
    );
    onTestFinished(() => client.close());
    const named = async (readable: string) => (await client.listTools()).tools.find((t) => t.name.startsWith(`${readable}_`))!.name;
    const callTool = async (readable: string) => {
      const result = (await client.callTool({ name: await named(readable), arguments: {} })) as { content: { text: string }[]; isError?: boolean };
      return { text: result.content[0]!.text, isError: result.isError === true };
    };
    /** What the runner's MCP proxy sends for one result of a runner tool, with this Job's token. */
    const send = (files: { name: string; bytes: Buffer }[], bearer = token, app: typeof context = context) =>
      handleJobFiles(
        new Request("https://dispand.test/mcp/job/files", {
          method: "POST",
          headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
          body: JSON.stringify({ files: files.map((f) => ({ name: f.name, base64: f.bytes.toString("base64") })) }),
        }),
        app,
      );
    return { runId, callTool, send };
  };
  /** Writes `ids` in the file field of a new row, as `actor`. */
  const write = (ids: string[], actor: Parameters<typeof writeRow>[1]["actor"]) =>
    context.db.transaction((tx) => writeRow(tx, { ownerId: context.ownerId, workspaceId: context.workspaceId, tableId: table.id, values: { [scan.id]: ids }, actor }));
  return { context, table, job, write };
}

const ownedBy = async (s: Awaited<ReturnType<typeof setup>>, runId: string) =>
  (await s.context.db.select().from(attachments).where(eq(attachments.jobId, runId))).sort((a, b) => a.name.localeCompare(b.name));

test("files a tool returns are kept for the Job and handed to the agent as ids; one written to a file field becomes the table's, the other is swept an hour after the Job", async () => {
  const s = await setup();
  const { runId, callTool } = await s.job();
  const result = await callTool("mail_get_mail");
  expect(result.isError).toBe(false);
  const [image, pdf] = await ownedBy(s, runId);
  expect(image).toMatchObject({ name: "image", mime: "image/png", image: true, size: PNG.length, tableId: null, ownerId: s.context.ownerId });
  // A PDF is never an image: it would be served as a download only.
  expect(pdf).toMatchObject({ name: "invoice.pdf", mime: "application/octet-stream", image: false, size: PDF.length, tableId: null });
  // The agent gets the ids in place of the bytes.
  expect(result.text).toContain("Your invoice.");
  expect(result.text).toContain(`attachment ${image!.id}, image/png, ${PNG.length} bytes`);
  expect(result.text).toContain(`attachment ${pdf!.id}, application/octet-stream`);
  expect(result.text).not.toContain(PDF.toString("base64"));
  const dir = join(s.context.filesDir, s.context.ownerId);
  expect((await readdir(dir)).sort()).toEqual([image!.id, pdf!.id].sort());

  // The Job writes the PDF in a row: it becomes the table's.
  expect(await s.write([pdf!.id], { type: "job", runId })).toHaveProperty("row");
  const [placed] = await s.context.db.select().from(attachments).where(eq(attachments.id, pdf!.id));
  expect(placed!.tableId).toBe(s.table.id);

  // While the Job goes on, nothing of it is swept, however old.
  const later = new Date(Date.now() + 3 * HOUR);
  expect(await sweepAttachments(s.context.db, s.context.filesDir, later)).toEqual({ removed: 0 });
  // It ends: its files are kept for an hour, then the unused image goes; the written PDF stays.
  const ended = new Date(Date.now() + 4 * HOUR);
  await s.context.db.update(runs).set({ status: "succeeded", finishedAt: ended }).where(eq(runs.id, runId));
  expect(await sweepAttachments(s.context.db, s.context.filesDir, new Date(ended.getTime() + 30 * 60_000))).toEqual({ removed: 0 });
  expect(await sweepAttachments(s.context.db, s.context.filesDir, new Date(ended.getTime() + HOUR + 60_000))).toEqual({ removed: 1 });
  expect((await s.context.db.select({ id: attachments.id }).from(attachments)).map((a) => a.id)).toEqual([pdf!.id]);
  expect(await readdir(dir)).toEqual([pdf!.id]);
});

test("writeRow refuses another Job's file, a Job's file written by a person, and a file another table already has", async () => {
  const s = await setup();
  const first = await s.job();
  await first.callTool("mail_get_mail");
  const [image, pdf] = await ownedBy(s, first.runId);
  const second = await s.job();
  expect(await s.write([image!.id], { type: "job", runId: second.runId })).toEqual({ problem: say("data.row.noFile", { field: "Scan" }) });
  expect(await s.write([image!.id], { type: "user", userId: s.context.ownerId })).toEqual({ problem: say("data.row.noFile", { field: "Scan" }) });
  // The first Job places the PDF in another table; it can't move it to this one.
  const other = await call(router.tables.create, { name: "Archive" }, { context: s.context });
  const file = await call(router.fields.create, { tableId: other.id, name: "File", type: "attachment" }, { context: s.context });
  const placed = await s.context.db.transaction((tx) => writeRow(tx, { ownerId: s.context.ownerId, workspaceId: s.context.workspaceId, tableId: other.id, values: { [file.id]: [pdf!.id] }, actor: { type: "job", runId: first.runId } }));
  expect(placed).toHaveProperty("row");
  expect(await s.write([pdf!.id], { type: "job", runId: first.runId })).toEqual({ problem: say("data.row.noFile", { field: "Scan" }) });
  // Still unclaimed, still the first Job's.
  expect((await ownedBy(s, first.runId)).map((a) => [a.id, a.tableId])).toEqual([
    [image!.id, null],
    [pdf!.id, other.id],
  ]);
});

test("a file over the size limit isn't kept, and the agent is told why", async () => {
  const s = await setup();
  const { runId, callTool } = await s.job();
  const result = await callTool("mail_get_big");
  expect(result.isError).toBe(false);
  expect(result.text).toContain("None of the files in this result were kept: file 1 (“scan.tiff”) is larger than 10 MiB, the most a file may be.");
  expect(await ownedBy(s, runId)).toEqual([]);
});

const files = (n: number, size = 16) => Array.from({ length: n }, (_, i) => ({ name: `f${i}.bin`, bytes: Buffer.alloc(size, i) }));
const textOf = async (response: Response) => {
  expect(response.status).toBe(200);
  return ((await response.json()) as { text: string }).text;
};

test("a runner tool's image becomes an attachment of the token's Job, and the reply names it", async () => {
  const s = await setup();
  const { runId, send } = await s.job();
  const text = await textOf(await send([{ name: "image", bytes: PNG }]));
  const [image] = await ownedBy(s, runId);
  expect(image).toMatchObject({ name: "image", mime: "image/png", image: true, size: PNG.length, tableId: null, ownerId: s.context.ownerId });
  expect(text).toBe(`Files in this result, kept for this Job (write an attachment's id in a file field to keep it; the others are removed an hour after the Job ends):\nFile 1 (“image”): attachment ${image!.id}, image/png, ${PNG.length} bytes`);
  // Only a live Job's token: another bearer gets nothing in.
  expect((await send([{ name: "image", bytes: PNG }], "dj_not-a-token")).status).toBe(401);
  expect(await ownedBy(s, runId)).toHaveLength(1);
});

test("a runner tool's files are kept in the Job's scope on the guarded db, whatever scope its caller is in", { tags: ["pglite-only"] }, async () => {
  const s = await setup();
  const { runId, send } = await s.job();
  const recorder = await recordScopes(s.context.db);
  const sent = await inScope({ workspaceId: "ws_other" }, () => send([{ name: "image", bytes: PNG }], undefined, { ...s.context, db: recorder.db }));
  expect(sent.status).toBe(200);
  expect(await ownedBy(s, runId)).toHaveLength(1);
  const jobScope = { userId: s.context.ownerId, organizationId: s.context.organizationId, workspaceId: s.context.workspaceId };
  expect(recorder.statements[0]!.scope).toBe(SYSTEM);
  for (const { scope } of recorder.statements.slice(1)) expect(scope).toEqual(jobScope);
});

test("a runner tool's oversized file, or too many files, is refused whole, with the reason", async () => {
  const s = await setup();
  const { runId, send } = await s.job();
  expect(await textOf(await send([{ name: "small.txt", bytes: Buffer.from("hi") }, { name: "scan.tiff", bytes: Buffer.alloc(MAX_FILE_BYTES + 1) }]))).toBe(
    "None of the files in this result were kept: file 2 (“scan.tiff”) is larger than 10 MiB, the most a file may be.",
  );
  expect(await textOf(await send(files(21)))).toBe("None of the 21 files in this result were kept: a result keeps at most 20.");
  expect(await ownedBy(s, runId)).toEqual([]);
});

test("a tool returning files on every call is refused once the Job's total is reached, keeping nothing of that result", async () => {
  const s = await setup();
  const { runId, callTool, send } = await s.job();
  // Every source counts: two files of a tool reached by URL, then 93 of a runner tool.
  await callTool("mail_get_mail");
  for (const n of [20, 20, 20, 20, 13]) await textOf(await send(files(n)));
  expect(await ownedBy(s, runId)).toHaveLength(95);
  expect(await textOf(await send(files(10)))).toBe("None of the files in this result were kept: this Job already keeps 95 files, and a Job keeps at most 100.");
  expect(await ownedBy(s, runId)).toHaveLength(95);
  // What still fits goes in.
  await textOf(await send(files(5)));
  expect(await textOf(await send(files(1)))).toContain("this Job already keeps 100 files");
  // Another Job has its own total.
  const other = await s.job();
  expect(await textOf(await other.send(files(1)))).toContain("kept for this Job");
});

test("two results at once that each fit the Job's total alone, but not together: one is kept, the other refused whole", async () => {
  const s = await setup();
  const { runId, send } = await s.job();
  for (let i = 0; i < 4; i++) await textOf(await send(files(20)));
  await textOf(await send(files(15)));
  const texts = await Promise.all([send(files(5)), send(files(5))].map(async (r) => textOf(await r)));
  expect(texts.filter((t) => t.includes("kept for this Job"))).toHaveLength(1);
  expect(texts.filter((t) => t.includes("this Job already keeps 100 files"))).toHaveLength(1);
  expect(await ownedBy(s, runId)).toHaveLength(100);
});

test("a Job's bytes count too: a result that would pass 200 MiB is refused whole", async () => {
  const s = await setup();
  const { runId, send } = await s.job();
  // The Job already keeps 199 MiB (a row's size counts, its bytes needn't fill the disk).
  const MIB = 1024 * 1024;
  await s.context.db.insert(attachments).values({ id: newId("att"), workspaceId: s.context.workspaceId, ownerId: s.context.ownerId, jobId: runId, name: "earlier", mime: "application/octet-stream", size: MAX_JOB_BYTES - MIB, image: false });
  expect(await textOf(await send(files(1, MIB / 2)))).toContain("kept for this Job");
  expect(await textOf(await send(files(2, MIB / 2)))).toBe("None of the files in this result were kept: with them, this Job's files would pass 200 MiB, the most a Job keeps.");
  expect(await ownedBy(s, runId)).toHaveLength(2);
});

test("many Jobs each under their total are refused once the install's total is reached", async () => {
  const s = await setup();
  await call(router.workspace.setFilesLimit, { mib: 1 }, { context: s.context });
  const third = 300 * 1024;
  for (let i = 0; i < 3; i++) {
    const { send } = await s.job();
    expect(await textOf(await send(files(1, third)))).toContain("kept for this Job");
  }
  const last = await s.job();
  expect(await textOf(await last.send(files(1, third)))).toBe("None of the files in this result were kept: with them, Dispand's files would pass 1 MiB, the most this organization keeps (a setting of its owner).");
  expect(await ownedBy(s, last.runId)).toEqual([]);
  expect(await s.context.db.select().from(attachments)).toHaveLength(3);
});

test("a file store that fails gives the agent a fixed reason, not the error", async () => {
  const s = await setup();
  const { callTool } = await s.job();
  // The owner's directory can't be made: a plain file is in its place.
  await writeFile(join(s.context.filesDir, s.context.ownerId), "x");
  const result = await callTool("mail_get_mail");
  expect(result).toEqual({ text: "The call ran, but the files it returned couldn't be kept.", isError: true });
});
