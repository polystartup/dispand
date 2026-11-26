import type { HarnessEvent } from "@dispand/runner-protocol";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { call } from "@orpc/server";
import { and, eq, isNotNull } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import { messages, stepRuns } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { ownerContext, runnerWithClis } from "../runners/test-support.ts";
import { Engine } from "./engine.ts";
import type { HarnessAdapter } from "./harness.ts";
import type { RunEvent } from "./views.ts";

async function claudeChat() {
  const context = await ownerContext();
  const { runnerId } = await runnerWithClis(context, "Runner");
  const harness = await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context });
  const agent = await call(router.agents.create, { name: "Assistant", harnessId: harness.id, systemPrompt: "" }, { context });
  const adapter: HarnessAdapter = {
    start: vi.fn<HarnessAdapter["start"]>().mockResolvedValue(true),
    send: vi.fn<HarnessAdapter["send"]>().mockResolvedValue(true),
    answer: vi.fn<HarnessAdapter["answer"]>().mockResolvedValue(true),
    stop: vi.fn<HarnessAdapter["stop"]>().mockResolvedValue(true),
  };
  const engine = new Engine(context.db, adapter, undefined, undefined, undefined, context.secrets);
  onTestFinished(() => engine.stop());
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Chat", instructions: "Help.", config: { kind: "manual", placement: "chat" } }, { context });
  const runId = await engine.startJob(trigger.id, context.ownerId);
  const step = async () => (await context.db.select().from(stepRuns).where(and(eq(stepRuns.runId, runId), isNotNull(stepRuns.sessionId))))[0]!;
  await vi.waitFor(async () => expect((await step()).startDeliveredAt).toBeTruthy());
  const { sessionId } = await step();
  let seq = 0;
  const emit = (event: HarnessEvent) => engine.onHarnessEvent(sessionId!, event, { runnerId, seq: ++seq });
  await emit({ type: "turn-start", turnId: "first", interruptible: false });
  await emit({ type: "text", delta: "Hello.", newMessage: true });
  await emit({ type: "turn-end", turnId: "first" });
  const transcript = async () => (await context.db.select().from(messages).where(eq(messages.runId, runId)).orderBy(messages.position)).map((m) => [m.role, m.text]);
  return { engine, runId, emit, transcript };
}

// #475: B reached the CLI while A's turn ran, so B's row is stored before A's reply starts; only the harness knows where B's reply begins.
test("each assistant message the harness reports gets its own row, also after a message taken mid-turn", async () => {
  const c = await claudeChat();
  await c.engine.sendChat(c.runId, "Tell a long story.");
  await c.engine.sendChat(c.runId, "Now reply PONG-B.");
  const seen: RunEvent[] = [];
  onTestFinished(c.engine.events.subscribe(c.runId, (e) => seen.push(e)));
  await c.emit({ type: "turn-start", turnId: "second", interruptible: false });
  await c.emit({ type: "text", delta: "Once upon", newMessage: true });
  await c.emit({ type: "text", delta: " a time. ENDA" });
  await c.emit({ type: "text", delta: "PONG-B", newMessage: true });
  await c.emit({ type: "turn-end", turnId: "second" });
  expect(await c.transcript()).toEqual([
    ["assistant", "Hello."],
    ["user", "Tell a long story."],
    ["user", "Now reply PONG-B."],
    ["assistant", "Once upon a time. ENDA"],
    ["assistant", "PONG-B"],
  ]);
  // The new row reaches the chat live, as its own message.
  const live = seen.flatMap((e) => (e.type === "message" ? [e.message] : []));
  expect(new Set(live.map((m) => m.id)).size).toBe(2);
  expect(live.at(-1)).toMatchObject({ role: "assistant", text: "PONG-B" });
});

test("deltas of one message still join its row", async () => {
  const c = await claudeChat();
  await c.engine.sendChat(c.runId, "Hi.");
  await c.emit({ type: "turn-start", turnId: "second", interruptible: false });
  await c.emit({ type: "text", delta: "One ", newMessage: true });
  await c.emit({ type: "text", delta: "reply." });
  await c.emit({ type: "turn-end", turnId: "second" });
  expect((await c.transcript()).at(-1)).toEqual(["assistant", "One reply."]);
});

// Appending to a stored row is where a reply glues onto the one before it: the only append is the
// `text` event's, and it honors the harness's message boundary. A new one fails here until it does too.
test("the only append to a message row's text honors newMessage", () => {
  const src = join(import.meta.dirname, "..");
  const appends = readdirSync(src, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .flatMap((f) => {
      const text = readFileSync(join(src, f), "utf8");
      return [...text.matchAll(/\$\{messages\.text\}\s*\|\|/g)].map((m) => ({ f, at: m.index, text }));
    });
  expect(appends.map((a) => a.f)).toEqual([join("engine", "engine.ts")]);
  const { text, at } = appends[0]!;
  expect(text.slice(text.lastIndexOf('case "text":', at), at)).toContain("!event.newMessage");
});
