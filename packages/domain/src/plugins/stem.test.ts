import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import type { TurnInput } from "../cloud/model-client.ts";
import { fakeModel, say, type Script } from "../cloud/test-model.ts";
import * as schema from "../db/schema.ts";
import { createEngine } from "../engine/cli-harness.ts";
import { platformToolCaller } from "../platform/cloud.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";
import { lawFirm, lawFirmMarket } from "./test-support.ts";
import { writeFields } from "./write-field.ts";

const DRAFTING = "com.dispand/agents/drafting.md";

/** The conflicts the Stem Job was given, read from its prompt. */
const conflictsIn = (input: TurnInput) => JSON.parse((input.items[0] as { text: string }).text.split("\n\n").slice(1).join("\n\n")) as { id: string; field: string }[];

/**
 * The law-firm plugin with Drafting set up on a cloud harness (the Assistant too), its
 * instructions changed by the owner, then a new version that changes them as well: one conflict.
 */
async function setUp(...script: Script[]) {
  const base = { ...(await ownerContext()), gitFileUrls: true };
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
  const { pluginId } = await call(router.plugins.install, { ...entry, reviewed, setup: { primitives: ["Clients", "Matters", "Research"], agents: [{ name: "Drafting", harnessId: cloud.id }] } }, { context: ctx });
  const [row] = await ctx.db.select().from(schema.agents).where(eq(schema.agents.pluginComponent, "Drafting"));
  // The owner's own instructions: an override of the plugin's.
  await writeFields(ctx, "agent", row!.id, { systemPrompt: "Mine." });
  fx.plugin.commit({ [DRAFTING]: lawFirm()[DRAFTING]!.replace(/\n---\n[\s\S]*$/, "\n---\nDraft every letter in plain words.\n") });
  const preview = await call(router.plugins.updatePreview, { id: pluginId }, { context: ctx });
  const drafting = async () => (await ctx.db.select().from(schema.agents).where(eq(schema.agents.id, row!.id)))[0]!;
  return { ctx, model, pluginId, preview, drafting };
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
  const refused = s.model.inputs[2]!.items.at(-1) as { role: string; isError: boolean };
  expect(refused).toMatchObject({ role: "tool", isError: true });
});

test("a Stem Job that ends without deciding leaves the conflict the owner's again", async () => {
  const s = await setUp(say("I won't decide."));
  const [conflict] = s.preview.conflicts;
  const { stemJob } = await call(router.plugins.update, { id: s.pluginId, reviewed: s.preview.reviewed, stem: [conflict!.key] }, { context: s.ctx });
  await vi.waitFor(async () => expect((await s.ctx.db.select().from(schema.runs).where(eq(schema.runs.id, stemJob!)))[0]!.status).not.toBe("running"), { timeout: 10_000 });
  expect(await s.ctx.db.select({ status: schema.pluginConflicts.status }).from(schema.pluginConflicts)).toEqual([{ status: "open" }]);
  expect((await s.drafting()).systemPrompt).toBe("Mine.");
});
