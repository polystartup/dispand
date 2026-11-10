import type { Answer, ServerToRunner, SessionStart } from "@dispand/runner-protocol";
import { and, eq, inArray } from "drizzle-orm";
import type { DataEvents } from "../data/events.ts";
import type { Db } from "../db/client.ts";
import { runs, stepRuns } from "../db/schema.ts";
import { jobTokenOf } from "../platform/token.ts";
import type { RunnerHub } from "../runners/hub.ts";
import { Engine } from "./engine.ts";
import { CloudRunner, noTools, type ToolCaller } from "../cloud/runner.ts";
import type { ClientHarness, ModelClient } from "../cloud/model-client.ts";
import type { SecretBox } from "../secrets.ts";
import { connectorToolExecutor, InstalledTools } from "../tools/executor.ts";
import type { ToolConnector } from "../tools/mcp.ts";
import { CLOUD_SOURCE, type CliHarness, type HarnessAdapter, type StartParams } from "./harness.ts";
import { RoutingAdapter } from "./routing-adapter.ts";

/** CLI harnesses: sessions run on a runner, reached through the hub. */
export class CliHarnessAdapter implements HarnessAdapter<CliHarness> {
  constructor(
    private readonly db: Db,
    private readonly hub: RunnerHub,
    /** Opens a Job's token for its sessions' starts; without one, sessions get no Job server. */
    private readonly secrets?: SecretBox,
  ) {}

  /** The token of the Job the session works for, read at each start (a resume gets it too): it is never kept with the step. */
  private async jobToken(sessionId: string): Promise<string | null> {
    if (!this.secrets) return null;
    const [run] = await this.db
      .select({ id: runs.id, tokenSealed: runs.tokenSealed })
      .from(stepRuns)
      .innerJoin(runs, eq(runs.id, stepRuns.runId))
      .where(and(eq(stepRuns.sessionId, sessionId), eq(runs.source, "agent"), inArray(runs.status, ["running", "waiting"])));
    return run ? jobTokenOf(this.secrets, run) : null;
  }

  async start(harness: CliHarness, params: StartParams): Promise<boolean> {
    const { runKey, ...start } = params;
    const jobToken = await this.jobToken(params.sessionId);
    return this.deliver(harness.runnerId, {
      type: "session.start",
      start: {
        ...start,
        harness: harness.kind,
        cwd: { mode: "per-run", runKey },
        permissionMode: harness.permissionMode,
        ...(harness.model ? { model: harness.model } : {}),
        skills: [],
        mcpServers: [],
        ...(jobToken ? { jobToken } : {}),
        // The harness's kind and permission mode go together: the procedures only store matching ones.
      } as SessionStart,
    });
  }

  async send(sessionId: string, text: string): Promise<boolean> {
    return this.deliver(await this.runnerOf(sessionId), { type: "session.send", sessionId, text });
  }

  async answer(sessionId: string, questionId: string, answer: Answer): Promise<boolean> {
    return this.deliver(await this.runnerOf(sessionId), { type: "session.answer", sessionId, questionId, answer });
  }

  stop(sessionId: string, runnerId: string): Promise<boolean> {
    return this.deliver(runnerId, { type: "session.stop", sessionId });
  }

  private deliver(runnerId: string, msg: ServerToRunner): Promise<boolean> {
    return this.hub.send(runnerId, msg);
  }

  private async runnerOf(sessionId: string): Promise<string> {
    const [row] = await this.db.select({ runnerId: stepRuns.runnerId }).from(stepRuns).where(eq(stepRuns.sessionId, sessionId));
    if (!row?.runnerId) throw new Error("unknown session");
    return row.runnerId;
  }
}

/** What an engine calls besides runners: installed tools (through `connector`, Tool steps run), cloud agents' tools and model clients. */
export type EngineDeps = { connector?: ToolConnector; tools?: ToolCaller; client?: (h: ClientHarness) => ModelClient };

/**
 * An engine over the hub's runners and the in-process cloud runner: their events go to it, each
 * runner is reconciled once caught up, and cloud sessions on `recover()`. Tool steps call
 * installed tools through `deps.connector` (none: they fail).
 */
export function createEngine(db: Db, hub: RunnerHub, secrets: SecretBox, dataEvents: DataEvents, deps: EngineDeps = {}): Engine {
  const cloud = new CloudRunner(db, secrets, { tools: deps.tools ?? noTools, ...(deps.client ? { client: deps.client } : {}) });
  const installed = deps.connector ? new InstalledTools(db, secrets, deps.connector) : undefined;
  const engine = new Engine(
    db,
    new RoutingAdapter(db, new CliHarnessAdapter(db, hub, secrets), cloud),
    cloud,
    dataEvents,
    installed ? connectorToolExecutor(installed) : undefined,
    secrets,
  );
  hub.onEvent((runnerId, sessionId, event, seq) => engine.onHarnessEvent(sessionId, event, { runnerId, seq }));
  hub.onCaughtUp((runnerId, liveSessions) => engine.reconcile(runnerId, liveSessions));
  cloud.onEvent((sessionId, event, seq) => engine.onHarnessEvent(sessionId, event, { runnerId: CLOUD_SOURCE, seq }));
  return engine;
}

const globalForEngine = globalThis as { __dispandEngine?: Engine };

/** The process's one engine (next to `getHub`'s one hub). Call `recover()` once after creating it. */
export function getEngine(db: Db, hub: RunnerHub, secrets: SecretBox, dataEvents: DataEvents, deps: EngineDeps = {}): Engine {
  return (globalForEngine.__dispandEngine ??= createEngine(db, hub, secrets, dataEvents, deps));
}
