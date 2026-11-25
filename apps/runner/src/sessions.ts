import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type HarnessEvent,
  JOB_FILES_PATH,
  JOB_SERVER_NAME,
  MAX_LIVE_SESSIONS,
  type ServerToRunner,
  SESSION_ALREADY_RUNNING,
  SESSION_NOT_RUNNING,
  type SessionStart,
} from "@dispand/runner-protocol";
import { BypassRefused, type ClaudeDeps, startClaudeSession } from "./claude.ts";
import { type CodexDeps, startCodexSession } from "./codex/session.ts";
import { codexRequired, RESTRICTED_CODEX } from "./codex/version.ts";
import { writeDurable } from "./durable.ts";
import type { RunnerConfig } from "./config.ts";
import type { HarnessSession } from "./outcome.ts";
import { codexMcpServers, mcpConfigFor, ToolRefused, withJobServer } from "./mcp.ts";
import { fetchPlugin, type Launch, launchPluginServer } from "./plugin-servers.ts";
import { fetchPackages, removeSkills, sessionPluginsDir, type SkillPackage, writeSkills } from "./skills.ts";
import { NothingToResume, resolveWorkdir } from "./workdir.ts";
import { fallbackPackages, nativeSkillAliases, resolveSkillAlias } from "./native-skills.ts";
import type { NativePlugins } from "./plugins.ts";
import { removeMemoryFiles, writeMemoryFiles } from "./memory.ts";
import { copyAttachments } from "./attachments.ts";
import { NATIVE_PLUGINS, type Sandbox, type Worker } from "./sandbox/worker.ts";
import { connectTools, type SessionTools } from "./sandbox/tools.ts";
import { serveInWorker } from "./sandbox/plugins.ts";
import { CODEX_MARKETPLACE, codexMarketplace, fetchNativePlugin, nativePluginFolders, nativePluginViews } from "./sandbox/native-plugins.ts";
import { unverified } from "./sandbox/verified.ts";
import { type CredentialSource, type GrantChecks, GrantRelay, SUBSCRIPTION_PROVIDERS, type SubscriptionHarness } from "./subscriptions/relay.ts";

/** What a sandboxed runner can't give a worker yet. */
export const SANDBOX_UNSUPPORTED = "this runner's workers can't load skills yet: start it without them";

type Emit = (sessionId: string, event: HarnessEvent) => void;

export type SessionsOptions = {
  /** The container supervisor's sandbox: each session's CLI runs in a worker of its own. Without it, on this machine. */
  sandbox?: Sandbox;
  nativePlugins?: Pick<NativePlugins, "request">;
  claude?: Omit<ClaudeDeps, "allowBypass">;
  /** The machine's `codex` and the last detected version (older than `MIN_CODEX` starts nothing). Without it, Codex sessions are refused. */
  codex?: Pick<CodexDeps, "codexPath" | "env"> & { version: string | undefined };
  /** What no working directory may contain or sit inside (`machineConfigPaths`). */
  forbidden?: string[];
  /** Where each CLI session id's run folder is kept (mode 0600): only a known pair resumes. */
  resumeMap: string;
  /** False while Dispand can't take more events (the connection's backlog is full): no session starts. */
  accepting?: () => boolean;
  /** The `claude` version last detected (undefined if none): older than `MIN_CLAUDE` starts nothing. */
  claudeVersion: string | undefined;
  /**
   * Where skill packages come from and go: Dispand (`server`, the runner's `token`) and
   * `runnerStateDir()`. Without it, a start that asks for skills is refused.
   */
  skills?: { server: string; token: string; stateDir: string; fetch?: typeof fetchPackages };
  /**
   * Personal subscriptions: Dispand's checks of each grant, and the credential an enrollment
   * spends (undefined when this runner holds no such enrollment). Without it, a grant is refused.
   */
  personal?: {
    checks: GrantChecks;
    credential(harness: SubscriptionHarness, enrollmentId: string): CredentialSource | undefined;
    /** Tests only: where the provider's operations go. */
    upstream?: string;
  };
};

/** A personal action runs only in the container runner, in a gVisor worker: never on the bare install or under runc. */
export const PERSONAL_NEEDS_GVISOR = "this runner can't run this personal action: personal subscriptions run only in the container runner under gVisor";
/** A grant's session ends when its grant does: Dispand pauses the action. */
export const GRANT_ENDED = "this action's personal grant ended";
/** How long a grant waits for the runtime to confirm its run's previous worker is gone before it stays paused. */
export const TEARDOWN_WAIT_MS = 60_000;

/** The first Claude Code with `client_composed` (the SDK's documented minimum), which keeps remote text from running built-in commands. */
export const MIN_CLAUDE = "2.1.248";

/** Whether dotted version `v` is at least `min` (numeric parts; anything unparsable is too old). */
export function atLeast(v: string | undefined, min: string): boolean {
  const parts = (s: string) => s.split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
  if (!v) return false;
  const [a, b] = [parts(v), parts(min)];
  for (let i = 0; i < b.length; i++) {
    const x = a[i] ?? 0;
    if (Number.isNaN(x)) return false;
    if (x !== b[i]) return x > b[i]!;
  }
  return true;
}

/**
 * The run folders of the CLI sessions this runner started, by CLI session id. Resuming reuses
 * an existing folder, so the server's word alone isn't enough: the pair must be one the runner
 * recorded itself.
 */
class ResumeMap {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  private read(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }

  record(cliSessionId: string, runKey: string): void {
    const map = this.read();
    if (map[cliSessionId] === runKey) return;
    map[cliSessionId] = runKey;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    // Durable before the session id is reported: a resume after a crash must find it.
    writeDurable(this.path, JSON.stringify(map), 0o600);
  }

  /** The one rule for resuming, for both the folder and the CLI's `resume`. */
  resumable(start: SessionStart): boolean {
    const id = start.resumeCliSessionId;
    return !!id && this.read()[id] === start.cwd.runKey;
  }
}

/** The sessions running on this machine, driven by the server's messages. */
/** The error a session ends with when Dispand stops it. */
export const STOPPED = "Stopped";

/** Retries until the runtime confirms the worker is gone: until then, its session hasn't ended. */
async function removed(worker: Worker, named: string): Promise<void> {
  for (;;) {
    try {
      return await worker.remove();
    } catch (err) {
      console.error(`dispand-runner: ${named}: its worker isn't gone yet, retrying:`, (err as Error).message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

export class Sessions {
  private readonly live = new Map<string, HarnessSession>();
  /** Each live session's run folder: a chat message's files are copied there. */
  private readonly folders = new Map<string, string>();
  /** The skill packages each live session got as files (`writeSkills`), not through a native installation. */
  private readonly staged = new Map<string, SkillPackage[]>();
  private readonly stopping = new Set<string>();
  // No parameter properties: `node src/main.ts` runs this file with type stripping only.
  private readonly config: RunnerConfig;
  private readonly emit: Emit;
  private readonly options: SessionsOptions;
  private readonly resumes: ResumeMap;
  /** Bumped by `stopAll`, with its message: a start that was still preparing when it ran never launches. */
  private stops = 0;
  private shuttingDown = false;
  private readonly inFlight = new Set<Promise<void>>();
  /** Sessions that ended, until what they leave behind is removed. */
  private readonly ending = new Set<Promise<unknown>>();
  /** Sessions between their start message and their launch: they count against the limit too. */
  private readonly starting = new Map<string, SessionStart>();
  private stopMessage = "";
  /** Each grant's relay and session, until that session has ended. */
  private readonly grants = new Map<string, { relay: GrantRelay; sessionId: string; runKey: string; worker?: Worker; retire: () => void }>();
  /** Grants that ended here, so a start that carries one again (or still prepares) never runs on it. */
  private readonly endedGrants = new Set<string>();
  /** Sessions between turns (after `turn-end`): a grant that ends there retires the worker, which is no failure. */
  private readonly idle = new Set<string>();
  /** Each run's session that holds a grant, until the runtime confirms its worker gone. */
  private readonly grantRuns = new Map<string, Promise<unknown>>();

  constructor(config: RunnerConfig, emit: Emit, options: SessionsOptions) {
    this.config = config;
    this.emit = emit;
    this.options = options;
    this.resumes = new ResumeMap(options.resumeMap);
  }

  /** Sessions already told "not running" on this connection, so a stream of messages is one event. */
  private readonly toldNotRunning = new Set<string>();

  /** A new connection to Dispand: "not running" may be said once more per session. */
  connected(): void {
    this.toldNotRunning.clear();
  }

  private notRunning(sessionId: string) {
    if (this.toldNotRunning.has(sessionId)) return;
    // Backlog full: dropped (told later, once it has room), logged once per full spell.
    if (this.options.accepting && !this.options.accepting()) {
      if (!this.droppedWhileFull) console.error("dispand-runner: dropping messages for sessions not running here while the backlog is full");
      this.droppedWhileFull = true;
      return;
    }
    this.droppedWhileFull = false;
    if (this.toldNotRunning.size >= MAX_LIVE_SESSIONS) this.toldNotRunning.clear();
    this.toldNotRunning.add(sessionId);
    this.emit(sessionId, SESSION_NOT_RUNNING);
  }
  private droppedWhileFull = false;

  /**
   * A grant is over (`grant.end`): its relay closes its streams and denies every later request,
   * and its worker goes now, with every process in it, without waiting for another grant.
   */
  endGrant(grantId: string): void {
    if (this.endedGrants.size >= 4 * MAX_LIVE_SESSIONS) this.endedGrants.delete(this.endedGrants.values().next().value!);
    this.endedGrants.add(grantId);
    const held = this.grants.get(grantId);
    if (!held) return;
    console.log(`dispand-runner: grant ${grantId} of session ${held.sessionId} ended: its relay closed, its worker stops`);
    held.relay.revoke();
    const session = this.live.get(held.sessionId);
    if (session) {
      this.stopping.add(held.sessionId);
      // Its stop reports `session-ended` only; a replacement of the same id reports its own errors.
      if (this.idle.has(held.sessionId)) held.retire();
      session.stop(GRANT_ENDED);
    }
    void held.worker?.remove().catch(() => undefined);
  }

  ids(): string[] {
    return [...this.live.keys()];
  }

  /** For a runner that is stopping: no session starts, every live CLI is aborted silently; settles once they have exited. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    // Starts still preparing finish first: they see the shutdown, clean up, and launch nothing.
    await Promise.allSettled([...this.inFlight]);
    const all = [...this.live.values()];
    for (const session of all) session.abort();
    await Promise.allSettled(all.map((s) => s.done));
    // Then what ended sessions leave to remove (their memory files, their skills).
    await Promise.allSettled([...this.ending]);
  }

  /** Ends every live session now with `message` as its error, stopping their CLIs. */
  stopAll(message: string): void {
    this.stops += 1;
    this.stopMessage = message;
    for (const session of this.live.values()) session.stop(message);
  }

  /** A sandboxed live session's tools, narrowed with its permissions. */
  private readonly bridges = new Map<string, (servers: { name: string }[]) => void>();

  /** Each session's messages, in order: one session's slow start (fetching its skills) holds up only its own messages. */
  private readonly queues = new Map<string, Promise<void>>();

  /**
   * Handles a server message after the earlier ones for the same session; messages for other
   * sessions don't wait for it. Settles once this one is handled.
   */
  handle(msg: Exclude<ServerToRunner, { type: "ack" | "clis.request" | "tool.discover" | "tool.call" | "plugin.request" | "models.request" | "commands.request" | "subscription.enrolled" | "grant.checked" | "grant.end" }>): Promise<void> {
    if (msg.type === "session.permissions") {
      const preparing = this.starting.get(msg.sessionId);
      if (preparing) {
        preparing.mcpServers = preparing.mcpServers.filter((ref) => {
          if (ref.type === "http") return true;
          const current = msg.servers.find((s) => s.name === ref.name);
          if (!current) return false;
          const denied = [...new Set([...(ref.denied ?? []), ...(current.denied ?? [])])];
          ref.denied = denied;
          ref.unasked = (ref.unasked ?? []).filter((action) => current.unasked.includes(action) && !denied.includes(action));
          return true;
        });
        return Promise.resolve();
      }
    }
    const id = msg.type === "session.start" ? msg.start.sessionId : msg.sessionId;
    // A live session's stop, interrupt or narrowed permissions never wait behind a message whose files are still being fetched.
    if ((msg.type === "session.stop" || msg.type === "session.interrupt" || msg.type === "session.permissions") && this.live.has(id)) return this.dispatch(msg);
    const before = this.queues.get(id);
    // Nothing before it: handled now, as the message arrives.
    const done = before ? before.then(() => this.dispatch(msg)) : this.dispatch(msg);
    const settled = done.catch(() => undefined);
    this.queues.set(id, settled);
    void settled.then(() => {
      if (this.queues.get(id) === settled) this.queues.delete(id);
    });
    return done;
  }

  /** Whether another session of this run is starting, or live until its worker is confirmed gone. */
  private runInUse(runKey: string, sessionId: string): boolean {
    for (const [id, other] of this.starting) if (id !== sessionId && other.cwd.runKey === runKey) return true;
    for (const [id, folder] of this.folders) if (id !== sessionId && basename(folder) === runKey) return true;
    return false;
  }

  stagedPackages(sessionId: string): SkillPackage[] {
    return this.staged.get(sessionId) ?? [];
  }

  async commands(sessionId: string) {
    const session = this.live.get(sessionId);
    if (!session?.commands) throw new Error("Session unavailable");
    return session.commands();
  }

  private async dispatch(msg: Exclude<ServerToRunner, { type: "ack" | "clis.request" | "tool.discover" | "tool.call" | "plugin.request" | "models.request" | "commands.request" | "subscription.enrolled" | "grant.checked" | "grant.end" }>): Promise<void> {
    if (msg.type === "session.start") {
      const started = this.start(msg.start);
      this.inFlight.add(started);
      return started.finally(() => this.inFlight.delete(started));
    }
    const session = this.live.get(msg.sessionId);
    if (msg.type === "session.interrupt" && msg.turnId !== undefined && msg.requestId !== undefined) {
      let outcome: "requested" | "stale" | "failed" = "stale";
      if (session) {
        try { outcome = await session.interrupt(msg.turnId) ?? "failed"; }
        catch { outcome = "failed"; }
      }
      return this.emit(msg.sessionId, { type: "interrupt-result", turnId: msg.turnId, requestId: msg.requestId, outcome });
    }
    // Not running (ended, stopped, never started here): said once per session per connection,
    // which is what lets Dispand resume a lost session; nothing while the backlog is full.
    // A stop for a session that isn't here has nothing to end, and nothing for Dispand to resume.
    if (!session) return msg.type === "session.stop" ? this.emit(msg.sessionId, { type: "session-ended" }) : this.notRunning(msg.sessionId);
    if (msg.type === "session.stop") { this.stopping.add(msg.sessionId); return session.stop(STOPPED); }
    if (msg.type === "session.permissions") {
      session.narrowPermissions?.(msg.servers);
      this.bridges.get(msg.sessionId)?.(msg.servers);
    }
    else if (msg.type === "session.send") {
      // Its files are in place before the text that names them reaches the CLI (this session's messages wait meanwhile).
      const cwd = this.folders.get(msg.sessionId);
      const failed = msg.files?.length && cwd ? await copyAttachments(cwd, msg.files, this.options.skills) : undefined;
      // Stopped while its files were fetched: the message goes nowhere.
      if (this.live.get(msg.sessionId) !== session || this.stopping.has(msg.sessionId)) return;
      const text = failed ? `${msg.text}\n\n${failed}` : msg.text;
      if (!msg.steer) return session.send(text);
      const { turnId, requestId } = msg.steer;
      // Not awaited: an answer the turn waits for must not queue behind it.
      const outcome = session.steer ? session.steer(turnId, text) : (session.send(text), Promise.resolve("queued" as const));
      void outcome.then((outcome) => this.emit(msg.sessionId, { type: "steer-result", turnId, requestId, outcome }));
    }
    else if (msg.type === "session.answer") session.answer(msg.questionId, msg.answer);
    else await session.interrupt();
  }

  private async start(start: SessionStart) {
    let recorded = false;
    /** How the launched session ended, for its log line: its last result or error, never their words. */
    let outcome = "exited";
    /** A resumed CLI that has reported nothing yet: failing now, it didn't take its transcript. */
    let unproven = false;
    /** Set when this start's own worker retired between turns (its grant ended). */
    let retired = false;
    const emit = (event: HarnessEvent) => {
      if (event.type === "error" && retired) return;
      if (event.type === "turn-end") this.idle.add(start.sessionId);
      else if (event.type === "turn-start") this.idle.delete(start.sessionId);
      if (event.type !== "error") unproven = false;
      // shortcut: any failure of a resumed CLI before its first event counts (a sign-in lapse too), the next start is then fresh, told the conversation; classify per CLI if that costs a transcript that mattered.
      else if (unproven && !this.stopping.has(start.sessionId) && this.stops === stops) event = { ...event, kind: "cannot-resume" };
      if (event.type === "cli-session") {
        this.resumes.record(event.cliSessionId, start.cwd.runKey);
        recorded = true;
      }
      if (event.type === "result") outcome = "succeeded";
      if (event.type === "error") outcome = "failed";
      this.emit(start.sessionId, event);
    };
    // Stopping: nothing starts, and nothing is reported (Dispand starts it again after the restart).
    if (this.shuttingDown) return;
    // Every refusal known in advance comes before the run folder exists.
    // A personal session retiring (its grant ended) is no live one for its next grant's start: that start waits for its teardown below.
    if ((this.live.has(start.sessionId) && !(start.grant && this.stopping.has(start.sessionId))) || this.starting.has(start.sessionId)) return emit(SESSION_ALREADY_RUNNING);
    // `hello` lists every live session, up to the protocol's limit.
    if (this.live.size + this.starting.size >= MAX_LIVE_SESSIONS) {
      return emit({ type: "error", message: `this runner already runs ${MAX_LIVE_SESSIONS} sessions, at most ${MAX_LIVE_SESSIONS} at once` });
    }
    const refusal = "Dispand unreachable: the runner's backlog is full, try again once it has caught up";
    if (this.options.accepting && !this.options.accepting()) return emit({ type: "error", message: refusal });
    if (start.skills.length > 0 && !this.options.skills) return emit({ type: "error", message: "this runner can't load skills" });
    // Keep the checked executable for this start if a CLI refresh finishes while staging files.
    const { codex, claude, claudeVersion } = this.options;
    if (start.harness === "codex") {
      const problem = codex ? codexRequired(codex.version, start.restricted) : "Codex isn't installed on this machine, or doesn't run";
      if (problem) return emit({ type: "error", message: problem });
      if (start.restricted && codex!.version !== RESTRICTED_CODEX) {
        console.warn(`dispand-runner: restricted session ${start.sessionId} runs on Codex ${codex!.version}, its switches were checked on ${RESTRICTED_CODEX}: run restricted-tools.test.ts on this version`);
      }
    } else if (!atLeast(claudeVersion, MIN_CLAUDE)) {
      return emit({ type: "error", message: `Claude Code ≥ ${MIN_CLAUDE} required (found ${claudeVersion ?? "none"}): update claude on this machine` });
    }
    if (start.permissionMode === "bypassPermissions" && !this.config.allowBypass) {
      return emit({ type: "error", message: new BypassRefused().message });
    }
    // shortcut: a worker has no route yet to runner tools, MCP servers, skills or Codex's Job server; the supervisor relays them in the next slice.
    const sandbox = this.options.sandbox;
    if (sandbox && start.skills.length > 0) {
      return emit({ type: "error", message: SANDBOX_UNSUPPORTED });
    }
    // A personal action: only in a gVisor worker whose one model route is its grant's relay, on an enrollment this runner holds.
    let personal: { grant: SessionStart["grant"] & object; harness: SubscriptionHarness; credential: CredentialSource; since: { mono: number; wall: number } } | undefined;
    if (start.grant) {
      const grant = start.grant;
      // Its first deadline counts from its arrival, before any wait below.
      const since = { mono: performance.now(), wall: Date.now() };
      const options = this.options.personal;
      const harness = start.harness;
      if (!options || !sandbox || sandbox.runtime !== "runsc" || !Object.hasOwn(SUBSCRIPTION_PROVIDERS, harness)) return emit({ type: "error", message: PERSONAL_NEEDS_GVISOR });
      const credential = options.credential(harness, grant.enrollmentId);
      if (!credential) return emit({ type: "error", message: "this runner holds no such enrollment: enroll the subscription again" });
      if (this.endedGrants.has(grant.id) || this.grants.has(grant.id)) return emit({ type: "error", message: GRANT_ENDED });
      // The run's previous grant ends here, and its worker must be confirmed gone, its whole process tree with it: else this one stays paused.
      for (const [id, held] of this.grants) if (held.runKey === start.cwd.runKey) this.endGrant(id);
      const previous = this.grantRuns.get(start.cwd.runKey);
      // Registered while it waits: a permission update narrows this start (`handle`), never the retiring worker of the same id.
      this.starting.set(start.sessionId, start);
      const gone = previous ? await Promise.race([previous.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), TEARDOWN_WAIT_MS).unref())]) : true;
      this.starting.delete(start.sessionId);
      if (!gone) return emit({ type: "error", message: "this run's previous worker isn't confirmed gone yet: the action stays paused" });
      if (this.shuttingDown) return;
      personal = { grant, harness, credential, since };
    }
    // One worker per run: a run whose session (by any id) is starting or live isn't attached to a second one.
    if (sandbox && this.runInUse(start.cwd.runKey, start.sessionId)) {
      return emit({ type: "error", message: "this run's previous session is still running on this runner: try again once it has ended" });
    }
    // A mode not verified on this host's runtime: refused before its worker starts, never retried in bypass.
    const notVerified = sandbox ? unverified(sandbox.runtime, start) : undefined;
    if (notVerified) return emit({ type: "error", message: notVerified });
    // A plugin's stdio servers, launched once the start is registered (in the `try` below): until then they are left out of the checks.
    const launches = new Map<string, Launch>();
    let launched = false;
    // The session's MCP servers: a runner tool must be one of this machine's own (ToolRefused).
    let claudeMcp: ReturnType<typeof mcpConfigFor> = {};
    let codexMcp: ReturnType<typeof codexMcpServers> | undefined;
    const prepareMcp = () => {
      claudeMcp = {};
      codexMcp = undefined;
      // Restricted: no server of the start's and not the Job's tools server, only the Job's own (`job`).
      const refs = start.restricted
        ? withJobServer([], this.config.server, start.jobToken).filter((r) => r.name === JOB_SERVER_NAME)
        : withJobServer(start.mcpServers.filter((r) => launched || r.type !== "plugin"), this.config.server, start.jobToken);
      // A Job's runner tools hand their files to that Job, at this runner's own server.
      const options = { launches, ...(start.jobToken === undefined ? {} : { files: { url: new URL(JOB_FILES_PATH, this.config.server).href, token: start.jobToken } }) };
      if (refs.length > 0) {
        // In a sandbox, the supervisor connects to them all (`sandbox/tools.ts`), from the one form.
        if (start.harness === "codex" && !sandbox) codexMcp = codexMcpServers(refs, this.config.mcpServers, options);
        else claudeMcp = mcpConfigFor(refs, this.config.mcpServers, options);
      }
    };
    try {
      prepareMcp();
    } catch (err) {
      return emit({ type: "error", message: (err as Error).message });
    }
    const stops = this.stops;
    const resuming = this.resumes.resumable(start);
    if (start.resumeCliSessionId !== undefined && !resuming) {
      return emit({ type: "error", kind: "cannot-resume", message: "can't resume: this runner didn't run that CLI session in that folder" });
    }
    this.starting.set(start.sessionId, start);
    let created: string | undefined;
    let worker: Worker | undefined;
    let relay: GrantRelay | undefined;
    let sessionTools: SessionTools | undefined;
    const pluginWorkers: { remove(): Promise<void> }[] = [];
    // The session's skill packages, written again at every start or resume, gone when it ends.
    const skills = this.options.skills;
    const pluginsDir = skills && start.skills.length > 0 ? sessionPluginsDir(skills.stateDir, start.sessionId) : undefined;
    // Its native plugins' views (managed servers left out), beside its skill packages: gone with them.
    const viewsDir = skills && start.nativePlugins?.length ? join(sessionPluginsDir(skills.stateDir, start.sessionId), "..", "native") : undefined;
    const dropSkills = async () => {
      if (viewsDir) await removeSkills(viewsDir).catch(() => undefined);
      if (pluginsDir) await removeSkills(pluginsDir).catch(() => undefined);
    };
    // A folder this start created, while no CLI session is filed under it, goes again if the start fails.
    let memoryIn: string | undefined;
    const cleanUp = () => {
      if (relay) {
        relay.revoke();
        if (this.grants.get(relay.grantId)?.relay === relay) this.grants.delete(relay.grantId);
      }
      void sessionTools?.close();
      // A start cancelled after its worker was set up: its route and network go too, and its plugin servers' workers.
      void worker?.remove().catch(() => undefined);
      for (const served of pluginWorkers.splice(0)) void served.remove().catch(() => undefined);
      if (created && !recorded) rmSync(created, { recursive: true, force: true });
      const memory = !(created && !recorded) && memoryIn ? removeMemoryFiles(memoryIn).catch(() => undefined) : undefined;
      return Promise.all([memory, dropSkills()]).then(() => undefined);
    };
    try {
      // Fetched, checked against this machine's record and written before the run folder exists, the start registered meanwhile.
      for (const ref of start.restricted ? [] : start.mcpServers) {
        if (ref.type !== "plugin") continue;
        if (!skills) throw new ToolRefused("this runner can't start plugin servers");
        const launch = await launchPluginServer(this.config, skills.stateDir, ref, (id) => fetchPlugin(skills.server, skills.token, id));
        if (!sandbox) launches.set(ref.name, launch);
        else {
          // Its code runs in a worker of its own, which goes with the session.
          const served = await serveInWorker(sandbox, launch, this.config.roots[0]!);
          pluginWorkers.push(served);
          launches.set(ref.name, served.launch);
        }
      }
      launched = true;
      // Fetched before the run folder exists: a failed fetch leaves nothing behind.
      const packages = skills && pluginsDir && !start.restricted ? await (skills.fetch ?? fetchPackages)(skills.server, skills.token, start.skills) : [];
      const cwd = await resolveWorkdir(this.config, start.cwd, this.options.forbidden, resuming);
      if (!resuming) created = cwd;
      // Its worker mounts the run folder and the conversation's CLI home, next to the runs.
      // A personal one: a fresh worker for its grant, whose only model route is that grant's relay.
      if (personal) {
        // Ended, or taken by another start, while this one prepared: checked as it is reserved, with no wait in between.
        if (this.endedGrants.has(personal.grant.id) || this.grants.has(personal.grant.id)) throw new Error(GRANT_ENDED);
        relay = new GrantRelay({ grant: personal.grant, harness: personal.harness, checks: this.options.personal!.checks, credential: personal.credential, since: personal.since, onLapse: () => this.endGrant(personal!.grant.id), ...(this.options.personal!.upstream ? { upstream: this.options.personal!.upstream } : {}) });
        this.grants.set(relay.grantId, { relay, sessionId: start.sessionId, runKey: start.cwd.runKey, retire: () => void (retired = true) });
      }
      // Its native plugins (the image only: the bare install keeps Skillshare), each checked against the digest its start named.
      const stored = sandbox && skills && !start.restricted && start.nativePlugins?.length
        ? await nativePluginFolders(skills.stateDir, start.nativePlugins, fetchNativePlugin(skills.server, skills.token))
        : [];
      // Derived at each start from the stored files: a server registered since is left out too.
      const plugins = stored.length ? await nativePluginViews(viewsDir!, stored, start.nativePlugins!, start.harness === "codex" ? { cwd } : undefined) : [];
      // Codex installs them from a marketplace listing them, written beside their views.
      const market = plugins.length && start.harness === "codex" ? await codexMarketplace(viewsDir!, plugins) : undefined;
      worker = sandbox ? await sandbox.worker(cwd, join(this.config.roots[0]!, "cli", start.cwd.runKey), [], { plugins, ...(market ? { marketplace: market.dir } : {}), ...(relay ? { relay: relay.handle } : {}) }) : undefined;
      if (relay) {
        this.grants.get(relay.grantId)!.worker = worker;
        if (relay.revoked || relay.expired) throw new Error(GRANT_ENDED);
      }
      // A Job's memory as Dispand sent it now (a resume gets it again, as it is), gone when the session ends.
      if (start.jobToken !== undefined && !start.restricted) {
        memoryIn = cwd;
        await writeMemoryFiles(cwd, start.memory ?? []);
      }
      // Checked again right before launching: shutdown or stopAll may have run, or the backlog filled, meanwhile.
      if (this.shuttingDown) return cleanUp();
      if (this.stops !== stops) {
        cleanUp();
        return emit({ type: "error", message: this.stopMessage });
      }
      if (this.options.accepting && !this.options.accepting()) {
        cleanUp();
        return emit({ type: "error", message: refusal });
      }
      const native = packages.some((pkg) => pkg.nativePlugin) && this.options.nativePlugins
        ? await this.options.nativePlugins.request({ action: "list" }) : {};
      const fallback = fallbackPackages(packages, start.harness, native);
      const aliases = nativeSkillAliases(packages, start.harness, native);
      // Codex resolves aliases itself, after its exact catalog names (a scope can share an alias).
      const resolve = (text: string) => start.harness === "codex" ? text : resolveSkillAlias(text, aliases);
      start.prompt = resolve(start.prompt);
      const pluginRoots = pluginsDir ? await writeSkills(pluginsDir, fallback) : [];
      // Writing them took time: check again that the runner may still launch.
      if (this.shuttingDown) return cleanUp();
      if (this.stops !== stops || (this.options.accepting && !this.options.accepting())) {
        cleanUp();
        return emit({ type: "error", message: this.stops !== stops ? this.stopMessage : refusal });
      }
      // A permission update may have narrowed the start while its files were fetched/written.
      prepareMcp();
      // A sandboxed session's tools: connected here, offered over the CLI's own channel, never to the worker.
      if (sandbox) {
        const own = new URL(this.config.server).origin;
        sessionTools = await connectTools(claudeMcp, (url) => (url.origin === own ? Promise.resolve(fetch) : sandbox.fetchFor(url)));
        // A narrowing that came while they connected counts, and so do stops.
        prepareMcp();
        sessionTools.keep(Object.keys(claudeMcp));
        claudeMcp = {};
        if (this.shuttingDown) return cleanUp();
        if (this.stops !== stops || (this.options.accepting && !this.options.accepting())) {
          cleanUp();
          return emit({ type: "error", message: this.stops !== stops ? this.stopMessage : refusal });
        }
      }
      // Where each plugin server starts: paths in its arguments are read from there by the guards.
      const serverDirs = Object.fromEntries([...launches].map(([name, launch]) => [name, launch.cwd]));
      const jobServer = start.jobToken === undefined ? {} : { jobServer: JOB_SERVER_NAME, ...(start.unasked ? { unasked: start.unasked } : {}) };
      unproven = resuming;
      // Ended, or past its first deadline, while it prepared: it never launches.
      if (relay && (relay.revoked || relay.expired)) throw new Error(GRANT_ENDED);
      const session =
        start.harness === "codex"
          ? startCodexSession(start, cwd, emit, {
              codexPath: codex!.codexPath,
              ...(codex!.env ? { env: codex!.env } : {}),
              ...(worker ? { launch: worker.launch, env: { ...codex!.env, CODEX_HOME: worker.codexHome }, ...(worker.openaiBaseUrl ? { modelBaseUrl: worker.openaiBaseUrl } : {}) } : {}),
              ...(relay && worker?.relayUrl ? { subscriptionRelay: { url: worker.relayUrl, grant: relay.token } } : {}),
              ...(sessionTools ? { sessionTools } : {}),
              allowBypass: this.config.allowBypass,
              secrets: this.options.forbidden ?? [],
              ...(pluginsDir ? { pluginsDir } : {}),
              pluginRoots,
              ...(market ? { nativePlugins: { marketplacePath: CODEX_MARKETPLACE, names: market.names } } : {}),
              serverDirs,
              skillAliases: aliases,
              ...(codexMcp ? { mcp: codexMcp } : {}),
              ...jobServer,
            })
          : startClaudeSession(start, cwd, emit, {
              ...claude,
              // Loaded whole by Claude Code from their read-only mounts.
              ...(plugins.length ? { nativePlugins: plugins.map((p) => `${NATIVE_PLUGINS}/${p.pluginId}`) } : {}),
              ...(worker ? { launch: worker.launch, env: { ...claude?.env, CLAUDE_CONFIG_DIR: worker.claudeConfigDir } } : {}),
              ...(relay && worker?.relayUrl ? { subscriptionRelay: { url: worker.relayUrl, grant: relay.token } } : {}),
              secrets: this.options.forbidden ?? [],
              allowBypass: this.config.allowBypass,
              pluginRoots,
              serverDirs,
              mcpServers: claudeMcp,
              ...(sessionTools ? { sessionTools } : {}),
              ...jobServer,
            });
      const send = session.send.bind(session);
      session.send = (text) => send(resolve(text));
      const steer = session.steer?.bind(session);
      if (steer) session.steer = (turnId, text) => steer(turnId, resolve(text));
      this.live.set(start.sessionId, session);
      // Its tools narrow with the session: servers by URL stay, the others only while still granted.
      if (sessionTools) {
        const tools = sessionTools;
        const byUrl = withJobServer(start.mcpServers.filter((ref) => ref.type === "http"), this.config.server, start.jobToken).map((ref) => ref.name);
        this.bridges.set(start.sessionId, (servers) => tools.keep([...byUrl, ...servers.map((s) => s.name)]));
      }
      this.folders.set(start.sessionId, cwd);
      this.staged.set(start.sessionId, fallback);
      this.toldNotRunning.delete(start.sessionId);
      // One line at the start and one at the end: ids, the harness and the outcome only (no prompt, result or error text).
      const named = `session ${start.sessionId} of run ${start.cwd.runKey} (${start.harness})`;
      console.log(`dispand-runner: ${named} started`);
      // Shutdown waits for it: memory files must not outlive their session.
      const ended = session.done
        // Its grant ends with it: no request goes through its relay again.
        .finally(() => relay?.revoke())
        // Ended only once the runtime confirms its worker, and every process in it, is gone.
        .finally(() => worker && removed(worker, named))
        .finally(() => {
          return cleanUp();
        })
        .catch(() => undefined)
        .finally(() => {
          this.live.delete(start.sessionId);
          this.bridges.delete(start.sessionId);
          this.folders.delete(start.sessionId);
          this.staged.delete(start.sessionId);
          this.ending.delete(ended);
          if (this.grantRuns.get(start.cwd.runKey) === ended) this.grantRuns.delete(start.cwd.runKey);
          const stopped = this.stopping.delete(start.sessionId);
          this.idle.delete(start.sessionId);
          console.log(`dispand-runner: ${named} ended: ${stopped ? "stopped" : this.shuttingDown ? "aborted" : outcome}`);
          if (stopped && !this.shuttingDown) emit({ type: "session-ended" });
        });
      this.ending.add(ended);
      if (relay) this.grantRuns.set(start.cwd.runKey, ended);
    } catch (err) {
      void worker?.remove().catch(() => undefined);
      cleanUp();
      // WorkdirRefused and the like: the server learns why the session didn't start.
      emit({ type: "error", ...(err instanceof NothingToResume ? { kind: "cannot-resume" as const } : {}), message: err instanceof Error ? err.message : String(err) });
    } finally {
      this.starting.delete(start.sessionId);
    }
  }
}
