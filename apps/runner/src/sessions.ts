import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  type HarnessEvent,
  MAX_LIVE_SESSIONS,
  type ServerToRunner,
  SESSION_ALREADY_RUNNING,
  SESSION_NOT_RUNNING,
  type SessionStart,
} from "@dispand/runner-protocol";
import { BypassRefused, type ClaudeDeps, startClaudeSession } from "./claude.ts";
import { type CodexDeps, startCodexSession } from "./codex/session.ts";
import { codexRequired } from "./codex/version.ts";
import { writeDurable } from "./durable.ts";
import type { RunnerConfig } from "./config.ts";
import type { HarnessSession } from "./outcome.ts";
import { codexMcpServers, mcpConfigFor } from "./mcp.ts";
import { fetchPackages, removeSkills, sessionPluginsDir, writeSkills } from "./skills.ts";
import { resolveWorkdir } from "./workdir.ts";

type Emit = (sessionId: string, event: HarnessEvent) => void;

export type SessionsOptions = {
  claude?: Omit<ClaudeDeps, "allowBypass">;
  /** The machine's `codex` and the version found at start (older than `MIN_CODEX` starts nothing). Without it, Codex sessions are refused. */
  codex?: Pick<CodexDeps, "codexPath" | "env"> & { version: string | undefined };
  /** What no working directory may contain or sit inside (`machineConfigPaths`). */
  forbidden?: string[];
  /** Where each CLI session id's run folder is kept (mode 0600): only a known pair resumes. */
  resumeMap: string;
  /** False while Dispand can't take more events (the connection's backlog is full): no session starts. */
  accepting?: () => boolean;
  /** The `claude` version found at start (undefined if none): older than `MIN_CLAUDE` starts nothing. */
  claudeVersion: string | undefined;
  /**
   * Where skill packages come from and go: Dispand (`server`, the runner's `token`) and
   * `runnerStateDir()`. Without it, a start that asks for skills is refused.
   */
  skills?: { server: string; token: string; stateDir: string; fetch?: typeof fetchPackages };
};

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

export class Sessions {
  private readonly live = new Map<string, HarnessSession>();
  // No parameter properties: `node src/main.ts` runs this file with type stripping only.
  private readonly config: RunnerConfig;
  private readonly emit: Emit;
  private readonly options: SessionsOptions;
  private readonly resumes: ResumeMap;
  /** Bumped by `stopAll`, with its message: a start that was still preparing when it ran never launches. */
  private stops = 0;
  private shuttingDown = false;
  private readonly inFlight = new Set<Promise<void>>();
  /** Sessions between their start message and their launch: they count against the limit too. */
  private readonly starting = new Set<string>();
  private stopMessage = "";

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
    this.emit(sessionId, { type: "error", message: SESSION_NOT_RUNNING });
  }
  private droppedWhileFull = false;

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
  }

  /** Ends every live session now with `message` as its error, stopping their CLIs. */
  stopAll(message: string): void {
    this.stops += 1;
    this.stopMessage = message;
    for (const session of this.live.values()) session.stop(message);
  }

  /** Each session's messages, in order: one session's slow start (fetching its skills) holds up only its own messages. */
  private readonly queues = new Map<string, Promise<void>>();

  /**
   * Handles a server message after the earlier ones for the same session; messages for other
   * sessions don't wait for it. Settles once this one is handled.
   */
  handle(msg: Exclude<ServerToRunner, { type: "ack" | "tool.discover" }>): Promise<void> {
    const id = msg.type === "session.start" ? msg.start.sessionId : msg.sessionId;
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

  private async dispatch(msg: Exclude<ServerToRunner, { type: "ack" | "tool.discover" }>): Promise<void> {
    if (msg.type === "session.start") {
      const started = this.start(msg.start);
      this.inFlight.add(started);
      return started.finally(() => this.inFlight.delete(started));
    }
    const session = this.live.get(msg.sessionId);
    // Not running (ended, stopped, never started here): said once per session per connection,
    // which is what lets Dispand resume a lost session; nothing while the backlog is full.
    // A stop for a session that isn't here has nothing to end, and nothing for Dispand to resume.
    if (!session) return msg.type === "session.stop" ? undefined : this.notRunning(msg.sessionId);
    if (msg.type === "session.stop") return session.stop(STOPPED);
    if (msg.type === "session.send") session.send(msg.text);
    else if (msg.type === "session.answer") session.answer(msg.questionId, msg.answer);
    else await session.interrupt();
  }

  private async start(start: SessionStart) {
    let recorded = false;
    const emit = (event: HarnessEvent) => {
      if (event.type === "cli-session") {
        this.resumes.record(event.cliSessionId, start.cwd.runKey);
        recorded = true;
      }
      this.emit(start.sessionId, event);
    };
    // Stopping: nothing starts, and nothing is reported (Dispand starts it again after the restart).
    if (this.shuttingDown) return;
    // Every refusal known in advance comes before the run folder exists.
    if (this.live.has(start.sessionId) || this.starting.has(start.sessionId)) return emit({ type: "error", message: SESSION_ALREADY_RUNNING });
    // `hello` lists every live session, up to the protocol's limit.
    if (this.live.size + this.starting.size >= MAX_LIVE_SESSIONS) {
      return emit({ type: "error", message: `this runner already runs ${MAX_LIVE_SESSIONS} sessions, at most ${MAX_LIVE_SESSIONS} at once` });
    }
    const refusal = "Dispand unreachable: the runner's backlog is full, try again once it has caught up";
    if (this.options.accepting && !this.options.accepting()) return emit({ type: "error", message: refusal });
    if (start.skills.length > 0 && !this.options.skills) return emit({ type: "error", message: "this runner can't load skills" });
    if (start.harness === "codex") {
      const codex = this.options.codex;
      const problem = codex ? codexRequired(codex.version) : "Codex isn't installed on this machine, or doesn't run";
      if (problem) return emit({ type: "error", message: problem });
    } else if (!atLeast(this.options.claudeVersion, MIN_CLAUDE)) {
      return emit({ type: "error", message: `Claude Code ≥ ${MIN_CLAUDE} required (found ${this.options.claudeVersion ?? "none"}): update claude on this machine` });
    }
    if (start.permissionMode === "bypassPermissions" && !this.config.allowBypass) {
      return emit({ type: "error", message: new BypassRefused().message });
    }
    // The session's MCP servers: a runner tool must be one of this machine's own (ToolRefused).
    let claudeMcp: ReturnType<typeof mcpConfigFor> = {};
    let codexMcp: ReturnType<typeof codexMcpServers> | undefined;
    try {
      if (start.mcpServers.length > 0) {
        if (start.harness === "codex") codexMcp = codexMcpServers(start.mcpServers, this.config.mcpServers);
        else claudeMcp = mcpConfigFor(start.mcpServers, this.config.mcpServers);
      }
    } catch (err) {
      return emit({ type: "error", message: (err as Error).message });
    }
    const stops = this.stops;
    const resuming = this.resumes.resumable(start);
    if (start.resumeCliSessionId !== undefined && !resuming) {
      return emit({ type: "error", message: "can't resume: this runner didn't run that CLI session in that folder" });
    }
    this.starting.add(start.sessionId);
    let created: string | undefined;
    // The session's skill packages, written again at every start or resume, gone when it ends.
    const skills = this.options.skills;
    const pluginsDir = skills && start.skills.length > 0 ? sessionPluginsDir(skills.stateDir, start.sessionId) : undefined;
    const dropSkills = () => (pluginsDir ? removeSkills(pluginsDir).catch(() => undefined) : Promise.resolve());
    // A folder this start created, while no CLI session is filed under it, goes again if the start fails.
    const cleanUp = () => {
      if (created && !recorded) rmSync(created, { recursive: true, force: true });
      void dropSkills();
    };
    try {
      // Fetched before the run folder exists: a failed fetch leaves nothing behind.
      const packages = skills && pluginsDir ? await (skills.fetch ?? fetchPackages)(skills.server, skills.token, start.skills) : [];
      const cwd = await resolveWorkdir(this.config, start.cwd, this.options.forbidden, resuming);
      if (!resuming) created = cwd;
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
      const pluginRoots = pluginsDir ? await writeSkills(pluginsDir, packages) : [];
      // Writing them took time: check again that the runner may still launch.
      if (this.shuttingDown) return cleanUp();
      if (this.stops !== stops || (this.options.accepting && !this.options.accepting())) {
        cleanUp();
        return emit({ type: "error", message: this.stops !== stops ? this.stopMessage : refusal });
      }
      const session =
        start.harness === "codex"
          ? startCodexSession(start, cwd, emit, {
              codexPath: this.options.codex!.codexPath,
              ...(this.options.codex!.env ? { env: this.options.codex!.env } : {}),
              allowBypass: this.config.allowBypass,
              secrets: this.options.forbidden ?? [],
              ...(pluginsDir ? { pluginsDir } : {}),
              pluginRoots,
              ...(codexMcp ? { mcp: codexMcp } : {}),
            })
          : startClaudeSession(start, cwd, emit, {
              ...this.options.claude,
              allowBypass: this.config.allowBypass,
              pluginRoots,
              mcpServers: claudeMcp,
            });
      this.live.set(start.sessionId, session);
      this.toldNotRunning.delete(start.sessionId);
      void session.done.finally(() => {
        this.live.delete(start.sessionId);
        cleanUp();
      });
    } catch (err) {
      cleanUp();
      // WorkdirRefused and the like: the server learns why the session didn't start.
      emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      this.starting.delete(start.sessionId);
    }
  }
}
