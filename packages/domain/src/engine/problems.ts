import { SessionStart, TEXT } from "@dispand/runner-protocol";
import type { Db, Tx } from "../db/client.ts";
import type { Placement, runners } from "../db/schema.ts";
import { personalOnly } from "../runners/grants.ts";
import { type MessageKey, stored } from "../messages/index.ts";
import { loadTableSchemas } from "../data/tables.ts";
import { loadToolSchemas } from "../tools/executor.ts";
import { tableIdsOf, validateDataSteps } from "../workflows/data-steps.ts";
import { validateWorkflow, type WorkflowIssue } from "../workflows/derive.ts";
import type { WorkflowDef } from "../workflows/model.ts";
import { toolIdsOf, validateToolSteps } from "../workflows/tool-steps.ts";
import type { CliHarness, StartParams } from "./harness.ts";

type RunnerRow = typeof runners.$inferSelect;

/** Why the runner would refuse this start (the protocol's `SessionStart`), in the owner's words; null if it wouldn't. */
export function startProblem(harness: CliHarness, { runKey, ...start }: StartParams): string | null {
  const parsed = SessionStart.safeParse({
    ...start,
    harness: harness.kind,
    cwd: { mode: "per-run", runKey },
    permissionMode: harness.permissionMode,
    ...(harness.model ? { model: harness.model } : {}),
    skills: [],
    mcpServers: [],
  });
  if (parsed.success) return null;
  const field = String(parsed.error.issues[0]?.path[0] ?? "start");
  if (field === "prompt" && start.prompt.length > TEXT) {
    return stored("engine.fail.promptTooLong", { length: start.prompt.length, max: TEXT });
  }
  const known: Partial<Record<string, MessageKey>> = {
    prompt: "engine.fail.startOutside.prompt",
    systemPrompt: "engine.fail.startOutside.systemPrompt",
    expectedOutputs: "engine.fail.startOutside.expectedOutputs",
    model: "engine.fail.startOutside.model",
  };
  return stored(known[field] ?? "engine.fail.startOutside.other");
}

/**
 * Why the runner can't run this CLI, as it last reported it (`hello.clis`); null when it can or
 * hasn't reported yet. The runner checks Codex's sign-in once, when it starts.
 */
export function cliProblem(kind: string, runner: Pick<RunnerRow, "name" | "clis" | "lastSeenAt">): string | null {
  if (kind !== "codex" || runner.lastSeenAt === null) return null;
  if (!runner.clis.codex) return stored("engine.fail.codexMissing", { runner: runner.name });
  // A runner whose workers use its own OpenAI key needs no Codex login.
  if (!runner.clis.codex.signedIn && !runner.clis.modelKeys?.includes("openai")) return stored("engine.fail.codexSignIn", { runner: runner.name });
  return null;
}

/**
 * Why the runner can't run this CLI on the credential the action is placed on; null if it can. A
 * personal placement runs on its subscriber's subscription (checked at each use, `runners/grants.ts`);
 * any other needs the workspace's, which a CLI signed in only as someone's enrolled subscription
 * and without a workspace model key doesn't offer.
 */
export async function credentialProblem(db: Db | Tx, kind: string, runner: Pick<RunnerRow, "id" | "name" | "clis" | "lastSeenAt">, placement: Placement): Promise<string | null> {
  if (placement.kind === "personal") return null;
  if (await personalOnly(db, runner, kind)) return stored("engine.fail.personalOnly", { runner: runner.name });
  return cliProblem(kind, runner);
}

/** What keeps `def` from running: its own issues, its data steps' and Tool steps' against the workspace's tables and tools. */
export async function runIssues(db: Db | Tx, workspaceId: string, def: WorkflowDef): Promise<WorkflowIssue[]> {
  return [
    ...validateWorkflow(def),
    ...validateDataSteps(def, await loadTableSchemas(db, workspaceId, tableIdsOf(def))),
    ...validateToolSteps(def, await loadToolSchemas(db, workspaceId, toolIdsOf(def))),
  ];
}
