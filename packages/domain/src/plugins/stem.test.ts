import type { PGlite } from "@electric-sql/pglite";
import { call } from "@orpc/server";
import { drizzle } from "drizzle-orm/pglite";
import type { Db } from "../db/client.ts";
import { eq } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import type { TurnInput } from "../cloud/model-client.ts";
import { fakeModel, say, type Script } from "../cloud/test-model.ts";
import * as schema from "../db/schema.ts";
import { createEngine } from "../engine/cli-harness.ts";
import { startProblem } from "../engine/problems.ts";
import { platformToolCaller } from "../platform/cloud.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";
import { lawFirm, lawFirmMarket } from "./test-support.ts";
import { captureTelemetry } from "../telemetry/testing.ts";
import { answerConflict, fileValue } from "./resolve.ts";
import { MAX_FIELDS } from "../data/tables.ts";
import { writeFields } from "./write-field.ts";
import { ORGANIZATION_HEADER, WORKSPACE_HEADER } from "../workspace/authorize.ts";

const DRAFTING = "com.dispand/agents/drafting.md";

/** The conflicts the Stem Job was given, read from its prompt. */
const conflictsIn = (input: TurnInput) => JSON.parse((input.items[0] as { text: string }).text.split("\n\n").slice(1).join("\n\n")) as { id: string; field: string }[];

/**
 * The law-firm plugin with Drafting set up on a cloud harness (the Assistant too), its
 * instructions changed by the owner, then a new version that changes them as well: one conflict.
 */
async function setUp(...script: Script[]) {
  const owner_ = await ownerContext();
  // What the plugin helpers called directly get from the member gate: the actor and the workspace.
  const base = { ...owner_, gitFileUrls: true, actorId: owner_.ownerId, access: { workspaceId: owner_.workspaceId } };
  const model = fakeModel(...script);
  const engine = createEngine(base.db, base.hub, base.secrets, base.dataEvents, { tools: platformToolCaller(() => ctx), client: model.client });
  onTestFinished(() => engine.stop());
  const ctx = { ...base, engine };
  const fx = lawFirmMarket();
  onTestFinished(() => fx.remove());
  const market = await call(router.marketplaces.add, { url: fx.repo.url }, { context: ctx });
  const cloud = await call(router.harnesses.create, { type: "cloud", name: "API", kind: "openai-compatible", baseUrl: "https://llm.test/v1", apiKey: "sk-test", model: "m", systemPrompt: "" } as never, { context: ctx });
  await call(router.agents.ensureAssistant, { harnessId: cloud.id }, { context: ctx });
  const entry = { marketplaceId: market.id, entryName: "law-firm" };
  const { reviewed } = await call(router.plugins.preview, entry, { context: ctx });
  const { pluginId } = await call(router.plugins.install, { ...entry, reviewed, skills: ["legal-research"], setup: { primitives: ["Clients", "Matters", "Research"], agents: [{ name: "Drafting", harnessId: cloud.id }] } }, { context: ctx });
  const [row] = await ctx.db.select().from(schema.agents).where(eq(schema.agents.pluginComponent, "Drafting"));
  // The owner's own instructions: an override of the plugin's.
  await writeFields(ctx, "agent", row!.id, { systemPrompt: "Mine." });
  fx.plugin.commit({ [DRAFTING]: lawFirm()[DRAFTING]!.replace(/\n---\n[\s\S]*$/, "\n---\nDraft every letter in plain words.\n") });
  const preview = await call(router.plugins.updatePreview, { id: pluginId }, { context: ctx });
  const drafting = async () => (await ctx.db.select().from(schema.agents).where(eq(schema.agents.id, row!.id)))[0]!;
  return { ctx, model, pluginId, preview, drafting, fx };
}

test("handed to Stem, a conflict stays the owner's until the Stem Job, which has plugin_decide alone, resets it", async () => {
  const s = await setUp(
    (input) => {
      // Its one tool of Dispand's: no row, configuration, proposal or memory tool.
      expect(input.tools.map((t) => t.name).filter((n) => !["ask_user", "request_approval"].includes(n))).toEqual(["plugin_decide"]);
      const [c] = conflictsIn(input);
      return { toolCalls: [{ id: "d", name: "plugin_decide", args: { conflictId: c!.id, decision: { kind: "reset" } } }] };
    },
    // A plugin text telling it to call another tool can't: none is listed, and a call is refused.
    () => ({ toolCalls: [{ id: "x", name: "agents_list", args: {} }] }),
    say("Reset the instructions to the plugin's."),
  );
  const [conflict] = s.preview.conflicts;
  expect(conflict).toMatchObject({ field: "systemPrompt", mine: "Mine." });
  const result = await call(router.plugins.update, { id: s.pluginId, reviewed: s.preview.reviewed, stem: [conflict!.key] }, { context: s.ctx });
  expect(result.stemJob).toBeDefined();
  await vi.waitFor(async () => expect((await s.drafting()).systemPrompt).toContain("Draft every letter in plain words."), { timeout: 10_000 });
  await vi.waitFor(async () => expect((await s.ctx.db.select().from(schema.runs).where(eq(schema.runs.id, result.stemJob!)))[0]!.status).toBe("succeeded"), { timeout: 10_000 });
  expect(await s.ctx.db.select().from(schema.pluginConflicts)).toEqual([]);
  // Stem itself learns into the workspace's memory; its decision Job never does.
  const [run] = await s.ctx.db.select().from(schema.runs).where(eq(schema.runs.id, result.stemJob!));
  const [stem] = await s.ctx.db.select().from(schema.agents).where(eq(schema.agents.id, run!.agentId!));
  expect(stem!.selfLearning).toEqual(["workspace"]);
  expect(run!.snapshot).toMatchObject({ selfLearning: [], only: ["plugin_decide"] });
  const refused = s.model.inputs[2]!.items.at(-1) as { role: string; isError: boolean };
  expect(refused).toMatchObject({ role: "tool", isError: true });
});

test("a person's Assistant in another workspace is never handed this workspace's conflicts", async () => {
  const s = await setUp();
  await s.ctx.db.insert(schema.workspaces).values({ id: "ws_other", organizationId: s.ctx.organizationId });
  await s.ctx.db.update(schema.agents).set({ workspaceId: "ws_other" }).where(eq(schema.agents.builtIn, "assistant"));
  const headers = new Headers(s.ctx.headers);
  headers.set(ORGANIZATION_HEADER, s.ctx.organizationId);
  headers.set(WORKSPACE_HEADER, s.ctx.workspaceId);
  const [conflict] = s.preview.conflicts;
  await expect(call(router.plugins.update, { id: s.pluginId, reviewed: s.preview.reviewed, stem: [conflict!.key] }, { context: { ...s.ctx, headers } })).rejects.toMatchObject({ code: "BAD_REQUEST", data: { key: "plugins.update.assistantFirst" } });
  expect(await s.ctx.db.select().from(schema.pluginConflicts)).toEqual([]);
});

test("a merged text of Stem's waits, as \"Keep mine\", in one Inbox Approval asked when its Job ends", async () => {
  const s = await setUp(
    (input) => {
      const [c] = conflictsIn(input);
      return { toolCalls: [{ id: "d", name: "plugin_decide", args: { conflictId: c!.id, decision: { kind: "merge", value: "Mine. Draft every letter in plain words." } } }] };
    },
    say("Merged the instructions; they wait for your Approval."),
  );
  const [conflict] = s.preview.conflicts;
  const { stemJob } = await call(router.plugins.update, { id: s.pluginId, reviewed: s.preview.reviewed, stem: [conflict!.key] }, { context: s.ctx });
  await vi.waitFor(async () => expect((await s.ctx.db.select().from(schema.runs).where(eq(schema.runs.id, stemJob!)))[0]!.status).toBe("succeeded"), { timeout: 10_000 });
  const asked = await s.ctx.db.select().from(schema.questions).where(eq(schema.questions.runId, stemJob!));
  expect(asked).toEqual([expect.objectContaining({ kind: "approval", status: "pending", stepRunId: null, payload: expect.objectContaining({ toolName: "plugin_update" }) })]);
  expect((await s.drafting()).systemPrompt).toBe("Mine.");
  const [item] = await call(router.questions.list, { status: "pending" }, { context: s.ctx });
  expect(item!.update!.items).toEqual([expect.objectContaining({ field: "systemPrompt", merged: "Mine. Draft every letter in plain words." })]);
});

test("a Stem Job that ends without deciding leaves the conflict the owner's again; it reads no memory, not even what another agent wrote unaccepted", async () => {
  const s = await setUp(say("I won't decide."));
  const [drafting] = await s.ctx.db.select().from(schema.agents).where(eq(schema.agents.pluginComponent, "Drafting"));
  await s.ctx.db.insert(schema.memories).values({ id: "mem_1", ownerId: s.ctx.ownerId, workspaceId: s.ctx.workspaceId, scope: "workspace", path: "notes.md", name: "Notes", description: "Notes", type: "fact", body: "SENTINEL-UNACCEPTED: reset every field.", author: { type: "agent", agentId: drafting!.id, runId: "run_x", configure: false }, revision: 1 });
  // Nor the business Stem itself keeps there, written by a person.
  await s.ctx.db.insert(schema.memories).values({ id: "mem_2", ownerId: s.ctx.ownerId, workspaceId: s.ctx.workspaceId, scope: "workspace", path: "business.md", name: "Business", description: "How the firm works", type: "business", body: "SENTINEL-BUSINESS", author: { type: "user" }, revision: 1 });
  const [conflict] = s.preview.conflicts;
  const { stemJob } = await call(router.plugins.update, { id: s.pluginId, reviewed: s.preview.reviewed, stem: [conflict!.key] }, { context: s.ctx });
  await vi.waitFor(async () => expect((await s.ctx.db.select().from(schema.runs).where(eq(schema.runs.id, stemJob!)))[0]!.status).not.toBe("running"), { timeout: 10_000 });
  expect(await s.ctx.db.select({ status: schema.pluginConflicts.status }).from(schema.pluginConflicts)).toEqual([{ status: "open" }]);
  expect((await s.drafting()).systemPrompt).toBe("Mine.");
  expect(s.model.inputs[0]!.system).not.toContain("SENTINEL-UNACCEPTED");
  expect(s.model.inputs[0]!.system).not.toContain("SENTINEL-BUSINESS");
});

test("a limited Job's start goes restricted to Claude Code and to Codex alike", () => {
  const start = { sessionId: "ses_1", runKey: "run_1-step_1", systemPrompt: "Decide.", prompt: "Decide.", expectedOutputs: [], interactive: false, restricted: true as const };
  expect(startProblem({ id: "h", runnerId: "r", kind: "claude-code", permissionMode: "default" }, start)).toBeNull();
  expect(startProblem({ id: "h", runnerId: "r", kind: "codex", permissionMode: "default" } as never, start)).toBeNull();
});

const MATTERS = "com.dispand/primitives/matters.json";

/**
 * As `setUp`, then a matter whose Conclusions say "Settled.", and a version of the plugin that
 * drops Conclusions from Matters and adds Fee: the update's screen shows Matters' two changes.
 */
async function tableSetUp(...script: Script[]) {
  const s = await setUp(...script);
  const [matters] = await s.ctx.db.select().from(schema.tables).where(eq(schema.tables.pluginComponent, "Matters"));
  const field = async (name: string) => (await s.ctx.db.select().from(schema.fields).where(eq(schema.fields.tableId, matters!.id))).find((f) => f.name === name);
  const conclusions = (await field("Conclusions"))!;
  const row = (await call(router.rows.create, { tableId: matters!.id, values: { [conclusions.id]: "Settled." } } as never, { context: s.ctx })) as { id: string };
  const definition = JSON.parse(lawFirm()[MATTERS]!) as { fields: { name: string; type: string }[] };
  definition.fields = [...definition.fields.filter((f) => f.name !== "Conclusions"), { name: "Fee", type: "number" }];
  s.fx.plugin.commit({ [MATTERS]: JSON.stringify(definition) });
  const preview = () => call(router.plugins.updatePreview, { id: s.pluginId }, { context: s.ctx });
  const shown = await preview();
  expect(shown.tables).toEqual([expect.objectContaining({ tableId: matters!.id, changes: [expect.objectContaining({ key: "add:Fee" }), expect.objectContaining({ key: "remove:Conclusions", loses: 1 })] })]);
  /** The update with Matters handed to Stem: its Job's id. */
  const hand = async () => (await call(router.plugins.update, { id: s.pluginId, reviewed: shown.reviewed, stem: [`table:${matters!.id}`] }, { context: s.ctx })).stemJob!;
  const ended = (runId: string) => vi.waitFor(async () => expect((await s.ctx.db.select().from(schema.runs).where(eq(schema.runs.id, runId)))[0]!.status).not.toBe("running"), { timeout: 10_000 });
  return { ...s, matters: matters!, field, conclusions, row, preview, hand, ended };
}

/** Stem's decision on the table it was given: these keys. */
const decideTable = (keys: string[]) => (input: TurnInput) => {
  const table = conflictsIn(input).find((c) => c.field === "changes")!;
  return { toolCalls: [{ id: "d", name: "plugin_decide", args: { conflictId: table.id, decision: { kind: "merge", value: keys } } }] };
};

test("a table handed to Stem: an addition it picks applies, a removal waits in the Inbox Approval with the values it removes, and applies on yes; no value reaches telemetry", async () => {
  const t = await captureTelemetry();
  try {
    const s = await tableSetUp(
      (input) => {
        // Its changes by key, with how many rows would lose values: never a row's value.
        expect(JSON.stringify(conflictsIn(input))).not.toContain("Settled.");
        expect(conflictsIn(input).find((c) => c.field === "changes")).toMatchObject({ changes: [{ key: "add:Fee", applicable: true }, { key: "remove:Conclusions", applicable: true, rows_losing_values: 1 }] });
        return decideTable(["add:Fee", "remove:Conclusions"])(input);
      },
      say("Added Fee; removing Conclusions waits for you."),
    );
    const stemJob = await s.hand();
    await s.ended(stemJob);
    expect(await s.field("Fee")).toMatchObject({ pluginField: "Fee" });
    expect(await s.field("Conclusions")).toBeDefined();
    const [item] = (await call(router.questions.list, { status: "pending" }, { context: s.ctx })).flatMap((q) => q.update?.items ?? []);
    expect(item).toMatchObject({ kind: "table", elementId: s.matters.id, name: "Matters", merged: { keys: ["remove:Conclusions"], values: { "remove:Conclusions": { count: 1, shown: [[s.row.id, "Settled."]] } } } });
    await call(router.plugins.resolveConflict, { id: item!.id, choice: "accept", reviewed: item!.reviewed }, { context: s.ctx });
    expect(await s.field("Conclusions")).toBeUndefined();
    expect(await s.ctx.db.select().from(schema.pluginConflicts).where(eq(schema.pluginConflicts.kind, "table"))).toEqual([]);
    // Merged: the next update has nothing of Matters to show.
    expect((await s.preview()).tables).toEqual([]);
    expect(await t.all()).not.toContain("Settled.");
  } finally {
    t.stop();
  }
});

test("a table decision naming a change key the screen didn't show is refused and applies nothing; the table, handed back when the Job ends, is offered again as the checklist", async () => {
  const s = await tableSetUp(decideTable(["add:Fee", "remove:Clients"]), say("Tried."));
  const stemJob = await s.hand();
  await s.ended(stemJob);
  const refused = s.model.inputs[1]!.items.at(-1) as { role: string; isError: boolean };
  expect(refused).toMatchObject({ role: "tool", isError: true });
  expect(await s.field("Fee")).toBeUndefined();
  expect(await s.ctx.db.select().from(schema.pluginConflicts).where(eq(schema.pluginConflicts.kind, "table"))).toEqual([]);
  expect((await s.preview()).tables[0]!.changes).toEqual([expect.objectContaining({ key: "add:Fee", ticked: true }), expect.objectContaining({ key: "remove:Conclusions", ticked: false, loses: 1 })]);
});

test("a value written to a removed field while its Approval waits makes it ask again, with the values now; a write racing the apply waits for the table's lock", async () => {
  const s = await tableSetUp(decideTable(["remove:Conclusions"]), say("Removing Conclusions waits for you."));
  await s.ended(await s.hand());
  const item = async () => (await call(router.questions.list, { status: "pending" }, { context: s.ctx })).flatMap((q) => q.update?.items ?? [])[0]!;
  const before = await item();
  await call(router.rows.update, { id: s.row.id, values: { [s.conclusions.id]: "Settled, then appealed." } } as never, { context: s.ctx });
  await expect(call(router.plugins.resolveConflict, { id: before.id, choice: "accept", reviewed: before.reviewed }, { context: s.ctx })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await s.field("Conclusions")).toBeDefined();
  const again = await item();
  expect(again.merged).toMatchObject({ keys: ["remove:Conclusions"], values: { "remove:Conclusions": { count: 1, shown: [[s.row.id, "Settled, then appealed."]] } } });
  // Answered on what it shows now, it applies: the table locked, the values read and the field removed, in that order.
  // The same database, through a client that records what it sends (`recordingDb` would empty it).
  const statements: string[] = [];
  const recording = { statements, db: drizzle((s.ctx.db as unknown as { $client: PGlite }).$client, { schema, logger: { logQuery: (q) => statements.push(q) } }) as unknown as Db };
  await call(router.plugins.resolveConflict, { id: again.id, choice: "accept", reviewed: again.reviewed }, { context: { ...s.ctx, db: recording.db } });
  expect(await s.field("Conclusions")).toBeUndefined();
  // From the answer's lock of the table on, in its one transaction: the rows' values read, then the field deleted.
  const from = recording.statements.findIndex((q) => /^select .* from "tables" .* for update/s.test(q));
  const after = recording.statements.slice(from).map((q) => (/^select .* from "rows"/s.test(q) ? "rows" : /^delete from "fields"/.test(q) ? "delete" : null)).filter(Boolean);
  expect(from).toBeGreaterThanOrEqual(0);
  const deleted = after.indexOf("delete");
  expect(deleted).toBeGreaterThan(0);
  expect(after.slice(0, deleted)).toContain("rows");
});

test("a removal's Approval answered no keeps the field, and the next update doesn't ask again", async () => {
  const s = await tableSetUp(decideTable(["remove:Conclusions"]), say("Removing Conclusions waits for you."));
  await s.ended(await s.hand());
  const [item] = (await call(router.questions.list, { status: "pending" }, { context: s.ctx })).flatMap((q) => q.update?.items ?? []);
  await call(router.plugins.resolveConflict, { id: item!.id, choice: "decline", reviewed: item!.reviewed }, { context: s.ctx });
  expect(await s.field("Conclusions")).toBeDefined();
  // Declined, as an unticked box: Fee, which Stem left out, is declined too.
  expect((await s.preview()).tables).toEqual([]);
});

test("a field retyped after its removal was approved makes it stale: skipped and said, the field kept", async () => {
  const s = await tableSetUp(decideTable(["remove:Conclusions"]), say("Removing Conclusions waits for you."));
  await s.ended(await s.hand());
  const [item] = (await call(router.questions.list, { status: "pending" }, { context: s.ctx })).flatMap((q) => q.update?.items ?? []);
  // The owner retypes it after Stem decided; its values stay as they were.
  await call(router.fields.retype, { id: s.conclusions.id, type: "text", dryRun: false }, { context: s.ctx });
  const result = await call(router.plugins.resolveConflict, { id: item!.id, choice: "accept", reviewed: item!.reviewed }, { context: s.ctx });
  expect(result).toMatchObject({ ok: true, stale: ["remove:Conclusions"] });
  expect(await s.field("Conclusions")).toMatchObject({ type: "text" });
});

test("a removal its operation refuses when approved is reported, not made, and stays offered", async () => {
  const s = await tableSetUp(decideTable(["remove:Conclusions"]), say("Removing Conclusions waits for you."));
  await s.ended(await s.hand());
  const [item] = (await call(router.questions.list, { status: "pending" }, { context: s.ctx })).flatMap((q) => q.update?.items ?? []);
  // A table's parent field can't be removed: here, Conclusions stands as Matters' parent.
  await s.ctx.db.update(schema.tables).set({ parentFieldId: s.conclusions.id }).where(eq(schema.tables.id, s.matters.id));
  const result = await call(router.plugins.resolveConflict, { id: item!.id, choice: "accept", reviewed: item!.reviewed }, { context: s.ctx });
  expect(result).toMatchObject({ ok: true, refused: [{ key: "remove:Conclusions", reason: expect.objectContaining({ key: "data.field.isParent" }) }] });
  expect(await s.field("Conclusions")).toBeDefined();
  await s.ctx.db.update(schema.tables).set({ parentFieldId: null }).where(eq(schema.tables.id, s.matters.id));
  expect((await s.preview()).tables[0]!.changes).toEqual([expect.objectContaining({ key: "remove:Conclusions" })]);
});

test("a change Stem picked that its operation refuses is said by plugin_decide, not reported as made", async () => {
  const s = await tableSetUp(decideTable(["add:Fee"]), say("Fee couldn't be added."));
  // Matters is full: no field can be added.
  const now = (await s.ctx.db.select().from(schema.fields).where(eq(schema.fields.tableId, s.matters.id))).length;
  await s.ctx.db.insert(schema.fields).values(Array.from({ length: MAX_FIELDS - now }, (_, i) => ({ id: `fld_fill${i}`, ownerId: s.ctx.ownerId, tableId: s.matters.id, name: `Filler ${i}`, type: "text" as const, choices: [], position: now + i })));
  await s.ended(await s.hand());
  expect(await s.field("Fee")).toBeUndefined();
  const result = s.model.inputs[1]!.items.at(-1) as { role: string; isError: boolean; result: string };
  expect(result).toMatchObject({ role: "tool", isError: false });
  expect(result.result).toContain('"refused":[{"key":"add:Fee"');
});

test("a removal's Approval answers only as the owner read it: values stored anew since, or an update that dropped it, apply nothing", async () => {
  const s = await tableSetUp(decideTable(["remove:Conclusions"]), say("Removing Conclusions waits for you."));
  await s.ended(await s.hand());
  const [item] = (await call(router.questions.list, { status: "pending" }, { context: s.ctx })).flatMap((q) => q.update?.items ?? []);
  const actor = { type: "user" as const, userId: s.ctx.ownerId };
  // Another request stored other values after this one read them.
  await expect(answerConflict(s.ctx, actor, item!.id, true, { keys: ["remove:Conclusions"], values: {} })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await s.field("Conclusions")).toBeDefined();
  // An update plans the table again: the Approval's item is dropped, and the old answer finds nothing.
  const again = await s.preview();
  await call(router.plugins.update, { id: s.pluginId, reviewed: again.reviewed }, { context: s.ctx });
  await expect(call(router.plugins.resolveConflict, { id: item!.id, choice: "accept", reviewed: item!.reviewed }, { context: s.ctx })).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await s.field("Conclusions")).toBeDefined();
});

const SKILL = "skills/legal-research/SKILL.md";
const PATH = "legal-research/SKILL.md";
const b64 = (text: string) => Buffer.from(text).toString("base64");

/**
 * As `setUp`, with the plugin's skill file changed by the owner ("Mine.") and by a new version
 * ("Theirs."): the update's screen shows that file in conflict, which `hand` gives to Stem.
 */
async function fileSetUp(...script: Script[]) {
  const s = await setUp(...script);
  const [pkg] = await s.ctx.db.select().from(schema.skillPackages).where(eq(schema.skillPackages.pluginId, s.pluginId));
  const base = lawFirm()[SKILL]!;
  const mine = `${base}\nMine.\n`;
  const theirs = `${base}\nTheirs.\n`;
  const edit = (text: string) => call(router.skills.setFile, { packageId: pkg!.id, path: PATH, base64: b64(text) }, { context: s.ctx });
  await edit(mine);
  s.fx.plugin.commit({ [SKILL]: theirs });
  const shown = await call(router.plugins.updatePreview, { id: s.pluginId }, { context: s.ctx });
  const conflict = shown.conflicts.find((c) => c.kind === "skill")!;
  expect(conflict).toMatchObject({ id: pkg!.id, field: `file:${PATH}` });
  const hand = async () => (await call(router.plugins.update, { id: s.pluginId, reviewed: shown.reviewed, stem: [conflict.key] }, { context: s.ctx })).stemJob!;
  const ended = (runId: string) => vi.waitFor(async () => expect((await s.ctx.db.select().from(schema.runs).where(eq(schema.runs.id, runId)))[0]!.status).not.toBe("running"), { timeout: 10_000 });
  const file = async () => {
    const [f] = await s.ctx.db.select().from(schema.skillFiles).where(eq(schema.skillFiles.packageId, pkg!.id));
    return f ? Buffer.from(f.content).toString() : null;
  };
  const items = async () => (await call(router.questions.list, { status: "pending" }, { context: s.ctx })).flatMap((q) => q.update?.items ?? []);
  return { ...s, packageId: pkg!.id, base, mine, theirs, edit, hand, ended, file, items };
}

const decideFile = (decision: unknown) => (input: TurnInput) => {
  const c = conflictsIn(input).find((c) => c.field === `file:${PATH}`)!;
  return { toolCalls: [{ id: "d", name: "plugin_decide", args: { conflictId: c.id, decision } }] };
};

test("a skill file handed to Stem is given whole; its merged text waits in the update's Approval, the owner's file staying, and applies on yes", async () => {
  let merged = "";
  const s = await fileSetUp((input) => {
    const [c] = conflictsIn(input) as unknown as { owner_now: string; plugin_new: string; plugin_before: string }[];
    expect(c).toMatchObject({ owner_now: expect.stringContaining("Mine."), plugin_new: expect.stringContaining("Theirs.") });
    merged = `${c!.owner_now}Theirs.\n`;
    return decideFile({ kind: "merge", value: merged })(input);
  }, say("Merged the skill's file; it waits for your Approval."));
  await s.ended(await s.hand());
  expect(await s.file()).toBe(s.mine);
  const [item] = await s.items();
  expect(item).toMatchObject({ kind: "skill_file", elementId: s.packageId, field: `file:${PATH}`, merged, mine: s.mine, next: s.theirs, name: "law-firm" });
  // The skill's page shows where it is: in the Approval, linked.
  const [mark] = await call(router.plugins.conflicts, { kind: "skill_file", id: s.packageId }, { context: s.ctx });
  expect(mark).toMatchObject({ status: "approval", approvalId: expect.any(String) });
  await call(router.plugins.resolveConflict, { id: item!.id, choice: "accept", reviewed: item!.reviewed }, { context: s.ctx });
  expect(await s.file()).toBe(merged);
  expect(await s.ctx.db.select().from(schema.pluginConflicts)).toEqual([]);
  expect(await call(router.questions.list, { status: "pending" }, { context: s.ctx })).toEqual([]);
});

test("Stem's reset of a skill file applies at once: the plugin's file", async () => {
  const s = await fileSetUp(decideFile({ kind: "reset" }), say("Took the plugin's file."));
  const runId = await s.hand();
  await s.ended(runId);
  expect(await s.file()).toBe(s.theirs);
  expect(await s.ctx.db.select().from(schema.pluginConflicts)).toEqual([]);
  expect(await s.ctx.db.select().from(schema.questions).where(eq(schema.questions.runId, runId))).toEqual([]);
});

test("an owner edit of the file before Stem decides reopens it: the file stays theirs, decided again on the skill's page", async () => {
  const s: Awaited<ReturnType<typeof fileSetUp>> = await fileSetUp(async (input) => {
    await s.edit(`${s.base}\nMine, again.\n`);
    return decideFile({ kind: "reset" })(input);
  }, say("Reset it."));
  await s.ended(await s.hand());
  expect(await s.file()).toBe(`${s.base}\nMine, again.\n`);
  const [mark] = await call(router.plugins.conflicts, { kind: "skill_file", id: s.packageId }, { context: s.ctx });
  expect(mark).toMatchObject({ status: "open", mine: `${s.base}\nMine, again.\n`, next: s.theirs });
  // Theirs to decide: the plugin's file.
  await call(router.plugins.resolveConflict, { id: mark!.id, choice: "plugin", reviewed: mark!.reviewed }, { context: s.ctx });
  expect(await s.file()).toBe(s.theirs);
  expect(await s.ctx.db.select().from(schema.pluginConflicts)).toEqual([]);
});

test("an owner edit of the file while Stem's merged text waits reopens it on yes: the file stays theirs, the Approval closes", async () => {
  const s = await fileSetUp(decideFile({ kind: "merge", value: `${lawFirm()[SKILL]!}\nBoth.\n` }), say("Merged."));
  await s.ended(await s.hand());
  const [item] = await s.items();
  await s.edit(`${s.base}\nMine, again.\n`);
  // The item as the owner read it: the edit changed what it shows, so it is read again first.
  await expect(call(router.plugins.resolveConflict, { id: item!.id, choice: "accept", reviewed: item!.reviewed }, { context: s.ctx })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await answerConflict(s.ctx, { type: "user", userId: s.ctx.ownerId }, item!.id, true)).toBe("reopened");
  expect(await s.file()).toBe(`${s.base}\nMine, again.\n`);
  expect(await s.ctx.db.select({ status: schema.pluginConflicts.status }).from(schema.pluginConflicts)).toEqual([{ status: "open" }]);
  expect(await call(router.questions.list, { status: "pending" }, { context: s.ctx })).toEqual([]);
});

test("a later update that changes the plugin's file reopens the decision waiting on it", async () => {
  const s = await fileSetUp(decideFile({ kind: "merge", value: `${lawFirm()[SKILL]!}\nBoth.\n` }), say("Merged."));
  await s.ended(await s.hand());
  s.fx.plugin.commit({ [SKILL]: `${s.base}\nTheirs, again.\n` });
  const again = await call(router.plugins.updatePreview, { id: s.pluginId }, { context: s.ctx });
  await call(router.plugins.update, { id: s.pluginId, reviewed: again.reviewed }, { context: s.ctx });
  expect(await s.file()).toBe(s.mine);
  expect(await s.ctx.db.select({ status: schema.pluginConflicts.status }).from(schema.pluginConflicts)).toEqual([{ status: "open" }]);
  expect(await call(router.questions.list, { status: "pending" }, { context: s.ctx })).toEqual([]);
});

test("a skill file merged with anything but a text is refused by plugin_decide and applies nothing", async () => {
  const s = await fileSetUp(decideFile({ kind: "merge", value: ["Mine."] }), say("It was refused."));
  await s.ended(await s.hand());
  expect(await s.file()).toBe(s.mine);
  const result = s.model.inputs[1]!.items.at(-1) as { role: string; isError: boolean; result: string };
  expect(result).toMatchObject({ role: "tool", isError: true });
  expect(result.result).toContain("A skill file is merged as its whole text.");
  // Undecided when the Job ended: the owner's again.
  expect(await s.ctx.db.select({ status: schema.pluginConflicts.status }).from(schema.pluginConflicts)).toEqual([{ status: "open" }]);
});

test("a merged skill file the package's check refuses is said by plugin_decide and waits for nothing", async () => {
  const s = await fileSetUp(decideFile({ kind: "merge", value: "No frontmatter any more." }), say("It was refused."));
  const runId = await s.hand();
  await s.ended(runId);
  expect(await s.file()).toBe(s.mine);
  const result = s.model.inputs[1]!.items.at(-1) as { role: string; isError: boolean; result: string };
  expect(result).toMatchObject({ role: "tool", isError: true });
  expect(result.result).toContain("Nothing was applied");
  expect(await s.ctx.db.select().from(schema.questions).where(eq(schema.questions.runId, runId))).toEqual([]);
  expect(await s.ctx.db.select({ status: schema.pluginConflicts.status }).from(schema.pluginConflicts)).toEqual([{ status: "open" }]);
});

test("a file kept in a conflict is its text, or its size and digest when it isn't text jsonb can store", () => {
  expect(fileValue(Buffer.from("Mine."))).toBe("Mine.");
  expect(fileValue(undefined)).toBeNull();
  expect(fileValue(Buffer.from("a\u0000b"))).toMatchObject({ bytes: 3, sha256: expect.any(String) });
  expect(fileValue(Buffer.from([0xff, 0xfe]))).toMatchObject({ bytes: 2 });
});
