import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, onTestFinished, test } from "vitest";
import type { QuestionPayload } from "@dispand/runner-protocol";
import { chatQueue, messages, organizationMembers, questions, runs, stepRuns, user } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";
import type { WorkflowDef } from "./model.ts";

type Context = Awaited<ReturnType<typeof ownerContext>>;

const def: WorkflowDef = { trigger: { type: "manual", field: { type: "button", id: "start", key: "start", label: "Start" } }, steps: [], edges: [] };
const payload: QuestionPayload = { kind: "choice", questions: [{ question: "Which?", header: "Pick", options: [{ label: "A" }], multiSelect: false }] };

/** A running Job of `ownerId` in the context's workspace, with a step, a message, a question and a queued message: `<id>.step`… */
async function job(context: Context, id: string, ownerId = context.ownerId) {
  const { db, workspaceId } = context;
  await db.insert(runs).values({ id, workspaceId, ownerId, source: "agent", version: 0, status: "running", def });
  await db.insert(stepRuns).values({ id: `${id}.step`, runId: id, nodeId: "node", status: "running" });
  await db.insert(messages).values({ id: `${id}.message`, runId: id, stepRunId: `${id}.step`, role: "assistant", text: "Hel" });
  await db.insert(questions).values({ id: `${id}.question`, runId: id, stepRunId: `${id}.step`, placement: "chat", payload, status: "pending" });
  await db.insert(chatQueue).values({ id: `${id}.queued`, ownerId, runId: id, stepRunId: `${id}.step`, text: "Next" });
}

/** The run's stream, read past its snapshot; closed when the test ends. */
async function open(context: Context, runId: string) {
  const abort = new AbortController();
  const stream = await call(router.runs.stream, { runId }, { context, signal: abort.signal });
  onTestFinished(async () => {
    abort.abort();
    await stream.return?.(undefined);
  });
  expect((await stream.next()).value).toMatchObject({ type: "snapshot", run: { id: runId } });
  return stream;
}

test("runs.stream: a changed event yields the named rows as they are now", async () => {
  const context = await ownerContext();
  const { db } = context;
  await job(context, "job");
  const stream = await open(context, "job");
  await db.update(stepRuns).set({ status: "waiting" }).where(eq(stepRuns.id, "job.step"));
  await db.update(messages).set({ text: "Hello" }).where(eq(messages.id, "job.message"));
  await db.update(chatQueue).set({ text: "Edited" }).where(eq(chatQueue.id, "job.queued"));
  // Each as a read of the run shows it now.
  const now = await call(router.runs.get, { runId: "job" }, { context });
  context.engine.events.publish("job", {
    type: "changed",
    rows: [
      { kind: "step", id: "job.step" },
      { kind: "message", id: "job.message" },
      { kind: "question", id: "job.question" },
      { kind: "queued", id: "job.queued" },
      { kind: "run", id: "job" },
    ],
  });
  expect((await stream.next()).value).toEqual({ type: "step", step: now.steps[0] });
  expect((await stream.next()).value).toEqual({ type: "message", message: now.messages[0] });
  expect((await stream.next()).value).toEqual({ type: "question", question: now.questions[0] });
  expect((await stream.next()).value).toEqual({ type: "queued", queued: now.queue[0] });
  expect((await stream.next()).value).toEqual({ type: "run", run: now.run });
  expect(now.messages[0]).toMatchObject({ text: "Hello" });
});

test("runs.stream: a changed event naming another run's row or a row the reader can't see yields nothing", async () => {
  const context = await ownerContext();
  const { db, organizationId } = context;
  await db.insert(user).values({ id: "author", name: "Author", email: "author@example.com" });
  await db.insert(organizationMembers).values({ organizationId, userId: "author", role: "member" });
  // The reader, the organization's owner, reads the author's Job, but not the messages the author queued.
  await job(context, "job", "author");
  await job(context, "other");
  const stream = await open(context, "job");
  context.engine.events.publish("job", {
    type: "changed",
    rows: [
      { kind: "run", id: "other" },
      { kind: "step", id: "other.step" },
      { kind: "message", id: "other.message" },
      { kind: "question", id: "other.question" },
      { kind: "queued", id: "other.queued" },
      { kind: "queued", id: "job.queued" },
    ],
  });
  // What comes next is the next event's.
  context.engine.events.publish("job", { type: "changed", rows: [{ kind: "message", id: "job.message" }] });
  expect((await stream.next()).value).toMatchObject({ type: "message", message: { id: "job.message" } });
});

test("runs.stream: a changed event for a deleted row takes a snapshot", async () => {
  const context = await ownerContext();
  await job(context, "job");
  const stream = await open(context, "job");
  await context.db.delete(messages).where(eq(messages.id, "job.message"));
  context.engine.events.publish("job", { type: "changed", rows: [{ kind: "step", id: "job.step" }, { kind: "message", id: "job.message" }] });
  expect((await stream.next()).value).toMatchObject({ type: "snapshot", run: { id: "job" }, steps: [{ id: "job.step" }], messages: [] });
});

test("runs.stream: each row a changed event names is checked as it goes out", async () => {
  const context = await ownerContext();
  await job(context, "job");
  const stream = await open(context, "job");
  context.engine.events.publish("job", { type: "changed", rows: [{ kind: "step", id: "job.step" }, { kind: "message", id: "job.message" }] });
  expect((await stream.next()).value).toMatchObject({ type: "step", step: { id: "job.step" } });
  // The reader leaves the organization before reading the next row: it doesn't come.
  await context.db.delete(organizationMembers).where(eq(organizationMembers.userId, context.ownerId));
  await expect(stream.next()).rejects.toMatchObject({ code: "NOT_FOUND" });
});
