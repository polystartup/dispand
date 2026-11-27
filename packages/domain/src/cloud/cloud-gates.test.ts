import { call } from "@orpc/server";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import ts from "typescript";
import { expect, onTestFinished, test, vi } from "vitest";
import { cloudSessions, stepRuns } from "../db/schema.ts";
import { CliHarnessAdapter } from "../engine/cli-harness.ts";
import { Engine } from "../engine/engine.ts";
import type { CloudHarness } from "../engine/harness.ts";
import type { CloudWork, PlaceGate } from "../engine/places.ts";
import { RoutingAdapter } from "../engine/routing-adapter.ts";
import type { CloudEvent } from "../messages/record-result.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";
import { match, named, optional, owner, parse, type Step } from "../test-support-source.ts";
import type { WorkflowDef } from "../workflows/model.ts";
import { fakeModel, say } from "./test-model.ts";
import { CloudRunner, noTools } from "./runner.ts";

// The cloud runner asks its gate at every entry and for each session its recovery finds: a refused
// entry writes nothing, and a refused interrupt, steer or stop is carried to the session's driver.

/** Refuses every cloud session (another process drives them all); carried calls answer as `carried` says. */
class ElsewhereGate implements PlaceGate {
  asked: CloudWork[] = [];
  carried: string[] = [];
  admits() {
    return true;
  }
  drives(work: CloudWork) {
    this.asked.push(work);
    return false;
  }
  carry = {
    interrupt: async (sessionId: string, turnId: string) => (this.carried.push(`interrupt ${sessionId} ${turnId}`), "requested" as const),
    steer: async (sessionId: string) => (this.carried.push(`steer ${sessionId}`), true),
    stop: async (sessionId: string) => (this.carried.push(`stop ${sessionId}`), true),
  };
}

const chat = (agentId: string): WorkflowDef => ({
  trigger: { type: "manual", field: { id: "n_chat", key: "brief", type: "chat", label: "Brief", agentId, prompt: "" } },
  steps: [],
  edges: [],
});

/** A cloud chat driven by this process's runner (`driver`), idle between turns, and its harness. */
async function drivenChat(model: ReturnType<typeof fakeModel>) {
  const context = await ownerContext();
  const harness = await call(
    router.harnesses.create,
    { type: "cloud", name: "API", kind: "openai-compatible", baseUrl: "https://llm.test/v1", model: "m", systemPrompt: "You work for Dispand." } as never,
    { context },
  );
  const agent = await call(router.agents.create, { name: "Writer", harnessId: harness.id, systemPrompt: "Be brief." }, { context });
  const workflow = await call(router.workflows.create, { name: "Ship" }, { context });
  await call(router.workflows.update, { id: workflow.id, name: "Ship", def: chat(agent.id) }, { context });
  const driver = new CloudRunner(context.db, context.secrets, { client: model.client, tools: noTools });
  const engine = new Engine(context.db, new RoutingAdapter(context.db, new CliHarnessAdapter(context.db, context.hub, context.secrets), driver), driver);
  onTestFinished(() => engine.stop());
  const events: CloudEvent[] = [];
  driver.onEvent(async (sessionId, event, seq) => {
    events.push(event);
    await engine.onCloudEvent(sessionId, event, seq);
  });
  const runId = await engine.startRun(workflow.id);
  await engine.idle();
  const [step] = await context.db.select().from(stepRuns).where(eq(stepRuns.runId, runId));
  const sessionId = step!.sessionId!;
  const session = async () => (await context.db.select().from(cloudSessions).where(eq(cloudSessions.id, sessionId)))[0]!;
  return { context, driver, events, sessionId, session, harness: step!.harness as CloudHarness };
}

test("a refused entry writes nothing and starts no loop", async () => {
  const model = fakeModel(say("Never"));
  const { context, sessionId, session, harness } = await drivenChat(model);
  const before = await session();
  const gate = new ElsewhereGate();
  const elsewhere = new CloudRunner(context.db, context.secrets, { client: model.client, tools: noTools, gate });
  onTestFinished(() => elsewhere.close());
  expect(await elsewhere.send(sessionId, "Hello")).toBe(false);
  expect(await elsewhere.answer(sessionId, "q_1", { kind: "confirm-outputs", confirmed: true })).toBe(false);
  expect(await elsewhere.start(harness, { ...before.start, prompt: "Again", resumeCliSessionId: sessionId })).toBe(false);
  elsewhere.resumeQueued(sessionId);
  await vi.waitFor(() => expect(gate.asked).toEqual(["send", "answer", "start", "resumeQueued"]));
  await elsewhere.close();
  expect(await session()).toEqual(before);
  expect(model.inputs).toEqual([]);
});

test("a refused interrupt returns the gate's answer", async () => {
  let release!: () => void;
  const model = fakeModel(() => new Promise((resolve) => (release = () => resolve({ text: "Done" }))));
  const { context, driver, sessionId, session } = await drivenChat(model);
  await driver.send(sessionId, "Work");
  await vi.waitFor(() => expect(model.inputs).toHaveLength(1));
  const running = await session();
  const gate = new ElsewhereGate();
  const elsewhere = new CloudRunner(context.db, context.secrets, { client: model.client, tools: noTools, gate });
  expect(await elsewhere.interrupt(sessionId, running.turnId!)).toBe("requested");
  expect(await elsewhere.steer(sessionId, running.turnId!, "msg_1", "Also", [])).toBe(true);
  expect(await elsewhere.stop(sessionId)).toBe(true);
  expect(gate.carried).toEqual([`interrupt ${sessionId} ${running.turnId}`, `steer ${sessionId}`, `stop ${sessionId}`]);
  // The driver's turn goes on: nothing here touched it.
  expect(await session()).toEqual(running);
  release();
  await vi.waitFor(async () => expect((await session()).status).toBe("idle"));
});

test("recovery run while a session is driven here leaves it live and unreplayed", async () => {
  let release!: () => void;
  const model = fakeModel(() => new Promise((resolve) => (release = () => resolve({ text: "Done" }))));
  const { driver, events, sessionId, session } = await drivenChat(model);
  await driver.send(sessionId, "Work");
  await vi.waitFor(() => expect(model.inputs).toHaveLength(1));
  const running = await session();
  const seen = events.length;
  expect(await driver.recover()).toEqual([sessionId]);
  expect(events).toHaveLength(seen);
  expect(await session()).toEqual(running);
  release();
  await vi.waitFor(async () => expect((await session()).status).toBe("idle"));
  expect(model.inputs).toHaveLength(1);
});

// Every public entry of `CloudRunner` asks the gate before anything else, or is listed as not a
// place's work; a new one fails until it is listed.
const ENTRIES: Record<string, "gated" | "local"> = {
  onEvent: "local",
  resumeQueued: "gated",
  start: "gated",
  stop: "gated",
  interrupt: "gated",
  send: "gated",
  steer: "gated",
  answer: "gated",
  recover: "gated",
  close: "local",
};

test("every cloud runner entry is classified, and a gated one asks first", () => {
  const source = parse(join(import.meta.dirname, "runner.ts"));
  const runner = source.statements.find((s) => ts.isClassDeclaration(s) && s.name?.text === "CloudRunner")!;
  // What the old line regex read from the class to the file's end: each method with its body, not
  // private and not inside a function, by its path (`CloudRunner.` left out: another class's `start` stays its own).
  const methods: ts.MethodDeclaration[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isMethodDeclaration(node) &&
      node.body &&
      owner(node)?.node === node &&
      !ts.isPrivateIdentifier(node.name) &&
      !ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)
    )
      methods.push(node);
    ts.forEachChild(node, visit);
  };
  source.statements.slice(source.statements.indexOf(runner)).forEach(visit);
  const name = (method: ts.MethodDeclaration) => owner(method)!.path.replace(/^CloudRunner\./, "");
  expect(methods.map(name).sort()).toEqual(Object.keys(ENTRIES).sort());
  for (const method of methods) {
    if (ENTRIES[name(method)] !== "gated") continue;
    // Where the method first has the old regexes' tokens (Infinity if it never does).
    const first = (pattern: Step[]) => Math.min(...match(method, pattern).map(([self]) => self!.getStart()));
    // Before it takes a session's lock, queues, writes, emits or kicks a loop (recovery reads its sessions first).
    const asks = first(["this", ".", "gate"]);
    expect(asks, `${name(method)} asks the gate before acting`).toBeLessThan(Infinity);
    expect(asks, `${name(method)} asks the gate before acting`).toBeLessThan(
      first(["this", optional("!"), [".", "?."], named("locked", "queue", "kick", "write", "emit", "deliver")]),
    );
  }
});
