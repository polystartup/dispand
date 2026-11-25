import { call } from "@orpc/server";
import type { ServerToRunner } from "@dispand/runner-protocol";
import { eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { fakeModel, say } from "../cloud/test-model.ts";
import { fileInput } from "../cloud/model-client.ts";
import { attachments, agents, messages, organizations, runners, runs, stepRuns, user, workspaces } from "../db/schema.ts";
import { chatFiles, CliHarnessAdapter, createEngine } from "../engine/cli-harness.ts";
import { Engine } from "../engine/engine.ts";
import { newId } from "../ids.ts";
import { router } from "../rpc/router.ts";
import { handleRunnerAttachment } from "../runners/attachments.ts";
import type { RunnerHub } from "../runners/hub.ts";
import { pair } from "../runners/pairing.ts";
import { ownerContext, recordScopes, runnerWithClis } from "../runners/test-support.ts";
import { inScope, SYSTEM } from "../db/scope.ts";
import { MAX_FILE_BYTES, MAX_JOB_BYTES, sweepAttachments } from "./files.ts";

// The smallest valid PNG header: signature, then the IHDR chunk's start.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const HOUR = 3600_000;

/** Stem on a runner's Claude Code, with every message the hub would write to that runner. */
async function setup() {
  const base = await ownerContext();
  const { runnerId, token } = await createRunnerWithToken(base);
  const harness = await call(router.harnesses.create, { name: "CLI", kind: "claude-code", runnerId, permissionMode: "default" }, { context: base });
  const assistant = await call(router.agents.ensureAssistant, { harnessId: harness.id }, { context: base });
  const sent: ServerToRunner[] = [];
  const hub = { send: async (_runner: string, msg: ServerToRunner) => (sent.push(msg), true) };
  const engine = new Engine(base.db, new CliHarnessAdapter(base.db, hub as unknown as RunnerHub, base.secrets), undefined, undefined, undefined, base.secrets);
  onTestFinished(() => engine.stop());
  const context = { ...base, engine };
  const hold = (name: string, bytes: Buffer = PNG, as = context) => call(router.files.hold, { file: new File([new Uint8Array(bytes)], name) }, { context: as });
  return { context, runnerId, token, assistant, sent, engine, hold };
}

async function createRunnerWithToken(context: Awaited<ReturnType<typeof ownerContext>>) {
  const { pairingCode } = await runnerWithClis(context);
  return pair(context.db, pairingCode);
}

/** Starts the chat's Job and lets its session start, as a first message does. */
async function started(s: Awaited<ReturnType<typeof setup>>) {
  const { runId } = await call(router.jobs.start, { triggerId: s.assistant.triggerId }, { context: s.context });
  await vi.waitFor(() => expect(s.sent.some((m) => m.type === "session.start")).toBe(true));
  const start = s.sent.flatMap((m) => (m.type === "session.start" ? [m.start] : []))[0]!;
  await s.engine.onHarnessEvent(start.sessionId, { type: "cli-session", cliSessionId: "cli_1" }, { runnerId: s.runnerId, seq: 1 });
  await s.engine.onHarnessEvent(start.sessionId, { type: "turn-end" }, { runnerId: s.runnerId, seq: 2 });
  return runId;
}

test("a file attached before the first message is held for the person, then reaches the Job that message starts", async () => {
  const s = await setup();
  const held = await s.hold("photo.png");
  expect(held).toMatchObject({ name: "photo.png", image: true, mime: "image/png" });
  const [row] = await s.context.db.select().from(attachments).where(eq(attachments.id, held.id));
  expect(row).toMatchObject({ jobId: null, tableId: null });
  const runId = await started(s);
  await call(router.runs.sendChat, { runId, text: "What is this?", attachmentIds: [held.id] }, { context: s.context });
  const [now] = await s.context.db.select().from(attachments).where(eq(attachments.id, held.id));
  expect(now?.jobId).toBe(runId);
  const [message] = await s.context.db.select().from(messages).where(eq(messages.runId, runId));
  expect(message?.files).toEqual([{ id: held.id, name: "photo.png", image: true }]);
  expect(message?.text).toBe("What is this?");
  // Taken: another message can't carry it again.
  await expect(call(router.runs.sendChat, { runId, text: "Again", attachmentIds: [held.id] }, { context: s.context })).rejects.toMatchObject({ code: "BAD_REQUEST", data: { key: "data.file.gone" } });
});

test("a CLI message carries generated paths: a file named .mcp.json, CLAUDE.md or AGENTS.md keeps its name only as words", async () => {
  const s = await setup();
  const runId = await started(s);
  const ids: string[] = [];
  for (const name of [".mcp.json", "CLAUDE.md", "AGENTS.md"]) ids.push((await s.hold(name, Buffer.from(`{"x": "${name}"}`))).id);
  await call(router.runs.sendChat, { runId, text: "Read these", attachmentIds: ids }, { context: s.context });
  await vi.waitFor(() => expect(s.sent.some((m) => m.type === "session.send")).toBe(true));
  const msg = s.sent.find((m) => m.type === "session.send") as Extract<ServerToRunner, { type: "session.send" }>;
  expect(msg.files).toEqual([
    { attachmentId: ids[0], path: `.dispand/attachments/${ids[0]}/file.json` },
    { attachmentId: ids[1], path: `.dispand/attachments/${ids[1]}/file.md` },
    { attachmentId: ids[2], path: `.dispand/attachments/${ids[2]}/file.md` },
  ]);
  expect(msg.text).toBe(
    `Read these\n\nFiles attached to this message, copied into your working folder (paths relative to it):\n- .dispand/attachments/${ids[0]}/file.json (attached as “.mcp.json”)\n- .dispand/attachments/${ids[1]}/file.md (attached as “CLAUDE.md”)\n- .dispand/attachments/${ids[2]}/file.md (attached as “AGENTS.md”)`,
  );

  // The runner fetches them with its token; another runner gets nothing.
  const fetch = (id: string, token: string) => handleRunnerAttachment(new Request(`https://dispand.test/runner/attachments/${id}`, { headers: { authorization: `Bearer ${token}` } }), s.context, id);
  const res = await fetch(ids[1]!, s.token);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe('{"x": "CLAUDE.md"}');
  // On the guarded db, from inside another scope: the token lookup under SYSTEM, the rest in the runner's workspace.
  const recorder = await recordScopes(s.context.db);
  const scoped = await inScope({ workspaceId: "ws_other" }, () => handleRunnerAttachment(new Request(`https://dispand.test/runner/attachments/${ids[1]}`, { headers: { authorization: `Bearer ${s.token}` } }), { ...s.context, db: recorder.db }, ids[1]!));
  expect(scoped.status).toBe(200);
  expect(recorder.statements.map((st) => st.scope)).toEqual([SYSTEM, ...recorder.statements.slice(1).map(() => ({ organizationId: s.context.organizationId, workspaceId: s.context.workspaceId }))]);
  // A runner of the workspace registered by another member serves the Job's files too.
  await s.context.db.insert(user).values({ id: "user_bo", name: "Bo", email: "bo@example.com" });
  await s.context.db.update(runners).set({ ownerId: "user_bo" }).where(eq(runners.id, s.runnerId));
  expect((await fetch(ids[1]!, s.token)).status).toBe(200);
  const other = await createRunnerWithToken(s.context);
  expect((await fetch(ids[1]!, other.token)).status).toBe(404);
  expect((await fetch(ids[1]!, "rt_wrong")).status).toBe(401);
  // A held file, given to no Job yet, isn't served to any runner.
  const held = await s.hold("later.png");
  expect((await fetch(held.id, s.token)).status).toBe(404);
  // Inconsistent on purpose: a database whose keys don't carry the workspace lets the run leave its
  // steps and runner behind, and only the runner's workspace check refuses the file then.
  await s.context.db.insert(workspaces).values({ id: "sibling", organizationId: s.context.organizationId });
  await s.context.db.update(runs).set({ workspaceId: "sibling" }).where(eq(runs.id, runId));
  expect((await fetch(ids[1]!, s.token)).status).toBe(404);
});

test("a crafted target path naming a control file is refused by the server before any runner is told", () => {
  expect(chatFiles("hi", [{ id: "att_1", name: "CLAUDE.md" }]).files).toEqual([{ attachmentId: "att_1", path: ".dispand/attachments/att_1/file.md" }]);
  for (const id of ["../../.claude", "x/../../CLAUDE.md", ".codex", "a/b"]) expect(() => chatFiles("hi", [{ id, name: "AGENTS.md" }]), id).toThrow();
});

test("a cloud chat message with an image reaches the model as image input, at every model call", async () => {
  const s = await setup();
  const cloud = await call(router.harnesses.create, { type: "cloud", name: "Cloud", kind: "anthropic", apiKey: "sk-test", model: "m", systemPrompt: "" }, { context: s.context });
  await s.context.db.update(agents).set({ harnessId: cloud.id }).where(eq(agents.id, s.assistant.agentId));
  const model = fakeModel(say("A PNG."), say("Still a PNG."));
  const engine = createEngine(s.context.db, s.context.hub, s.context.secrets, s.context.dataEvents, { client: model.client, filesDir: s.context.filesDir });
  onTestFinished(() => engine.stop());
  const context = { ...s.context, engine };
  const held = await s.hold("photo.png");
  const { runId } = await call(router.jobs.start, { triggerId: s.assistant.triggerId }, { context });
  await call(router.runs.sendChat, { runId, text: "What is this?", attachmentIds: [held.id] }, { context });
  await vi.waitFor(() => expect(model.inputs).toHaveLength(1));
  const user = model.inputs[0]!.items.findLast((i) => i.role === "user")!;
  expect(user).toMatchObject({ text: "What is this?", files: [{ id: held.id, name: "photo.png" }] });
  const file = user.role === "user" ? user.files![0]! : undefined;
  expect(fileInput(file!)).toEqual({ kind: "image", mime: "image/png", base64: PNG.toString("base64") });
  // The transcript keeps the id only; the bytes are read again for the next call.
  await call(router.runs.sendChat, { runId, text: "And now?" }, { context });
  await vi.waitFor(() => expect(model.inputs).toHaveLength(2));
  const first = model.inputs[1]!.items.find((i) => i.role === "user" && i.files?.length);
  expect(first && first.role === "user" && fileInput(first.files![0]!).kind).toBe("image");
  const [step] = await s.context.db.select().from(stepRuns).where(eq(stepRuns.runId, runId));
  expect(JSON.stringify(step)).not.toContain(PNG.toString("base64"));
});

test("an oversized file, too many files, or files past the Job's or the install's total are refused", async () => {
  const s = await setup();
  await expect(s.hold("big.bin", Buffer.alloc(MAX_FILE_BYTES + 1))).rejects.toMatchObject({ code: "BAD_REQUEST", data: { key: "data.file.tooLarge" } });
  const runId = await started(s);
  const many = Array.from({ length: 21 }, (_, i) => `att_${i}`);
  await expect(call(router.runs.sendChat, { runId, text: "All", attachmentIds: many }, { context: s.context })).rejects.toMatchObject({ code: "BAD_REQUEST" });

  // The Job already keeps 199 MiB (a row's size counts, its bytes aren't needed here).
  await s.context.db.insert(attachments).values({ id: newId("att"), workspaceId: s.context.workspaceId, ownerId: s.context.ownerId, jobId: runId, name: "earlier", mime: "application/octet-stream", size: MAX_JOB_BYTES - 1024 * 1024 + 1, image: false });
  const held = await s.hold("two.bin", Buffer.alloc(1024 * 1024));
  await expect(call(router.runs.sendChat, { runId, text: "Too much", attachmentIds: [held.id] }, { context: s.context })).rejects.toMatchObject({ code: "BAD_REQUEST", data: { key: "data.file.jobFull" } });
  // Refused whole: no message, the file still held for the person.
  expect((await s.context.db.select().from(messages).where(eq(messages.runId, runId))).filter((m) => m.role === "user")).toEqual([]);
  expect((await s.context.db.select().from(attachments).where(eq(attachments.id, held.id)))[0]?.jobId).toBeNull();

  // Held files count in the organization's total: past it, nothing more is held.
  await s.context.db.update(organizations).set({ filesQuotaBytes: 200 * 1024 * 1024 }).where(eq(organizations.id, s.context.organizationId));
  await expect(s.hold("three.bin", Buffer.alloc(1024))).rejects.toMatchObject({ code: "BAD_REQUEST", data: { key: "data.file.installFull", values: { limit: 200 } } });
});

test("a file is taken only from its owner's own held files: never another person's, nor one another chat took", async () => {
  const s = await setup();
  const runA = await started(s);
  await s.context.db.insert(user).values({ id: "other", name: "Other", email: "other@example.test" });
  const theirs = newId("att");
  await s.context.db.insert(attachments).values({ id: theirs, workspaceId: s.context.workspaceId, ownerId: "other", name: "theirs.png", mime: "image/png", size: PNG.length, image: true });
  await expect(call(router.runs.sendChat, { runId: runA, text: "Theirs", attachmentIds: [theirs] }, { context: s.context })).rejects.toMatchObject({ code: "BAD_REQUEST", data: { key: "data.file.gone" } });
  expect((await s.context.db.select().from(attachments).where(eq(attachments.id, theirs)))[0]?.jobId).toBeNull();

  const mine = await s.hold("mine.png");
  await call(router.runs.sendChat, { runId: runA, text: "Mine", attachmentIds: [mine.id] }, { context: s.context });
  const { runId: runB } = await call(router.jobs.start, { triggerId: s.assistant.triggerId }, { context: s.context });
  await expect(call(router.runs.sendChat, { runId: runB, text: "Again here", attachmentIds: [mine.id] }, { context: s.context })).rejects.toMatchObject({ code: "BAD_REQUEST", data: { key: "data.file.gone" } });
  expect((await s.context.db.select().from(attachments).where(eq(attachments.id, mine.id)))[0]?.jobId).toBe(runA);
});

test("only a person attaches files: a Job can't hold one or send one", async () => {
  const s = await setup();
  const runId = await started(s);
  const asJob = { ...s.context, job: { ownerId: s.context.ownerId, workspaceId: s.context.workspaceId, runId, agentId: s.assistant.agentId } };
  await expect(s.hold("x.png", PNG, asJob)).rejects.toMatchObject({ code: "FORBIDDEN" });
  const held = await s.hold("x.png");
  await expect(call(router.runs.sendChat, { runId, text: "x", attachmentIds: [held.id] }, { context: asJob })).rejects.toMatchObject({ code: "FORBIDDEN" });
});

test("a held file never sent goes after a day; a chat's files stay with their Job between turns", async () => {
  const s = await setup();
  const held = await s.hold("never.png");
  const runId = await started(s);
  const sentFile = await s.hold("sent.png");
  await call(router.runs.sendChat, { runId, text: "Look", attachmentIds: [sentFile.id] }, { context: s.context });
  await s.context.db.update(runs).set({ status: "succeeded", finishedAt: new Date(Date.now() - 2 * HOUR) }).where(eq(runs.id, runId));
  const ids = async () => (await s.context.db.select({ id: attachments.id }).from(attachments)).map((a) => a.id).sort();

  await sweepAttachments(s.context.db, s.context.filesDir, new Date(Date.now() + 2 * HOUR));
  expect(await ids()).toEqual([held.id, sentFile.id].sort());
  await sweepAttachments(s.context.db, s.context.filesDir, new Date(Date.now() + 25 * HOUR));
  expect(await ids()).toEqual([sentFile.id]);
  // Taken by a table, then no cell holds it: the chat still carries it, so it stays.
  const table = await call(router.tables.create, { name: "Scans" }, { context: s.context });
  await s.context.db.update(attachments).set({ tableId: table.id }).where(eq(attachments.id, sentFile.id));
  await sweepAttachments(s.context.db, s.context.filesDir, new Date(Date.now() + 26 * HOUR));
  expect(await ids()).toEqual([sentFile.id]);
  expect(await readFile(join(s.context.filesDir, s.context.ownerId, sentFile.id))).toEqual(PNG);
});

test("a raster filename cannot mark a non-image chat attachment as previewable", async () => {
  const s = await setup();
  const held = await s.hold("photo.png", Buffer.from("not an image"));
  const runId = await started(s);
  await call(router.runs.sendChat, { runId, text: "Look", attachmentIds: [held.id] }, { context: s.context });
  const [saved] = await s.context.db.select().from(messages).where(eq(messages.runId, runId));
  expect(saved?.files).toEqual([{ id: held.id, name: "photo.png" }]);
});
