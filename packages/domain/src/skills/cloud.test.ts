import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import type { ChatItem } from "../cloud/model-client.ts";
import { fakeModel, say, use, type Script } from "../cloud/test-model.ts";
import { questions, runs } from "../db/schema.ts";
import { createEngine } from "../engine/cli-harness.ts";
import { router } from "../rpc/router.ts";
import { ownerContext } from "../runners/test-support.ts";

const b64 = (text: string) => Buffer.from(text).toString("base64");

/** A cloud agent with the skill `tidy` (and a reference); the owner also has `vault`, which the agent hasn't. */
async function setup(script: Script[], { withSkill = true } = {}) {
  const base = await ownerContext();
  const model = fakeModel(...script);
  const engine = createEngine(base.db, base.hub, base.secrets, base.dataEvents, { client: model.client });
  onTestFinished(() => engine.stop());
  const context = { ...base, engine };
  const harness = await call(router.harnesses.create, { type: "cloud", name: "API", kind: "openai-compatible", baseUrl: "https://llm.test/v1", model: "m", systemPrompt: "" } as never, { context });
  const tidy = await call(
    router.skills.create,
    { name: "tidy", description: "Tidies a table.", instructions: "Read references/rules.md, then tidy.", requiredToolIds: [], files: [{ path: "references/rules.md", base64: b64("Trim every cell.") }] },
    { context },
  );
  const vault = await call(router.skills.create, { name: "vault", description: "Holds the vault's code.", instructions: "The code is 4711.", requiredToolIds: [] }, { context });
  const fields = { name: "Clerk", harnessId: harness.id, systemPrompt: "" };
  const agent = await call(router.agents.create, { ...fields, skillPackageIds: withSkill ? [tidy.packageId] : [] }, { context });
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Tidy the table.", config: { kind: "manual", placement: "button" } }, { context });
  const until = (runId: string, status: string) =>
    vi.waitFor(async () => {
      const [run] = await context.db.select().from(runs).where(eq(runs.id, runId));
      if (run!.status !== status) throw new Error(`run is ${run!.status}`);
    });
  const start = async () => (await call(router.jobs.start, { triggerId: trigger.id }, { context })).runId;
  return { context, model, agent, fields, tidy, vault, start, until };
}

const results = (items: ChatItem[]) => items.flatMap((i) => (i.role === "tool" ? [{ result: i.result, isError: i.isError }] : []));

test("a cloud session lists its agent's skills and reads their files without asking the owner", async () => {
  const s = await setup([use("read_skill", { skill: "tidy", path: "SKILL.md" }, "c1"), use("read_skill", { skill: "tidy", path: "references/rules.md" }, "c2"), say("Done.")]);
  const runId = await s.start();
  await s.until(runId, "succeeded");
  const first = s.model.inputs[0]!;
  expect(first.system).toContain("- tidy: Tidies a table.");
  expect(first.system).not.toContain("vault");
  expect(first.tools.map((t) => t.name)).toContain("read_skill");
  const read = results(s.model.inputs[2]!.items);
  expect(read[0]).toMatchObject({ isError: false });
  expect(read[0]!.result).toContain("name: tidy");
  expect(read[0]!.result).toContain("Read references/rules.md, then tidy.");
  expect(read[1]).toEqual({ result: "Trim every cell.", isError: false });
  expect(await s.context.db.select().from(questions).where(eq(questions.runId, runId))).toEqual([]);
});

test("an agent without skills gets no read_skill and no skills in its prompt", async () => {
  const s = await setup([use("read_skill", { skill: "vault", path: "SKILL.md" }), say("Done.")], { withSkill: false });
  const runId = await s.start();
  await s.until(runId, "succeeded");
  expect(s.model.inputs[0]!.tools.map((t) => t.name)).not.toContain("read_skill");
  expect(s.model.inputs[0]!.system).not.toContain("Skills");
  expect(results(s.model.inputs[1]!.items)).toEqual([{ result: "There is no skill vault among yours.", isError: true }]);
});

test("a skill outside the Job's scope is refused: another package, one added after the Job began, one taken back", async () => {
  const s = await setup([
    use("read_skill", { skill: "vault", path: "SKILL.md" }, "c1"),
    // Meanwhile the agent loses tidy and gains vault: the Job keeps its snapshot, minus what was taken back.
    async () => {
      await call(router.agents.update, { id: s.agent.id, ...s.fields, skillPackageIds: [s.vault.packageId] }, { context: s.context });
      return { toolCalls: [{ id: "c2", name: "read_skill", args: { skill: "vault", path: "SKILL.md" } }] };
    },
    use("read_skill", { skill: "tidy", path: "SKILL.md" }, "c3"),
    say("Done."),
  ]);
  const runId = await s.start();
  await s.until(runId, "succeeded");
  expect(results(s.model.inputs[3]!.items)).toEqual([
    { result: "There is no skill vault among yours.", isError: true },
    { result: "There is no skill vault among yours.", isError: true },
    { result: "There is no skill tidy among yours.", isError: true },
  ]);
  // And the prompt follows: no skill left to list, no read_skill offered.
  expect(s.model.inputs[3]!.system).not.toContain("tidy");
  expect(s.model.inputs[3]!.tools.map((t) => t.name)).not.toContain("read_skill");
  expect(JSON.stringify(s.model.inputs)).not.toContain("4711");
});

test("a path that tries to leave the skill's folder is refused", async () => {
  const escapes = ["../vault/SKILL.md", "/tidy/SKILL.md", "/etc/passwd", "references/../SKILL.md", "./SKILL.md", "..\\vault\\SKILL.md", "%2e%2e/vault/SKILL.md", "..%2fvault%2fSKILL.md", "%2E%2E%2Fvault%2FSKILL.md"];
  const s = await setup([...escapes.map((path, i) => use("read_skill", { skill: "tidy", path }, `c${i}`)), use("read_skill", { skill: "tidy", path: 3 }, "bad"), say("Done.")]);
  const runId = await s.start();
  await s.until(runId, "succeeded");
  const read = results(s.model.inputs.at(-1)!.items);
  expect(read).toHaveLength(escapes.length + 1);
  for (const r of read) expect(r.isError).toBe(true);
  // A decoded or unsafe path is never looked up: the encoded ones name no file of tidy, and say which there are.
  expect(read[6]!.result).toBe("tidy has no file %2e%2e/vault/SKILL.md. Its files: SKILL.md, references/rules.md");
  expect(read[0]!.result).toContain("without .. or . parts");
  expect(JSON.stringify(s.model.inputs)).not.toContain("4711");
});
