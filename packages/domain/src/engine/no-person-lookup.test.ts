import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { isTable } from "drizzle-orm";
import ts from "typescript";
import { expect, test } from "vitest";
import * as schema from "../db/schema.ts";
import { match, optional, owner, parse, shape, statement, statementOf, type Step, where } from "../test-support-source.ts";

// A run's data is its workspace's, whoever started the run: a member's Job never finds a row by
// the run's person (`run.ownerId`), or it would see the person's rows of another workspace and
// miss the other members' rows of its own. Every read of a run's person, and every join that
// matches two rows by their person, is listed here and says why it stays:
// - identity: who the run acts as (its scope, its token, what an audit row names, the sender of
//   its chat messages and their held files);
// - copy: the person written on a row the run makes, never read back to find rows;
// - caller: a procedure called for the Job runs as its person (`signedIn`) until procedures take
//   the workspace instead;
// A new site fails until it is listed, so whoever adds it decides. The sources are read as code
// (`test-support-source.ts`), not lines: what the former line regexes matched is found as runs of
// tokens, whatever the formatting, and each site is its whole statement, compared by shape.

const SRC = join(import.meta.dirname, "..");
const TABLES = Object.values(schema).flatMap((t) => (isTable(t) ? [Object.keys(schema).find((k) => schema[k as keyof typeof schema] === t)!] : []));
/** A name as the former regex's word took it: `\b` lets `#run` and `$run` in, and `rerun` out. */
const word = (re: RegExp) => (token: ts.Node) => (ts.isIdentifier(token) || ts.isPrivateIdentifier(token)) && re.test(token.text);
/** `ownerId` read off a holder the regex names: `run.ownerId`, `run!.ownerId`, `run?.ownerId`, `context.job.ownerId`. */
const ownerOf = (holder: RegExp): Step[] => [word(holder), optional("!"), [".", "?."], word(/^ownerId\b/)];
// The person of a run or a Job, or of a row copied from it, read off the object that holds it.
const READ = ownerOf(/\b(?:run|job|runRow)$/);
const COPIED = ownerOf(/\b(?:step|q|chat|asking|row)$/);
// Two rows matched by their person: `eq(agents.ownerId, runs.ownerId)` (`neq(` too), with the trailing comma formatting adds.
const TABLE = (token: ts.Node) => TABLES.includes(token.getText());
const JOIN: Step[] = [word(/eq$/), "(", (t) => /^\w+$/.test(t.getText()), ".", "ownerId", ",", TABLE, ".", "ownerId", optional(","), ")"];
// Where the copied rows (steps, questions, chat steps) are run code.
const RUN_CODE = /^(?:engine|platform|cloud|jobs|memory|skills)\//;

/** The reads and joins in `source` (of `file`), as the former regexes matched them: each its first token. */
function candidates(file: string, source: ts.SourceFile): ts.Node[] {
  return [...match(source, READ), ...match(source, JOIN), ...(RUN_CODE.test(file) ? match(source, COPIED) : [])].map(([first]) => first!);
}

type Kind = "identity" | "copy" | "caller";
/** [file, the function its statement is in (`owner`'s path), the statement, how many such statements there, why it stays]. */
const ALLOWED: [string, string, string, number, Kind][] = [
  ["platform/token.ts", "jobOfToken", "if (!run?.agentId || !run.tokenHash || !run.ownerId) return null;", 1, "identity"],
  [
    "platform/cloud.ts",
    "jobOfSession",
    "return row?.agentId && row.ownerId ? { runId: row.runId, ownerId: row.ownerId, workspaceId: row.workspaceId, agentId: row.agentId } : null;",
    1,
    "identity",
  ],
  [
    "engine/tooling.ts",
    "sessionTooling",
    "return { ...tooling, jobId: run.id, jobOwnerId: run.ownerId, ...(filesOwnerId ? { filesOwnerId } : {}) };",
    1,
    "copy",
  ],
  [
    "engine/tooling.ts",
    "sessionTooling",
    'const filesOwnerId = run.ownerId ?? (await db.select({ ownerId: agents.ownerId }).from(agents).where(eq(agents.id, agentId)))[0]?.ownerId ?? (await db.select({ userId: organizationMembers.userId }).from(organizationMembers).innerJoin(workspaces, eq(workspaces.organizationId, organizationMembers.organizationId)).where(and(eq(workspaces.id, run.workspaceId), eq(organizationMembers.role, "owner"))))[0]?.userId;',
    1,
    "copy",
  ],
  [
    "engine/step-lifecycle.ts",
    "reopen",
    'if (job) await recordAudit(tx, { ownerId: run.ownerId, actor: run.ownerId ? { type: "user", userId: run.ownerId } : { type: "job", runId: run.id }, agentId: run.agentId, jobId: run.id, action: "job.reopened", resource: { type: "job", id: run.id } });',
    1,
    "identity",
  ],
  [
    "engine/addressee.ts",
    "addresseeOf",
    "if (run.ownerId && (await authorize(db, run.ownerId, run.organizationId, run.workspaceId))) return run.ownerId;",
    1,
    "identity",
  ],
  ["engine/addressee.ts", "addresseeOf", 'if (run.builtIn === "assistant" && run.ownerId) return run.ownerId;', 1, "identity"],
  [
    "memory/tools.ts",
    "writeMemoryTool",
    'const done = typeof where === "string" ? await refuseWrite(input.scope, mode, where) : await writeMemory(app.db, job.ownerId, job.workspaceId, where, entry, authorOf(job, rights), mode);',
    1,
    "identity",
  ],
  [
    "memory/tools.ts",
    "removeMemoryTool",
    "if (await removeMemory(app.db, job.ownerId, job.workspaceId, where, input.path, authorOf(job, rights))) return { ok: true, output: { path: input.path, removed: true } };",
    1,
    "identity",
  ],
  // Another person's Assistant memory stays theirs: the Job's person is who may read it.
  [
    "memory/tools.ts",
    "read",
    "const [other] = await app.db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, agentId), eq(agents.workspaceId, job.workspaceId), or(isNull(agents.builtIn), eq(agents.ownerId, job.ownerId))));",
    1,
    "caller",
  ],
  [
    "platform/proposals.ts",
    "recordInPlugin",
    'await tx.insert(plugins).values({ id: newId("plugin"), ownerId: row.ownerId, workspaceId: row.workspaceId, name, description: `What approved proposals created for ${row.plugin}`, source: "generated", components: { skills: [], mcpServers: [], agents: [] } }).onConflictDoNothing();',
    1,
    "copy",
  ],
  [
    "engine/engine.ts",
    "Engine.runData",
    'const ran = await runDataStep(tx, { ownerId: run.ownerId, workspaceId: run.workspaceId, step: node, values, actor: { type: "step", runId: run.id, stepId: step.id } });',
    1,
    "copy",
  ],
  // A person downloading a Job's file: only a file of the Job's own person (a tool's raw result stays theirs).
  [
    "data/files.ts",
    "readAttachment",
    "const [row] = await db.select({ file: attachments }).from(attachments).leftJoin(runs, and(eq(runs.id, attachments.jobId), eq(runs.ownerId, attachments.ownerId))).where(and(eq(attachments.id, id), or(isNotNull(attachments.tableId), and(eq(attachments.ownerId, userId), isNull(attachments.jobId)), and(isNull(attachments.tableId), readableRun({ db, ownerId: userId }), or(eq(attachments.ownerId, userId), inUserMessage)))));",
    1,
    "caller",
  ],
  [
    "platform/tools.ts",
    "PLUGIN_DECIDE.run",
    "const context = { ...app, job, actorId: job.ownerId, access: { workspaceId: job.workspaceId }, headers: new Headers(), resHeaders: new Headers() };",
    1,
    "caller",
  ],
  ["rpc/context.ts", "identify", 'annotate({ "dispand.owner.id": context.job.ownerId, "dispand.job.id": context.job.runId });', 1, "caller"],
  ["rpc/context.ts", "identify", "return { ownerId: context.job.ownerId, jobPlace: placed };", 1, "caller"],
  [
    "audit/tool-call.ts",
    "recordToolCall",
    'return recordAuditAfter(db, { workspaceId: tool.workspaceId, ownerId: job.ownerId, actor: { type: "job", runId: job.runId }, ...(job.agentId !== undefined ? { agentId: job.agentId } : {}), jobId: job.runId, action: "tool.call", resource: { type: "tool", id: tool.id }, result, details: { toolId: tool.id, toolName: tool.name, action, ...(reason ? { reason } : {}) } });',
    1,
    "identity",
  ],
  // The Audit row of a poll item a failed Job hands back names the Job's person, as the Job's own rows do.
  [
    "engine/poll-retry.ts",
    "retryPollItem",
    'await recordAudit(tx, { workspaceId: run.workspaceId, ownerId: run.ownerId, actor: { type: "job", runId: run.id }, jobId: run.id, action: "poll.itemRetried", resource: { type: "trigger", id: triggerId }, details: { triggerId, jobs: jobs!.n } });',
    1,
    "identity",
  ],
  [
    "engine/engine.ts",
    "consultEnded",
    'await recordAudit(tx, { ownerId: q.ownerId, actor: { type: "job", runId: by?.type === "agent" ? by.runId : q.runId }, jobId: q.runId, action: "consult.ended", resource: { type: "consult", id: q.id }, result: outcome === "answered" ? "ok" : outcome === "refused" ? "refused" : "failed", details: { ...(await consultedAgent(tx, q)), ...(q.consultRunId ? { consultedJobId: q.consultRunId } : {}), outcome } });',
    1,
    "identity",
  ],
  [
    "engine/engine.ts",
    "Engine.recordAsk",
    'await recordAudit(tx, { ownerId: q.ownerId, actor: { type: "job", runId: q.runId }, jobId: q.runId, action: "question.refused", resource: { type: "question", id: q.id }, result: "refused", details: { reason: "escalation_disabled" } });',
    1,
    "identity",
  ],
  [
    "engine/engine.ts",
    "Engine.openConsult",
    'runId = await this.createJob(tx, { ownerId: q.ownerId, agentId: consultedId, cause: { kind: "consult", questionId: q.id, jobId: q.runId, depth: (asker!.cause?.depth ?? 0) + 1 }, firing: { type: "consult", questionId: q.id, outputs: consultOutputs({ question: q.payload.question, askingAgent, askingJobId: q.runId }) }, rootId: asker!.rootId! });',
    1,
    "identity",
  ],
  // The run's person, read when a message (decision: assistant and tool messages keep it), a root or an audit row needs it; steps keep no copy.
  ["engine/engine.ts", "personOf", "return run?.ownerId ?? null;", 1, "identity"],
  [
    "artifacts/show.ts",
    "showArtifact",
    'const [message] = await tx.insert(messages).values({ id: newId("msg"), ownerId: job.ownerId, runId: job.runId, stepRunId: step!.id, role: "tool", text: "artifact_show", result }).returning();',
    1,
    "copy",
  ],
  [
    "engine/engine.ts",
    "Engine.chatInput",
    'await tx.update(runs).set({ rootId: await newRoot(tx, run!.ownerId, run!.workspaceId, "chat", runId) }).where(eq(runs.id, runId));',
    1,
    "copy",
  ],
  [
    "engine/engine.ts",
    "Engine.takeChatSlot",
    'if (job) await recordAudit(tx, { workspaceId: job.workspaceId, ownerId: job.ownerId, actor: { type: "job", runId: current.runId }, agentId: job.agentId, jobId: current.runId, resource: { type: "job", id: current.runId }, action: "job.queued", details: { harnessId: current.harnessId, harnessName: job.harnessName } });',
    1,
    "identity",
  ],
  [
    "engine/engine.ts",
    "Engine.interruptChat",
    'if (run.source === "agent") await recordAudit(tx, { workspaceId: run.workspaceId, ownerId: run.ownerId, actor: run.ownerId ? { type: "user", userId: run.ownerId } : { type: "job", runId }, agentId: run.agentId, jobId: runId, action: "job.turnInterrupt", resource: { type: "job", id: runId }, details: { status: outcome } });',
    1,
    "identity",
  ],
  [
    "engine/engine.ts",
    "Engine.recordAnswer",
    'const actor: Exclude<EventActor, { type: "step" }> = by?.type === "agent" ? { type: "job", runId: by.runId } : by?.type === "user" ? by : q.ownerId ? { type: "user", userId: q.ownerId } : { type: "job", runId: q.runId };',
    1,
    "identity",
  ],
  [
    "engine/engine.ts",
    "Engine.auditResume",
    'await recordAuditAfter(this.db, { workspaceId: run.workspaceId, ownerId: run.ownerId, actor: { type: "job", runId: step.runId }, agentId: run.agentId, jobId: step.runId, action: "job.started", resource: { type: "job", id: step.runId }, details: { status: "resumed", ...(harnessId ? { harnessId } : {}), ...(h ? { harnessName: h.name } : {}), ...(runnerId ? { runnerId } : {}), ...(runner ? { runnerName: runner.name } : {}) } });',
    1,
    "identity",
  ],
  [
    "engine/engine.ts",
    "Engine.turn",
    'if (run?.source === "agent") await recordAudit(tx, { workspaceId: run.workspaceId, ownerId: run.ownerId, actor: { type: "job", runId: step.runId }, agentId: run.agentId, jobId: step.runId, action: "job.turn", resource: { type: "job", id: step.runId }, details: { status } });',
    1,
    "identity",
  ],
  [
    "engine/engine.ts",
    "Engine.syncWaiting",
    'await recordAudit(tx, { workspaceId: run.workspaceId, ownerId: run.ownerId, actor: { type: "job", runId }, agentId: run.agentId, jobId: runId, action: "job.waiting", resource: { type: "job", id: runId }, details: asked ? { questionId: asked.id } : {} });',
    1,
    "identity",
  ],
  // Who a personal action acts for (its actor, `runners/grants.ts`), and its Audit rows.
  [
    "runners/grants.ts",
    "attendedActor",
    'return run.source === "agent" && run.cause?.kind === "user" && run.trigger.type === "manual" ? run.ownerId : null;',
    1,
    "identity",
  ],
  [
    "engine/engine.ts",
    "Engine.auditPersonal",
    'await recordAudit(tx, { workspaceId: run.workspaceId, ownerId: run.ownerId, actor: by ?? { type: "job", runId: run.id }, agentId: run.agentId, jobId: run.id, action, resource: questionId ? { type: "question", id: questionId } : { type: "job", id: run.id }, details });',
    1,
    "identity",
  ],
  [
    "engine/engine.ts",
    "Engine.recordAsk",
    'await recordAudit(tx, { ownerId: row.ownerId, actor: { type: "job", runId: row.runId }, jobId: row.runId, action: "consult.asked", resource: { type: "consult", id: row.id }, details: await consultedAgent(tx, row) });',
    1,
    "identity",
  ],
  [
    "engine/engine.ts",
    "Engine.finishRun",
    'await inJobTrace(row, () => recordAudit(tx, { workspaceId: row.workspaceId, ownerId: row.ownerId, actor: { type: "job", runId: row.id }, agentId: row.agentId, jobId: row.id, action: status === "succeeded" ? "job.finished" : "job.failed", resource: { type: "job", id: row.id }, result: status === "succeeded" ? "ok" : "failed", ...(status === "failed" ? { details: { reason: stop ?? (stoppedByHand({ error }) ? "stopped" : "failed") } } : {}) }));',
    1,
    "identity",
  ],
  [
    "engine/engine.ts",
    "Engine.openSession",
    'const life = { workspaceId: run.workspaceId, ownerId: run.ownerId, actor: { type: "job", runId: run.id }, agentId: run.agentId, jobId: run.id, resource: { type: "job", id: run.id } } as const;',
    1,
    "identity",
  ],
  [
    "platform/call.ts",
    "auditEntry",
    'return { ownerId: job.ownerId, actor: { type: "job", runId: job.runId }, agentId: job.agentId, jobId: job.runId, action: "platform.call", resource: tool ? auditResource(tool, input, ok ? seen.output : undefined) : { type: "workspace", id: null }, result: ok ? "ok" : seen.failed ? "failed" : "refused", details: { ...(tool ? { tool: tool.name } : {}), ...(seen.tableId ? { tableId: seen.tableId } : {}), ...(seen.taken ? { proposalId: seen.taken.proposalId, item: seen.taken.index } : {}), ...(seen.reason ? { reason: seen.reason } : {}), ...(ok ? seen.details : {}) } };',
    1,
    "identity",
  ],
  [
    "platform/token.ts",
    "jobOfToken",
    "const scope = { userId: run.ownerId, organizationId: run.organizationId, workspaceId: run.workspaceId };",
    1,
    "identity",
  ],
  [
    "platform/token.ts",
    "jobOfToken",
    "return { runId: run.id, ownerId: run.ownerId, workspaceId: run.workspaceId, agentId: run.agentId, scope, traceId: run.traceId, spanId: run.spanId };",
    1,
    "identity",
  ],
  [
    "workflows/procedures.ts",
    "snapshot",
    'const [steps, transcript, asked, queued] = await Promise.all([db.select().from(stepRuns).where(eq(stepRuns.runId, runId)), db.select().from(messages).where(eq(messages.runId, runId)).orderBy(asc(messages.position)), db.select().from(questions).where(eq(questions.runId, runId)).orderBy(asc(questions.createdAt)), ownerId !== run.ownerId ? [] : db.select().from(chatQueue).where(and(eq(chatQueue.runId, runId), inArray(chatQueue.state, ["pending", "failed"]))).orderBy(asc(chatQueue.position))]);',
    1,
    "identity",
  ],
  [
    "data/files.ts",
    "keepJobFiles",
    "return storeAttachments(tx, store, files.map((f) => ({ ownerId: job.ownerId, workspaceId, jobId: job.runId, name: f.name, bytes: f.bytes })));",
    1,
    "copy",
  ],
  [
    "engine/interactions.ts",
    "recordInteraction",
    'await tx.insert(events).values({ id: newId("evt"), ownerId: q.ownerId, workspaceId: asking!.workspaceId, tableId: INTERACTION, rowId: q.id, operation, changedFieldIds: [], before: {}, after: { kind: q.kind, runId: q.runId, agentId: asking?.agentId ?? null, stepRunId: q.stepRunId ?? null }, actor: by, rootId: asking?.rootId ?? null });',
    1,
    "copy",
  ],
  [
    "engine/interactions.ts",
    "recordInteraction",
    'await recordAudit(tx, { ownerId: q.ownerId, actor: by, jobId: q.runId, action: AUDITED[operation], resource: { type: "question", id: q.id }, details: { questionKind: q.kind, ...(operation === "answered" && q.answer ? { decision: decisionOf(q.answer), answeredBy: by.type === "user" ? "person" : "agent" } : {}), ...(operation === "created" && q.route && q.addresseeId ? { to: q.addresseeId, hop: q.route.hop, reason: q.route.reason.toLowerCase() } : {}) } });',
    1,
    "copy",
  ],
  [
    "engine/jobs-events.ts",
    "recordJobEvent",
    'await tx.insert(events).values({ id: newId("evt"), ownerId: run.ownerId, workspaceId: run.workspaceId, tableId: JOB, rowId: run.id, operation, changedFieldIds: [], before: {}, after: { agentId: run.agentId, triggerId: run.triggerId, causeKind: run.cause?.kind ?? null, status: run.status }, actor: { type: "job", runId: run.id }, rootId: run.rootId });',
    1,
    "copy",
  ],
  [
    "engine/step-lifecycle.ts",
    "reopen",
    'const [reopened] = await tx.update(runs).set({ status: "running", error: null, finishedAt: null, ...(job ? { rootId: await newRoot(tx, run.ownerId, run.workspaceId, "chat", run.id) } : {}), ...(token ? { tokenHash: token.hash, tokenSealed: token.sealed } : {}) }).where(and(eq(runs.id, run.id), eq(runs.status, run.status))).returning();',
    1,
    "copy",
  ],
  [
    "platform/proposals.ts",
    "createProposal",
    "await db.insert(proposals).values({ id, ownerId: job.ownerId, runId: job.runId, agentId: job.agentId, items, plugin: parsed.data.plugin ?? null });",
    1,
    "copy",
  ],
];

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(join(dir, e.name))
      : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.startsWith("test-support")
        ? [join(dir, e.name)]
        : [],
  );
}

test("the reads and joins are found as the former line regexes matched them, whatever the layout", () => {
  const found = (code: string, file = "engine/x.ts") => candidates(file, parse(file, code)).map((t) => t.getText());
  const cases: [string, string[]][] = [
    ["f(run.ownerId, run!.ownerId, run?.ownerId, run!?.ownerId)", ["run", "run", "run", "run"]],
    ["f(context.job.ownerId, this.#run.ownerId, $run.ownerId, runRow\n  // why\n  .ownerId)", ["job", "#run", "$run", "runRow"]],
    ["eq(\n  agents.ownerId,\n  runs.ownerId,\n)", ["eq"]],
    ["neq(this.ownerId, runs.ownerId)", ["neq"]],
    // A copied row's person counts in run code only.
    ["f(step.ownerId, q!.ownerId)", ["step", "q"]],
    // Another name, another field, a join with a table it doesn't know, text in a string or a comment: none.
    ["f(rerun.ownerId, run_.ownerId, run.ownerIds, run.owner, eq(agents.ownerId, job.id), eq(a.ownerId, other.ownerId))", []],
    ["f('run.ownerId', `job.ownerId`) // run.ownerId", []],
  ];
  expect(cases.map(([code]) => [code, found(code)])).toEqual(cases);
  expect(found("f(step.ownerId, q.ownerId)", "rpc/x.ts")).toEqual([]);
});

test("no code finds a run's rows by the run's person, but the listed sites", () => {
  expect(TABLES).toContain("runs");
  const listed = ALLOWED.map((entry) => ({ entry, shape: shape(statement(entry[2])) }));
  const unplaced: string[] = [];
  const unlisted: string[] = [];
  const seen = new Map<(typeof ALLOWED)[number], number>();
  for (const path of files(SRC)) {
    const text = readFileSync(path, "utf8");
    // The former regexes matched `ownerId` in a file's text: a file without it holds no site.
    if (!text.includes("ownerId")) continue;
    const file = relative(SRC, path).split(sep).join("/");
    const source = parse(file, text);
    // Each statement once per function it reads in, however many reads it holds.
    const sites = new Map<string, { token: ts.Node; site: ts.Node; fn: string | undefined }>();
    for (const token of candidates(file, source)) {
      const site = statementOf(token);
      const fn = owner(token)?.path;
      sites.set(`${site.pos} ${fn}`, { token, site, fn });
    }
    for (const { token, site, fn } of sites.values()) {
      if (!fn) {
        unplaced.push(where(token));
        continue;
      }
      const found = listed.find(({ entry: [f, path], shape: code }) => f === file && path === fn && code === shape(site));
      if (found) seen.set(found.entry, (seen.get(found.entry) ?? 0) + 1);
      else unlisted.push(`${file}#${fn} (${where(token)}): ${site.getText().replace(/\s+/g, " ")}`);
    }
  }
  // A read outside any declaration has no function to list it under.
  expect(unplaced).toEqual([]);
  expect(unlisted).toEqual([]);
  // A listed site that moved or went away is listed no more: the list stays what the code holds.
  expect(ALLOWED.filter((entry) => seen.get(entry) !== entry[3]).map(([f, fn, code]) => `${f}#${fn}: ${code}`)).toEqual([]);
});
