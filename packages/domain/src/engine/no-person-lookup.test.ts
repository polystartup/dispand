import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isTable } from "drizzle-orm";
import { expect, test } from "vitest";
import * as schema from "../db/schema.ts";

// A run's data is its workspace's, whoever started the run: a member's Job never finds a row by
// the run's person (`run.ownerId`), or it would see the person's rows of another workspace and
// miss the other members' rows of its own. Every read of a run's person, and every join that
// matches two rows by their person, is listed here and says why it stays:
// - identity: who the run acts as (its scope, its token, what an audit row names, the sender of
//   its chat messages and their held files);
// - copy: the person written on a row the run makes, never read back to find rows;
// - caller: a procedure called for the Job runs as its person (`signedIn`) until procedures take
//   the workspace instead;
// A new site fails until it is listed, so whoever adds it decides.

const SRC = join(import.meta.dirname, "..");
const TABLES = Object.values(schema).flatMap((t) => (isTable(t) ? [Object.keys(schema).find((k) => schema[k as keyof typeof schema] === t)!] : []));
// The person of a run or a Job, or of a row copied from it, read off the object that holds it.
const READ = /\b(?:run|job|runRow)!?\??\.ownerId\b/;
const COPIED = /\b(?:step|q|chat|asking|row)!?\??\.ownerId\b/;
// Two rows matched by their person: `eq(agents.ownerId, runs.ownerId)`.
const JOIN = new RegExp(`eq\\(\\w+\\.ownerId, *(?:${TABLES.join("|")})\\.ownerId\\)`);
// Where the copied rows (steps, questions, chat steps) are run code.
const RUN_CODE = /^(?:engine|platform|cloud|jobs|memory|skills)\//;

type Kind = "identity" | "copy" | "caller";
/** [file, text the line starts with, how many such lines, why it stays]. */
const ALLOWED: [string, string, number, Kind][] = [
  ["platform/token.ts", "if (!run?.agentId || !run.tokenHash || !run.ownerId) return null;", 1, "identity"],
  ["platform/cloud.ts", "return row?.agentId && row.ownerId ? { runId: row.runId, ownerId: row.ownerId,", 1, "identity"],
  ["engine/tooling.ts", "return { ...tooling, jobId: run.id, jobOwnerId: run.ownerId,", 1, "copy"],
  ["engine/tooling.ts", "const filesOwnerId = run.ownerId ??", 1, "copy"],
  ["engine/step-lifecycle.ts", "if (job) await recordAudit(tx, { ownerId: run.ownerId, actor: run.ownerId ? { type: \"user\", userId: run.ownerId } : { type: \"job\", runId: run.id }", 1, "identity"],
  ["engine/engine.ts", "if (!run.ownerId) throw new Error(\"a workflow run has no creator\");", 1, "copy"],
  ["engine/addressee.ts", "if (run.ownerId) return run.ownerId;", 1, "identity"],
  ["memory/tools.ts", "const done = typeof where === \"string\" ? await refuseWrite(input.scope, mode, where) : await writeMemory(app.db, job.ownerId, job.workspaceId,", 1, "identity"],
  ["memory/tools.ts", "if (await removeMemory(app.db, job.ownerId, job.workspaceId, where, input.path, authorOf(job, rights)))", 1, "identity"],
  // Another person's Assistant memory stays theirs: the Job's person is who may read it.
  ["memory/tools.ts", ".where(and(eq(agents.id, agentId), eq(agents.workspaceId, job.workspaceId), or(isNull(agents.builtIn), eq(agents.ownerId, job.ownerId))));", 1, "caller"],
  ["platform/proposals.ts", ".values({ id: newId(\"plugin\"), ownerId: row.ownerId, workspaceId: row.workspaceId, name,", 1, "copy"],
  ["engine/engine.ts", "const ran = await runDataStep(tx, { ownerId: run.ownerId, workspaceId: run.workspaceId, step: node, values, actor: { type: \"step\", runId: ru", 1, "copy"],
  // A person downloading a Job's file: only a file of the Job's own person (a tool's raw result stays theirs).
  ["data/files.ts", ".leftJoin(runs, and(eq(runs.id, attachments.jobId), eq(runs.ownerId, attachments.ownerId)))", 1, "caller"],
  ["platform/call.ts", "const legacy = await hasLegacyWorkspaceAccess({ db, ownerId: job.ownerId, job });", 1, "caller"],
  ["platform/call.ts", "if (!WORKSPACE_SCOPED.has(tool.name) && !(await hasLegacyWorkspaceAccess({ db: app.db, ownerId: job.ownerId, j", 1, "caller"],
  ["platform/tools.ts", "const context = { ...app, job, actorId: job.ownerId, access: { workspaceId: job.workspaceId }, headers: new Headers(), resHeaders: new Headers() };", 1, "caller"],
  ["rpc/context.ts", "annotate({ \"dispand.owner.id\": context.job.ownerId, \"dispand.job.id\": context.job.runId });", 1, "caller"],
  ["rpc/context.ts", "return { ownerId: context.job.ownerId, jobPlace: placed };", 1, "caller"],
  ["audit/tool-call.ts", "ownerId: job.ownerId,", 1, "identity"],
  ["engine/engine.ts", "ownerId: q.ownerId,", 3, "identity"],
  // The run's person, read when a message (decision: assistant and tool messages keep it), a root or an audit row needs it; steps keep no copy.
  ["engine/engine.ts", "return run?.ownerId ?? null;", 1, "identity"],
  ["artifacts/show.ts", "const [message] = await tx.insert(messages).values({ id: newId(\"msg\"), ownerId: job.ownerId, runId: job.runId,", 1, "copy"],
  ["engine/engine.ts", "await tx.update(runs).set({ rootId: await newRoot(tx, run!.ownerId, run!.workspaceId, \"chat\", runId) })", 1, "copy"],
  ["engine/engine.ts", "if (job) await recordAudit(tx, { workspaceId: job.workspaceId, ownerId: job.ownerId, actor: { type: \"job\", runId: current.runId }", 1, "identity"],
  ["engine/engine.ts", "if (run.source === \"agent\") await recordAudit(tx, { workspaceId: run.workspaceId, ownerId: run.ownerId, actor:", 1, "identity"],
  ["engine/engine.ts", "const actor: Exclude<EventActor, { type: \"step\" }> = by?.type === \"agent\" ? { type: \"job\", runId: by.runId } :", 1, "identity"],
  ["engine/engine.ts", "ownerId: run.ownerId,", 3, "identity"],
  ["engine/engine.ts", "ownerId: row.ownerId,", 2, "identity"],
  ["engine/engine.ts", "const life = { workspaceId: run.workspaceId, ownerId: run.ownerId, actor: { type: \"job\", runId: run.id }, agen", 1, "identity"],
  ["platform/call.ts", "ownerId: job.ownerId,", 1, "identity"],
  ["platform/token.ts", "const scope = { userId: run.ownerId, organizationId: run.organizationId, workspaceId: run.workspaceId };", 1, "identity"],
  ["platform/token.ts", "return { runId: run.id, ownerId: run.ownerId, workspaceId: run.workspaceId, agentId: run.agentId, scope, traceId: run.traceId, spanId: run.s", 1, "identity"],
  ["workflows/procedures.ts", "ownerId !== run.ownerId ? [] : db.select().from(chatQueue).where(and(eq(chatQueue.runId, runId), inArray(chatQ", 1, "identity"],
  ["data/files.ts", "return storeAttachments(tx, filesDir, files.map((f) => ({ ownerId: job.ownerId, workspaceId, jobId: job.runId,", 1, "copy"],
  ["engine/interactions.ts", "ownerId: q.ownerId,", 2, "copy"],
  ["engine/jobs-events.ts", "ownerId: run.ownerId,", 1, "copy"],
  ["engine/step-lifecycle.ts", "const [reopened] = await tx.update(runs).set({ status: \"running\", error: null, finishedAt: null, ...(job ? { r", 1, "copy"],
  ["platform/proposals.ts", "await db.insert(proposals).values({ id, ownerId: job.ownerId, runId: job.runId, agentId: job.agentId, items, p", 1, "copy"],
];

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.startsWith("test-support") ? [join(dir, e.name)] : []));
}

test("no code finds a run's rows by the run's person, but the listed sites", () => {
  expect(TABLES).toContain("runs");
  const unlisted: string[] = [];
  const seen = new Map<(typeof ALLOWED)[number], number>();
  for (const path of files(SRC)) {
    const file = relative(SRC, path);
    for (const [i, line] of readFileSync(path, "utf8").split("\n").entries()) {
      if (/^\s*(\/\/|\*)/.test(line) || !(READ.test(line) || JOIN.test(line) || (RUN_CODE.test(file) && COPIED.test(line)))) continue;
      const entry = ALLOWED.find(([f, text]) => f === file && line.trim().startsWith(text));
      if (entry) seen.set(entry, (seen.get(entry) ?? 0) + 1);
      else unlisted.push(`${file}:${i + 1}: ${line.trim()}`);
    }
  }
  expect(unlisted).toEqual([]);
  // A listed site that moved or went away is listed no more: the list stays what the code holds.
  expect(ALLOWED.filter((entry) => seen.get(entry) !== entry[2]).map(([f, text]) => `${f}: ${text}`)).toEqual([]);
});
