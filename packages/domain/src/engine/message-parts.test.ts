import type { HarnessEvent } from "@dispand/runner-protocol";
import { call } from "@orpc/server";
import { and, eq, isNotNull } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import { messageParts, messages, stepRuns } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { ownerContext, runnerWithClis } from "../runners/test-support.ts";
import { Engine } from "./engine.ts";
import { foldParts } from "./message-parts.ts";
import { FakeAdapter } from "./test-support.ts";
import type { RunEvent } from "./views.ts";

/** A chat Job with a live session on a fake runner, its first turn started; `engine()` makes another engine on its database. */
async function chat() {
  const context = await ownerContext();
  const { runnerId } = await runnerWithClis(context, "Runner");
  const harness = await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context });
  const agent = await call(router.agents.create, { name: "Assistant", harnessId: harness.id, systemPrompt: "" }, { context });
  const engine = () => {
    const made = new Engine(context.db, new FakeAdapter(), undefined, undefined, undefined, context.secrets);
    onTestFinished(() => made.stop());
    return made;
  };
  const first = engine();
  const config = { kind: "manual" as const, placement: "chat" as const };
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Chat", instructions: "Help.", config }, { context });
  const runId = await first.startJob(trigger.id, context.ownerId);
  const step = async () =>
    (
      await context.db
        .select()
        .from(stepRuns)
        .where(and(eq(stepRuns.runId, runId), isNotNull(stepRuns.sessionId)))
    )[0]!;
  await vi.waitFor(async () => expect((await step()).startDeliveredAt).toBeTruthy());
  const { sessionId, id: stepId } = await step();
  let seq = 0;
  // The runner's seq goes on across engines, as it does across the server's restarts.
  const emitTo = (to: Engine, event: HarnessEvent, at = ++seq) => to.onHarnessEvent(sessionId!, event, { runnerId, seq: at });
  const emit = (event: HarnessEvent) => emitTo(first, event);
  await emit({ type: "turn-start", turnId: "first", interruptible: false });
  const live: RunEvent[] = [];
  onTestFinished(first.events.subscribe(runId, (e) => live.push(e)));
  const stored = async () =>
    context.db
      .select()
      .from(messages)
      .where(and(eq(messages.runId, runId), eq(messages.role, "assistant")))
      .orderBy(messages.position);
  const parts = async () => context.db.select().from(messageParts);
  const lastLive = () => live.flatMap((e) => (e.type === "message" ? [e.message] : [])).at(-1);
  return { context, runId, stepId, first, engine, emit, emitTo, lastSeq: () => seq, stored, parts, lastLive };
}

const words = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `w${from + i} `);

test("a streamed answer is its deltas in order: parts while it streams, live events whole, one row once its turn ends", async () => {
  const c = await chat();
  const deltas = words(40);
  for (const [i, delta] of deltas.entries()) await c.emit({ type: "text", delta, ...(i === 0 ? { newMessage: true as const } : {}) });
  // The row holds the first delta, its parts the rest: each event wrote only its own.
  const [streaming] = await c.stored();
  expect(streaming!.text).toBe(deltas[0]);
  expect((await c.parts()).map((p) => p.text)).toEqual(deltas.slice(1));
  expect(c.lastLive()).toMatchObject({ id: streaming!.id, text: deltas.join("") });
  await c.emit({ type: "turn-end", turnId: "first" });
  expect((await c.stored()).map((m) => m.text)).toEqual([deltas.join("")]);
  expect(await c.parts()).toEqual([]);
});

test("a new message, a tool call or the step's end ends the message under way: its parts fold", async () => {
  const c = await chat();
  await c.emit({ type: "text", delta: "One ", newMessage: true });
  await c.emit({ type: "text", delta: "reply." });
  await c.emit({ type: "text", delta: "Two ", newMessage: true });
  await c.emit({ type: "text", delta: "replies." });
  // The first ended with the second's start; the second streams on.
  expect((await c.stored()).map((m) => m.text)).toEqual(["One reply.", "Two "]);
  await c.emit({ type: "tool", name: "Read", status: "started" });
  expect((await c.stored()).map((m) => m.text)).toEqual(["One reply.", "Two replies."]);
  await c.emit({ type: "text", delta: "Three ", newMessage: true });
  await c.emit({ type: "text", delta: "stopped." });
  await c.first.stopRun(c.runId);
  expect((await c.stored()).map((m) => m.text)).toEqual(["One reply.", "Two replies.", "Three stopped."]);
  expect(await c.parts()).toEqual([]);
  // Nor does the engine keep the stopped step's text.
  expect((c.first as unknown as { streamed: Map<string, unknown> }).streamed.size).toBe(0);
});

test("a reader on another engine sees a streaming message whole: snapshot, Job transcript and re-read", async () => {
  const c = await chat();
  const deltas = words(5);
  for (const [i, delta] of deltas.entries()) await c.emit({ type: "text", delta, ...(i === 0 ? { newMessage: true as const } : {}) });
  const whole = deltas.join("");
  // The context's own engine applied none of these events: it reads them as another process would.
  const { context } = c;
  const run = await call(router.runs.get, { runId: c.runId }, { context });
  expect(run.messages.filter((m) => m.role === "assistant").map((m) => m.text)).toEqual([whole]);
  const job = await call(router.jobs.get, { id: c.runId }, { context });
  expect(job.messages.filter((m) => m.role === "assistant").map((m) => m.text)).toEqual([whole]);
  const abort = new AbortController();
  const stream = await call(router.runs.stream, { runId: c.runId }, { context, signal: abort.signal });
  onTestFinished(async () => {
    abort.abort();
    await stream.return?.(undefined);
  });
  expect((await stream.next()).value).toMatchObject({ type: "snapshot" });
  const [row] = await c.stored();
  context.engine.events.publish(c.runId, { type: "changed", rows: [{ kind: "message", id: row!.id }] });
  expect((await stream.next()).value).toMatchObject({ type: "message", message: { id: row!.id, text: whole } });
});

test("after a crash between events, another engine goes on from the stored text: nothing is lost or doubled", async () => {
  const c = await chat();
  const before = words(6);
  for (const [i, delta] of before.entries()) await c.emit({ type: "text", delta, ...(i === 0 ? { newMessage: true as const } : {}) });
  await c.first.stop();
  const next = c.engine();
  const live: RunEvent[] = [];
  onTestFinished(next.events.subscribe(c.runId, (e) => live.push(e)));
  const after = words(4, 6);
  for (const delta of after) await c.emitTo(next, { type: "text", delta });
  // Its first event read the text back once; each live event carries the whole of it.
  expect(live.flatMap((e) => (e.type === "message" ? [e.message.text] : []))).toEqual(after.map((_, i) => [...before, ...after.slice(0, i + 1)].join("")));
  await c.emitTo(next, { type: "turn-end", turnId: "first" });
  expect((await c.stored()).map((m) => m.text)).toEqual([[...before, ...after].join("")]);
  expect(await c.parts()).toEqual([]);
});

test("an engine whose copy is stale reads the text again: another engine streamed into the message meanwhile", async () => {
  const c = await chat();
  await c.emit({ type: "text", delta: "a", newMessage: true });
  await c.emit({ type: "text", delta: "b" });
  const other = c.engine();
  await c.emitTo(other, { type: "text", delta: "c" });
  await c.emit({ type: "text", delta: "d" });
  expect(c.lastLive()).toMatchObject({ text: "abcd" });
});

test("a turn end or a stop racing the last delta loses nothing: what was stored is what was shown, and no part is left", async () => {
  for (const end of ["turn-end", "stop"] as const) {
    const c = await chat();
    const deltas = words(10);
    for (const [i, delta] of deltas.slice(0, -1).entries()) await c.emit({ type: "text", delta, ...(i === 0 ? { newMessage: true as const } : {}) });
    await Promise.all([
      c.emit({ type: "text", delta: deltas.at(-1)! }),
      end === "turn-end" ? c.emit({ type: "turn-end", turnId: "first" }) : c.first.stopRun(c.runId),
    ]);
    const [row] = await c.stored();
    // The delta went in before the end, or came after it and was refused (an older seq, or a closed step).
    expect([deltas.join(""), deltas.slice(0, -1).join("")]).toContain(row!.text);
    expect(c.lastLive()?.text).toBe(row!.text);
    expect(await c.parts()).toEqual([]);
  }
});

test("the fold runs once: a replayed or later event, or two folds at once, never add the parts twice", async () => {
  const c = await chat();
  await c.emit({ type: "text", delta: "Once ", newMessage: true });
  await c.emit({ type: "text", delta: "only." });
  const folds = await Promise.all([0, 1].map(() => c.context.db.transaction((tx) => foldParts(tx, c.stepId))));
  expect(folds.flat()).toHaveLength(1);
  await c.emit({ type: "turn-end", turnId: "first" });
  // The runner sends it again (its ack was lost): the replay changes nothing.
  await c.emitTo(c.first, { type: "turn-end", turnId: "first" }, c.lastSeq());
  await c.emit({ type: "turn-start", turnId: "second", interruptible: false });
  expect((await c.stored()).map((m) => m.text)).toEqual(["Once only."]);
  expect(await c.parts()).toEqual([]);
});
