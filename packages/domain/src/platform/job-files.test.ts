import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, onTestFinished, test } from "vitest";
import { MAX_FILE_BYTES, sweepAttachments } from "../data/files.ts";
import { writeRow } from "../data/rows.ts";
import { attachments, runs } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { asCli, ownerContext } from "../runners/test-support.ts";
import { startFakeMcp, type FakeMcp } from "../tools/test-server.ts";
import { jobTokenOf } from "./token.ts";
import { handleJobToolsMcp } from "./tools-mcp.ts";

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
  const { runnerId } = await call(router.runners.create, { name: "Workstation" }, { context });
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
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("https://dispand.test/mcp/job/tools"), {
        requestInit: { headers: { authorization: `Bearer ${jobTokenOf(context.secrets, run!)!}` } },
        fetch: (input, init) => handleJobToolsMcp(new Request(input as string | URL, init as RequestInit), context),
      }),
    );
    onTestFinished(() => client.close());
    const named = async (readable: string) => (await client.listTools()).tools.find((t) => t.name.startsWith(`${readable}_`))!.name;
    const callTool = async (readable: string) => {
      const result = (await client.callTool({ name: await named(readable), arguments: {} })) as { content: { text: string }[]; isError?: boolean };
      return { text: result.content[0]!.text, isError: result.isError === true };
    };
    return { runId, callTool };
  };
  /** Writes `ids` in the file field of a new row, as `actor`. */
  const write = (ids: string[], actor: Parameters<typeof writeRow>[1]["actor"]) =>
    context.db.transaction((tx) => writeRow(tx, { ownerId: context.ownerId, tableId: table.id, values: { [scan.id]: ids }, actor }));
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
  expect(await s.write([image!.id], { type: "job", runId: second.runId })).toEqual({ problem: "“Scan”: no such file" });
  expect(await s.write([image!.id], { type: "user", userId: s.context.ownerId })).toEqual({ problem: "“Scan”: no such file" });
  // The first Job places the PDF in another table; it can't move it to this one.
  const other = await call(router.tables.create, { name: "Archive" }, { context: s.context });
  const file = await call(router.fields.create, { tableId: other.id, name: "File", type: "attachment" }, { context: s.context });
  const placed = await s.context.db.transaction((tx) => writeRow(tx, { ownerId: s.context.ownerId, tableId: other.id, values: { [file.id]: [pdf!.id] }, actor: { type: "job", runId: first.runId } }));
  expect(placed).toHaveProperty("row");
  expect(await s.write([pdf!.id], { type: "job", runId: first.runId })).toEqual({ problem: "“Scan”: no such file" });
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
  expect(result.text).toContain("File 1 (“scan.tiff”): not kept, files are at most 10 MiB");
  expect(await ownedBy(s, runId)).toEqual([]);
});
