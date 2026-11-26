import { attachmentPath, isAttachmentPath, mcpActionName, parseRule, type Answer, type Grant, type HarnessEvent, type ServerToRunner, type SessionFile, type SessionStart } from "@dispand/runner-protocol";
import { and, eq, inArray } from "drizzle-orm";
import type { DataEvents } from "../data/events.ts";
import type { Db } from "../db/client.ts";
import { agents, plugins, runs, stepRuns, type MessageFile } from "../db/schema.ts";
import { inRunScope, inScope, SYSTEM } from "../db/scope.ts";
import { usedOnRunner } from "../skills/runner-access.ts";
import { MAX_SESSION_SKILLS, runnerServers, sessionTooling } from "./tooling.ts";
import { runnerForRun } from "./session-harness.ts";
import { exposedName } from "../platform/exposed.ts";
import { jobTokenOf } from "../platform/token.ts";
import { jobMemoryFiles } from "../memory/read.ts";
import { logError } from "../log.ts";
import type { RunnerHub } from "../runners/hub.ts";
import { Engine } from "./engine.ts";
import { attributed } from "./answers.ts";
import { CloudRunner, combineToolCallers, noTools, type ToolCaller } from "../cloud/runner.ts";
import { installedToolCaller } from "../tools/cloud.ts";
import type { ClientHarness, ModelClient } from "../cloud/model-client.ts";
import type { SecretBox } from "../secrets.ts";
import { connectorToolExecutor, InstalledTools } from "../tools/executor.ts";
import type { ToolConnector } from "../tools/mcp.ts";
import { type AgentAnswerer, type CliHarness, type HarnessAdapter, type InterruptOutcome, type StartParams } from "./harness.ts";
import { newId } from "../ids.ts";
import { RoutingAdapter } from "./routing-adapter.ts";
import type { PlaceGate } from "./places.ts";
import { oneLine } from "../text.ts";

/**
 * A chat message to a CLI session with its files: each at a path Dispand makes in the run folder
 * (`attachmentPath`), which the text names, the original name only as words beside it. A path
 * that isn't `isAttachmentPath` (one a CLI reads as configuration) is refused here, before any
 * runner is told: the runner refuses it again.
 */
export function chatFiles(text: string, files: MessageFile[]): { text: string; files?: SessionFile[] } {
  if (files.length === 0) return { text };
  const sent = files.map((f) => ({ attachmentId: f.id, path: attachmentPath(f.id, f.name) }));
  if (sent.some((f) => !isAttachmentPath(f.path))) throw new Error("an attachment's path isn't one a session may get");
  const lines = sent.map((f, i) => `- ${f.path} (attached as “${oneLine(files[i]!.name)}”)`);
  return { text: `${text}\n\nFiles attached to this message, copied into your working folder (paths relative to it):\n${lines.join("\n")}`, files: sent };
}

/** The frame a start message fits in, and what is left spare in it. */
const MAX_FRAME_BYTES = 1024 * 1024;
const FRAME_MARGIN_BYTES = 32 * 1024;

/** CLI harnesses: sessions run on a runner, reached through the hub. */
export class CliHarnessAdapter implements HarnessAdapter<CliHarness> {
  private readonly interrupts = new Map<string, { runnerId: string; sessionId: string; turnId: string; finish: (outcome: InterruptOutcome) => void }>();
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

  /**
   * The session's agent's skill packages and runner tools (`tooling.ts`), read at each start
   * like the token: a resume carries them as they are then. HTTP tools never travel: their
   * address and headers stay on the server. Only a tool of the harness's own runner is sent.
   */
  private async tooling(sessionId: string, runnerId: string, db: Db = this.db, kind?: string): Promise<Pick<SessionStart, "skills" | "mcpServers" | "nativePlugins"> & { unasked: string[] }> {
    const tooling = await sessionTooling(db, sessionId);
    kind ??= (await db.select({ harness: stepRuns.harness }).from(stepRuns).where(eq(stepRuns.sessionId, sessionId)))[0]?.harness?.kind;
    // Only the packages this runner is served (`usedOnRunner`): one it would be refused, as when
    // the agent moved to a harness elsewhere since the Job was created, would fail the start.
    const skills: typeof tooling.skills = [];
    for (const skill of tooling.skills) {
      if (skills.length < MAX_SESSION_SKILLS && (await usedOnRunner(db, runnerId, skill.packageId))) skills.push(skill);
    }
    return {
      skills,
      ...(tooling.nativePlugins.length ? { nativePlugins: tooling.nativePlugins } : {}),
      // With each, the actions the agent lets run unasked: the runner doesn't prompt for these
      // (per-agent grants only in Jobs; run-only grants also in workflow sessions).
      mcpServers: runnerServers(tooling, runnerId).map((t) => {
        const grants = tooling.jobId ? t.unasked : (t.runUnasked ?? []);
        const unasked = t.actions.filter((a) => grants.includes(a.name) && a.name.length <= 200 && t.actions.filter((other) => mcpActionName(other.name, kind) === mcpActionName(a.name, kind)).every((other) => grants.includes(other.name))).map((a) => a.name).slice(0, 500);
        const own = { ...(t.denied.length ? { denied: t.denied } : {}), ...(unasked.length ? { unasked } : {}) };
        return t.plugin ? { name: t.server, type: "plugin" as const, ...t.plugin, ...own } : { name: t.server, type: "runner" as const, tool: t.tool, ...own };
      }),
      // The actions the agent lets run unasked, under the names the tools endpoint lists them:
      // the CLI doesn't prompt for these. As many as the protocol carries; it prompts for the
      // rest, and the endpoint, which decides alone, runs them all the same.
      unasked: tooling.httpTools
        .flatMap((tool) => tool.actions.filter((a) => tool.unasked.includes(a.name)).map((a) => exposedName(tool, a.name)))
        .sort()
        .slice(0, 500),
    };
  }

  async start(harness: CliHarness, params: StartParams, grant?: Grant): Promise<string | false> {
    const { runKey, jobMemory, ...start } = params;
    const jobToken = await this.jobToken(params.sessionId);
    const [stored] = jobToken ? await this.db.select({ rules: agents.cliRules, remembered: runs.remembered, agentId: agents.id }).from(stepRuns).innerJoin(runs, eq(runs.id, stepRuns.runId)).innerJoin(agents, and(eq(agents.id, runs.agentId), eq(agents.workspaceId, runs.workspaceId))).where(eq(stepRuns.sessionId, params.sessionId)) : [];
    const nativeRules = (stored?.rules ?? []).filter((rule) => rule.cli === harness.kind && parseRule(harness.kind, rule.rule) !== null);
    const forRun = (decision: "allow" | "deny") => (stored?.remembered[decision] ?? []).flatMap((s) => s.kind === "cli" && s.agentId === stored?.agentId && s.cli === harness.kind && parseRule(harness.kind, s.rule) ? [s.rule] : []);
    const rules = { allow: [...new Set([...forRun("allow"), ...nativeRules.filter((r) => r.decision === "allow").map((r) => r.rule)])].slice(0, 200), deny: [...new Set([...forRun("deny"), ...nativeRules.filter((r) => r.decision === "deny").map((r) => r.rule)])] };
    if (rules.deny.length > 200) throw new Error("Too many native denial rules for one session");
    const { unasked, ...tooling } = await this.tooling(params.sessionId, harness.runnerId, this.db, harness.kind);
    // What this start names, kept on the step for the run view: ids and names only.
    const ids = (tooling.nativePlugins ?? []).map((p) => p.pluginId);
    const named = ids.length ? await this.db.select({ pluginId: plugins.id, name: plugins.name }).from(plugins).where(inArray(plugins.id, ids)) : [];
    const msg: ServerToRunner = {
      type: "session.start",
      start: {
        ...start,
        harness: harness.kind,
        cwd: { mode: "per-run", runKey },
        permissionMode: harness.permissionMode,
        ...(harness.model ? { model: harness.model } : {}),
        ...(grant ? { grant } : {}),
        ...tooling,
        ...(jobToken ? { jobToken, ...(unasked.length ? { unasked } : {}), ...(rules.allow.length || rules.deny.length ? { rules } : {}) } : {}),
        // The harness's kind and permission mode go together: the procedures only store matching ones.
      } as SessionStart,
    };
    // A Job's memory as files, filled within what the rest of the start leaves of the frame.
    if (jobMemory && msg.type === "session.start") {
      const memory = jobMemoryFiles(jobMemory, MAX_FRAME_BYTES - Buffer.byteLength(JSON.stringify(msg)) - FRAME_MARGIN_BYTES);
      if (memory.length) msg.start.memory = memory;
    }
    // The connection it went on (`reconcile` tells a start the runner's report predates from one it lost).
    const connection = await this.hub.send(harness.runnerId, msg);
    // Only a start the runner took: a failed one leaves the last delivered list.
    if (connection) await this.db.update(stepRuns).set({ nativePlugins: named.sort((a, b) => a.name.localeCompare(b.name)) }).where(eq(stepRuns.sessionId, params.sessionId)).catch((err: unknown) => logError("step native plugins not saved", err));
    return connection;
  }

  async narrowPermissions(sessionId: string, db: Db = this.db): Promise<boolean> {
    const runnerId = await this.runnerOf(sessionId);
    const { mcpServers } = await this.tooling(sessionId, runnerId, db);
    return this.deliver(runnerId, { type: "session.permissions", sessionId, servers: mcpServers.flatMap((ref) => ref.type !== "http" ? [{ name: ref.name, unasked: ref.unasked ?? [], ...(ref.denied?.length ? { denied: ref.denied } : {}) }] : []) });
  }

  async send(sessionId: string, text: string, files: MessageFile[] = []): Promise<boolean> {
    return this.deliver(await this.runnerOf(sessionId), { type: "session.send", sessionId, ...chatFiles(text, files) });
  }

  async steer(sessionId: string, turnId: string, requestId: string, text: string, files: MessageFile[] = []): Promise<boolean> {
    return this.deliver(await this.runnerOf(sessionId), { type: "session.send", sessionId, ...chatFiles(text, files), steer: { turnId, requestId } });
  }

  async answer(sessionId: string, questionId: string, answer: Answer, by?: AgentAnswerer): Promise<boolean> {
    // The protocol's answer has no answerer: an agent's says it in its own words.
    return this.deliver(await this.runnerOf(sessionId), { type: "session.answer", sessionId, questionId, answer: by ? attributed(answer, by.name) : answer });
  }

  stop(sessionId: string, runnerId: string): Promise<boolean> {
    return this.deliver(runnerId, { type: "session.stop", sessionId });
  }

  async interrupt(sessionId: string, turnId: string): Promise<InterruptOutcome> {
    const runnerId = await this.runnerOf(sessionId);
    const requestId = newId("int");
    return new Promise<InterruptOutcome>((resolve) => {
      const timer = setTimeout(() => finish("failed"), 10_000);
      const finish = (outcome: InterruptOutcome) => {
        clearTimeout(timer);
        this.interrupts.delete(requestId);
        resolve(outcome);
      };
      this.interrupts.set(requestId, { runnerId, sessionId, turnId, finish });
      void this.deliver(runnerId, { type: "session.interrupt", sessionId, turnId, requestId }).then((sent) => { if (!sent) finish("failed"); }, () => finish("failed"));
    });
  }

  acknowledge(runnerId: string, sessionId: string, event: HarnessEvent): void {
    if (event.type !== "interrupt-result") return;
    const pending = this.interrupts.get(event.requestId);
    if (pending?.runnerId === runnerId && pending.sessionId === sessionId && pending.turnId === event.turnId) pending.finish(event.outcome);
  }

  private async deliver(runnerId: string, msg: ServerToRunner): Promise<boolean> {
    return !!(await this.hub.send(runnerId, msg));
  }

  private async runnerOf(sessionId: string): Promise<string> {
    const [row] = await this.db.select({ runnerId: stepRuns.runnerId }).from(stepRuns).innerJoin(runs, eq(runs.id, stepRuns.runId))
      .where(and(eq(stepRuns.sessionId, sessionId), runnerForRun(this.db, stepRuns.runnerId)));
    if (!row?.runnerId) throw new Error("unknown session");
    return row.runnerId;
  }
}

/**
 * What an engine calls besides runners: installed tools (through `connector`, Tool steps run), cloud agents' tools and model clients;
 * `gate`, asked before work on a step's place (`PlaceGate`).
 */
export type EngineDeps = { connector?: ToolConnector; tools?: ToolCaller; client?: (h: ClientHarness) => ModelClient; filesDir?: string; gate?: PlaceGate };

/**
 * An engine over the hub's runners and the in-process cloud runner: their events go to it, each
 * runner is reconciled once caught up, and cloud sessions on `recover()`. Tool steps call
 * installed tools through `deps.connector` (none: they fail).
 */
export function createEngine(db: Db, hub: RunnerHub, secrets: SecretBox, dataEvents: DataEvents, deps: EngineDeps = {}): Engine {
  const installed = deps.connector ? new InstalledTools(db, secrets, deps.connector) : undefined;
  // A cloud session's tools: the caller's (Dispand's own, in the app) and its agent's HTTP tools, called through the connector.
  const tools = installed ? combineToolCallers(deps.tools ?? noTools, installedToolCaller(db, installed, deps.filesDir)) : (deps.tools ?? noTools);
  // A cloud session's turns and events run in its run's scope, whoever woke the session (`inRunScope`).
  const inSessionRun = async <T>(sessionId: string, work: () => Promise<T>): Promise<T> => {
    const [step] = await inScope(SYSTEM, () => db.select({ runId: stepRuns.runId }).from(stepRuns).where(eq(stepRuns.sessionId, sessionId)));
    return step ? inRunScope(db, step.runId, work) : work();
  };
  const cloud: CloudRunner = new CloudRunner(db, secrets, { tools, claimTurn: (sessionId): Promise<boolean> => inSessionRun(sessionId, () => engine.claimCloudTurn(sessionId)), ...(deps.gate ? { gate: deps.gate } : {}), ...(deps.client ? { client: deps.client } : {}), ...(deps.filesDir ? { filesDir: deps.filesDir } : {}) });
  const cli = new CliHarnessAdapter(db, hub, secrets);
  const engine: Engine = new Engine(
    db,
    new RoutingAdapter(db, cli, cloud),
    cloud,
    dataEvents,
    installed ? connectorToolExecutor(installed) : undefined,
    secrets,
    deps.gate,
  );
  hub.onEvent((runnerId, sessionId, event, seq) => {
    cli.acknowledge(runnerId, sessionId, event);
    return engine.onHarnessEvent(sessionId, event, { runnerId, seq });
  });
  hub.onCaughtUp((runnerId, liveSessions, connection) => engine.reconcile(runnerId, liveSessions, connection));
  cloud.onEvent((sessionId, event, seq) => inSessionRun(sessionId, () => engine.onCloudEvent(sessionId, event, seq)));
  return engine;
}
