import { skillCommands, skillInputs } from "./skills.ts";
// One Codex session: a `codex app-server` of its own, confined by Dispand's permission profile.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ASK, ASK_INPUT_SCHEMA, askDescription, type CliRuleCall, type HarnessEvent, offersAsk, type QuestionPayload, type SessionStart } from "@dispand/runner-protocol";
import { CODEX_DENIAL_UNSUPPORTED, nativePermissions, nativeRuleForCall } from "../native-permissions.ts";
import { codexDenied, codexDeniedEdit, sandboxDenied } from "../boundary.ts";
import { askChoices, askTool, BypassRefused, type HarnessSession, MAX_WAITING, MAX_WAITING_BYTES, ownerQuestions, REQUEST_APPROVAL, REQUEST_APPROVAL_DESCRIPTION, requestApproval, sessionOutcome } from "../outcome.ts";
import { toolPolicy } from "../tool-policy.ts";
import { fitsWhole } from "../sanitize.ts";
import { BYPASS_PROFILE, codexConfig, PROFILE } from "./config.ts";
import type { JsonValue } from "./protocol/serde_json/JsonValue.ts";
import type { RequestId } from "./protocol/RequestId.ts";
import type { ServerNotification } from "./protocol/ServerNotification.ts";
import type { ServerRequest } from "./protocol/ServerRequest.ts";
import type { FileUpdateChange } from "./protocol/v2/FileUpdateChange.ts";
import type { ThreadItem } from "./protocol/v2/ThreadItem.ts";
import type { Turn } from "./protocol/v2/Turn.ts";
import { CodexRpc } from "./rpc.ts";

export type CodexSessionStart = Extract<SessionStart, { harness: "codex" }>;

export type CodexDeps = {
  /** The signed-in `codex` binary to run. */
  codexPath: string;
  /** Its environment, from `codexEnv`. */
  env?: NodeJS.ProcessEnv;
  /** From the machine's config: whether `bypassPermissions` may be used. */
  allowBypass?: boolean;
  /** What the session may never read or write (`machineConfigPaths`). */
  secrets: string[];
  /** This session's skill packages (`skills.ts` `writeSkills`): the folder holding them, and each package's root. */
  pluginsDir?: string;
  pluginRoots?: string[];
  /** Where each plugin server of the session starts, by its name: paths in its arguments are read from there. */
  serverDirs?: Record<string, string>;
  /** The session's MCP servers (`mcp.ts` `codexMcpServers`): the config, and the header values for the app-server's environment. */
  mcp?: { servers: Record<string, JsonValue>; env: Record<string, string> };
  /** The name of Dispand's Job server among them, when the session has one: its tools run without a question. */
  jobServer?: string;
  /** With `jobServer`: the tools of the Job's tools server that run without a question, by their name there. */
  unasked?: string[];
  /** Dispand package aliases of verified native installations, resolved after exact catalog names. */
  skillAliases?: { alias: string; namespace: string }[];
};

const SUBMIT_OUTPUTS = "submit_outputs";
const SUBAGENT_ASKS_PARENT = "You are a subagent: you can't ask the person. Return your question to the agent that started you; it decides whether to ask them.";
export const PROFILE_REFUSED = "Codex didn't apply Dispand's permission profile: remove sandbox_mode from ~/.codex/config.toml";

/** A server of the session's that Codex's own config.toml already names: the two can't both run. */
export const mcpNameRefused = (name: string) => `Codex's config.toml already has an MCP server named ${name}, which this session needs: rename it in ~/.codex/config.toml`;

const isObject = (v: unknown): v is Record<string, JsonValue> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The name a tool item is reported under, or undefined for an item that isn't a tool call. */
function toolName(item: ThreadItem): string | undefined {
  if (item.type === "commandExecution") return "Shell";
  if (item.type === "fileChange") return "FileChange";
  if (item.type === "mcpToolCall") return `mcp__${item.server}__${item.tool}`;
  if (item.type === "dynamicToolCall") return item.tool;
  return undefined;
}

/**
 * Runs one Codex session: `codex app-server` in the run folder, with the `dispand` permission
 * profile (`config.ts`) and approval policy `untrusted`. Approvals and the agent's questions
 * become `question` events, within the boundary; the agent hands its results back through the
 * `submit_outputs` dynamic tool.
 */
export function startCodexSession(start: CodexSessionStart, cwd: string, sessionEmit: (e: HarnessEvent) => void, deps: CodexDeps): HarnessSession {
  if (start.permissionMode === "bypassPermissions" && !deps.allowBypass) throw new BypassRefused();
  /** A limited Job (a Stem Job): `submit_outputs` and the Job's server, nothing else (`config.ts` `RESTRICTED`). */
  const restricted = start.restricted === true;
  const bypass = start.permissionMode === "bypassPermissions" && !restricted;
  /** What the session may neither read nor write, symlinks inside followed: its profile and file changes deny it. */
  const denied = codexDenied(deps.secrets);
  const mcpDenied = [...denied, ...codexDenied([join(cwd, ".claude"), join(cwd, ".codex"), join(cwd, ".mcp.json"), ...(deps.pluginRoots ?? [])])];
  /** Set once the session has its outcome (result or error): nothing runs or is emitted after it. */
  let finished = false;
  const emit = (e: HarnessEvent) => {
    if (!finished) sessionEmit(e.type === "turn-end" && turnId ? { ...e, turnId } : e);
  };
  const questions = ownerQuestions(emit);
  const ask = questions.ask;
  /** Whether the session gets `ask` (`offersAsk`): never a restricted one. */
  const asks = offersAsk(start);
  /** Stops the app-server, while it starts or after. */
  const stopCodex = new AbortController();
  let rpc: CodexRpc | undefined;
  let threadId: string | undefined;
  /** A turn runs: from `turn/start` to its `turn/completed`. */
  let running = false;
  let turnId: string | undefined;
  /** Counts `turn/start`s: a reply that comes back after its turn ended names no later turn. */
  let turnsStarted = 0;
  /** Set by `interrupt()` during a turn: the turn it cuts short ends as interrupted. */
  let interrupted = false;
  /** Aborted by `interrupt()`: withdraws the questions the cut turn was waiting for. */
  let turnAbort = new AbortController();
  /** Set by `close()`: the app-server stops once the running turn is done. */
  let closing = false;
  /**
   * Messages waiting for the running turn to end: each starts a turn of its own, in order. The prompt goes first, whatever arrives while the thread opens.
   * An empty prompt (a chat whose trigger has no instructions) is no turn: the owner's first message is.
   */
  const waiting: string[] = start.prompt || !start.interactive ? [start.prompt] : [];
  /**
   * Steers sent to the running turn, by their client id. One joined the turn once Codex shows its
   * user message; one the turn ended without (Codex drops it on an interrupt) is the next message.
   */
  const steers = new Map<string, { text: string; settle: (outcome: "steered" | "queued") => void }>();
  /** The text of the turn's last agent message: its result. */
  let lastText = "";
  const inFlight = new Map<string, string>();
  /** The changes of each file change item, as last reported: what its approval is about. */
  const fileChanges = new Map<string, FileUpdateChange[]>();
  /** Questions about server requests, withdrawn when Codex resolves the request itself. */
  const requestAborts = new Map<RequestId, AbortController>();
  /** Command approvals already answered, by item and approval id. */
  const askedCommands = new Set<string>();

  function finish(event: HarnessEvent) {
    emit(event);
    finished = true;
    waiting.length = 0;
    turnAbort.abort();
    stopCodex.abort();
  }

  /** Every message starts a turn, once the one running is done. */
  function say(text: string) {
    waiting.push(text);
    void nextTurn();
  }

  const outcome = sessionOutcome(start, { emit, ask, finish, say });

  async function nextTurn() {
    if (finished || running || !rpc || !threadId) return;
    const text = waiting.shift();
    if (text === undefined) {
      if (closing) stopCodex.abort();
      return;
    }
    running = true;
    lastText = "";
    const started = ++turnsStarted;
    try {
      // Restricted: no environment, so no native tool (apply_patch included) reaches a file or a command.
      const { turn } = await rpc.request("turn/start", { threadId, input: await inputOf(rpc, text), ...(restricted ? { environments: [] } : {}) });
      if (running && started === turnsStarted) learnTurn(turn.id);
    } catch (err) {
      finish({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function inputOf(rpc: CodexRpc, text: string) {
    const skills = text.startsWith("/") && !restricted ? (await rpc.request("skills/list", { cwds: [cwd], forceReload: true })).data.flatMap((entry) => entry.skills) : [];
    return skillInputs(text, skills, deps.skillAliases);
  }

  /** Whether the session may take `text` on top of what waits: past the limits, it ends. */
  function admit(text: string): boolean {
    const texts = [...waiting, ...[...steers.values()].map((s) => s.text)];
    const bytes = texts.reduce((sum, t) => sum + Buffer.byteLength(t), 0);
    if (texts.length < MAX_WAITING && bytes + Buffer.byteLength(text) <= MAX_WAITING_BYTES) return true;
    // Every error is terminal for the engine, so the session ends with it.
    finish({ type: "error", message: "too many messages waiting for the agent: the session was stopped" });
    return false;
  }

  /** The running turn's id, from `turn/start`'s reply or `turn/started`: an interrupt asked before it was known is sent now. */
  function learnTurn(id: string) {
    if (turnId) return;
    turnId = id;
    emit({ type: "turn-start", turnId: id, interruptible: true });
    if (interrupted && rpc && threadId) void rpc.request("turn/interrupt", { threadId, turnId: id }).catch(() => undefined);
  }

  function turnCompleted(turn: Turn) {
    if (!running || (turnId !== undefined && turn.id !== turnId)) return;
    running = false;
    const wasInterrupted = interrupted;
    interrupted = false;
    for (const [id, steer] of steers) {
      steers.delete(id);
      waiting.push(steer.text);
      steer.settle("queued");
    }
    outcome.turnEnded({
      interrupted: wasInterrupted || turn.status === "interrupted",
      ...(turn.status === "failed" ? { error: turn.error?.message || "the turn failed" } : {}),
      text: lastText,
      queued: waiting.length > 0,
    });
    turnId = undefined;
    void nextTurn();
  }

  function onNotification(n: ServerNotification) {
    if (n.method === "item/started" || n.method === "item/completed") {
      const { item } = n.params;
      // Every thread's (subagents' too): an approval may come from any of them.
      if (item.type === "fileChange") {
        if (n.method === "item/started") fileChanges.set(item.id, item.changes);
        else fileChanges.delete(item.id);
      }
      // Subagents' own text and tools stay inside the tool that runs them.
      if (n.params.threadId !== threadId) return;
      const steer = item.type === "userMessage" && item.clientId ? steers.get(item.clientId) : undefined;
      if (steer && item.type === "userMessage" && item.clientId) {
        steers.delete(item.clientId);
        steer.settle("steered");
      }
      if (item.type === "agentMessage" && n.method === "item/completed") lastText = item.text;
      const name = toolName(item);
      if (!name) return;
      if (n.method === "item/started") {
        inFlight.set(item.id, name);
        emit({ type: "tool", name, status: "started" });
      } else if (inFlight.delete(item.id)) emit({ type: "tool", name, status: "done" });
    } else if (n.method === "item/fileChange/patchUpdated") {
      fileChanges.set(n.params.itemId, n.params.changes);
    } else if (n.method === "item/agentMessage/delta") {
      if (n.params.threadId === threadId) emit({ type: "text", delta: n.params.delta });
    } else if (n.method === "turn/started") {
      if (n.params.threadId === threadId && running) learnTurn(n.params.turn.id);
    } else if (n.method === "turn/completed") {
      if (n.params.threadId === threadId) turnCompleted(n.params.turn);
    } else if (n.method === "serverRequest/resolved") {
      requestAborts.get(n.params.requestId)?.abort();
    }
  }

  /** Asks a permission question, unless the owner couldn't see it whole: null then, as when it is withdrawn or denied. */
  const tools = toolPolicy(start, {
    harness: "codex",
    ...(deps.jobServer === undefined ? {} : { jobServer: deps.jobServer, unasked: deps.unasked ?? [] }),
    bypass,
    forbidden: mcpDenied,
    ...(deps.serverDirs ? { serverDirs: deps.serverDirs } : {}),
  });
  const native = nativePermissions("codex", start.jobToken ? start.rules : undefined);

  async function approve(payload: Extract<QuestionPayload, { kind: "permission" }>, signal: AbortSignal, call: CliRuleCall) {
    const remembers = start.jobToken ? nativeRuleForCall(call) : null;
    if (remembers) payload.remembers = remembers;
    if (!fitsWhole({ type: "question", questionId: "", payload })) return null;
    const answer = await ask(payload, signal);
    if (answer?.kind === "permission" && answer.remember && answer.decision === "deny") {
      finish({ type: "error", message: CODEX_DENIAL_UNSUPPORTED });
      return null;
    }
    if (remembers) native.remember(remembers, call, answer);
    return answer?.kind === "permission" && answer.decision !== "deny" ? answer.decision : null;
  }

  async function handle(r: ServerRequest, signal: AbortSignal): Promise<unknown> {
    switch (r.method) {
      case "item/commandExecution/requestApproval": {
        if (restricted) return { decision: "decline" };
        const p = r.params;
        const key = `${p.itemId}/${p.approvalId ?? ""}`;
        // A second approval for one command is Codex offering to run it again outside the sandbox
        // ("retry without sandbox?"); additional permissions widen the profile: neither is asked.
        const extra = p.additionalPermissions && (p.additionalPermissions.network || p.additionalPermissions.fileSystem);
        if (extra) return { decision: "decline" };
        const call = { cli: "codex" as const, tool: "Shell", command: p.command ?? undefined, proposedExecpolicyAmendment: p.proposedExecpolicyAmendment ?? undefined, commandActions: p.commandActions ?? undefined };
        const saved = native.decision(call);
        if (saved === "deny") return { decision: "decline" };
        if (bypass) return { decision: "accept" };
        if (askedCommands.has(key)) return { decision: "decline" };
        // The owner approves only what they see: input for a running terminal (`writeStdin`) or a command Codex doesn't name.
        if (p.kind !== "command" || !p.command) return { decision: "decline" };
        askedCommands.add(key);
        if (saved === "allow") return { decision: "accept" };
        const input = { command: p.command, cwd: p.cwd ?? "", reason: p.reason ?? "" };
        const decision = await approve({ kind: "permission", toolName: "Shell", input, canAlwaysAllow: true }, signal, call);
        // Never an execpolicy or network amendment: they persist rules beyond the session.
        return { decision: decision === "allow-always" ? "acceptForSession" : decision === "allow" ? "accept" : "decline" };
      }
      case "item/fileChange/requestApproval": {
        if (restricted) return { decision: "decline" };
        const changes = fileChanges.get(r.params.itemId) ?? [];
        const paths = changes.flatMap((c) => [c.path, ...(c.kind.type === "update" && c.kind.move_path ? [c.kind.move_path] : [])]);
        if (paths.length === 0 || paths.some((path) => codexDeniedEdit(cwd, path, denied))) return { decision: "decline" };
        const call = { cli: "codex" as const, tool: "FileChange" };
        const saved = native.decision(call);
        if (saved === "deny") return { decision: "decline" };
        if (bypass) return { decision: "accept" };
        if (saved === "allow") return { decision: "accept" };
        const input = { changes: changes.map((c) => ({ path: c.path, kind: c.kind, diff: c.diff })), reason: r.params.reason ?? "" };
        // Each change asks: "for the session" could let later changes skip this check.
        const decision = await approve({ kind: "permission", toolName: "FileChange", input, canAlwaysAllow: false }, signal, call);
        return { decision: decision ? "accept" : "decline" };
      }
      case "item/permissions/requestApproval":
        // More permissions widen the boundary: none is granted, and the owner isn't asked.
        return { permissions: {}, scope: "turn" };
      case "item/tool/requestUserInput": {
        const asked = r.params.questions;
        // A secret never goes through Dispand; a restricted session asks nobody.
        if (restricted || asked.some((q) => q.isSecret)) return { answers: {} };
        const shown = asked.map((q) => ({
          question: q.question,
          header: q.header,
          options: [...(q.options ?? []).map((o) => ({ label: o.label, description: o.description })), ...(q.isOther ? [{ label: "Other" }] : [])],
          multiSelect: false,
        }));
        const chosen = await askChoices(ask, shown, signal);
        if (chosen === null || chosen === "indistinct") return { answers: {} };
        const answers: Record<string, { answers: string[] }> = {};
        asked.forEach((q, i) => {
          const a = chosen[i];
          if (a !== undefined) answers[q.id] = { answers: a };
        });
        return { answers };
      }
      case "mcpServer/elicitation/request": {
        const p = r.params;
        const decline = { action: "decline" as const, content: null, _meta: null };
        const meta = isObject(p._meta) ? p._meta : {};
        // Codex asks before each MCP tool call with an elicitation of no fields: it becomes a
        // permission question, as on Claude Code. Any other elicitation collects nothing.
        if (p.mode !== "form" || meta.codex_approval_kind !== "mcp_tool_call" || Object.keys(p.requestedSchema.properties).length > 0) return decline;
        const tool = typeof meta.tool_name === "string" ? meta.tool_name : "";
        if (restricted && p.serverName !== deps.jobServer) return decline;
        // Each call asks: Codex's "for the session" and "always" would persist beyond what the owner sees.
        const input = isObject(meta.tool_params) ? meta.tool_params : {};
        const decision = await tools.decide({ name: `mcp__${p.serverName}__${tool}`, server: p.serverName, input }, ask, signal);
        return decision.allow ? { action: "accept" as const, content: {}, _meta: null } : decline;
      }
      case "item/tool/call": {
        const p = r.params;
        if (restricted && p.tool !== SUBMIT_OUTPUTS) return { contentItems: [{ type: "inputText", text: `unknown tool ${p.tool}` }], success: false };
        if (p.tool === REQUEST_APPROVAL && p.namespace === null && p.threadId === threadId) {
          const asked = typeof p.arguments === "object" && p.arguments !== null && !Array.isArray(p.arguments) ? (p.arguments as Record<string, unknown>) : {};
          const outcome = await requestApproval(ask, asked, signal);
          return { contentItems: [{ type: "inputText", text: outcome.text }], success: outcome.ok };
        }
        // We decided a subagent asks the agent that started it, which decides whether to ask the person.
        if (p.tool === REQUEST_APPROVAL && p.namespace === null) {
          return { contentItems: [{ type: "inputText", text: SUBAGENT_ASKS_PARENT }], success: false };
        }
        // Dispand answers it (an agent's Job, or a person): the owner isn't asked about calling it.
        if (p.tool === ASK && asks && p.namespace === null && p.threadId === threadId) {
          const asked = typeof p.arguments === "object" && p.arguments !== null && !Array.isArray(p.arguments) ? (p.arguments as Record<string, unknown>) : {};
          const outcome = await askTool(ask, asked, start, signal);
          return { contentItems: [{ type: "inputText", text: outcome.text }], success: outcome.ok };
        }
        if (p.tool !== SUBMIT_OUTPUTS || p.namespace !== null || p.threadId !== threadId) {
          return { contentItems: [{ type: "inputText", text: `unknown tool ${p.tool}` }], success: false };
        }
        const args = typeof p.arguments === "object" && p.arguments !== null && !Array.isArray(p.arguments) ? p.arguments : {};
        return { contentItems: [{ type: "inputText", text: await outcome.submit(args, signal) }], success: true };
      }
      default:
        throw new Error(`${r.method} is not handled by dispand-runner`);
    }
  }

  async function onServerRequest(r: ServerRequest): Promise<unknown> {
    const withdrawn = new AbortController();
    requestAborts.set(r.id, withdrawn);
    try {
      return await handle(r, AbortSignal.any([withdrawn.signal, turnAbort.signal]));
    } finally {
      requestAborts.delete(r.id);
    }
  }

  const done = (async () => {
    try {
      const codex = await CodexRpc.spawn(deps.codexPath, { ...(deps.env ?? process.env), ...deps.mcp?.env }, cwd, stopCodex.signal);
      rpc = codex;
      codex.onNotification(onNotification);
      codex.onServerRequest(onServerRequest);
      const roots = deps.pluginRoots ?? [];
      if (roots.length > 0) await codex.request("skills/extraRoots/set", { extraRoots: roots.map((root) => join(root, "skills")) });
      // Codex merges our servers key by key into a same-named one of the user's config.toml: a
      // stdio one fails the config, any other mixes its settings (headers, enabled) into ours.
      const ours = Object.keys(deps.mcp?.servers ?? {});
      const configured = restricted || ours.length > 0 ? Object.keys(((await codex.request("config/read", { cwd })).config.mcp_servers ?? {}) as object) : [];
      const clash = ours.find((name) => configured.includes(name));
      if (clash !== undefined) return finish({ type: "error", message: mcpNameRefused(clash) });
      // Restricted: every other MCP server of the user's config is off, the Job's alone stays.
      const mcpServers = restricted ? { ...Object.fromEntries(configured.map((name) => [name, { enabled: false }])), ...deps.mcp?.servers } : { ...deps.mcp?.servers };
      const overrides = {
        cwd,
        model: start.model ?? null,
        // Keep MCP approvals enabled even when native commands bypass questions.
        approvalPolicy: "untrusted" as const,
        approvalsReviewer: "user" as const,
        config: codexConfig({ codexHome: (deps.env ?? process.env).CODEX_HOME, denied: sandboxDenied(denied, deps.codexPath), ...(deps.pluginsDir ? { pluginsDir: deps.pluginsDir } : {}), bypass, restricted, mcpServers }),
        developerInstructions: start.systemPrompt || null,
      };
      const approvalSpec = {
        type: "function" as const,
        name: REQUEST_APPROVAL,
        description: REQUEST_APPROVAL_DESCRIPTION,
        inputSchema: {
          type: "object",
          properties: {
            message: { type: "string", description: "What you ask to be approved, as one clear question" },
            proposal: { type: "string", description: "The id propose gave you, when you ask for a proposal: the owner then approves its listed writes" },
          },
          required: ["message"],
          additionalProperties: false,
        },
      };
      const spec = {
        type: "function" as const,
        name: SUBMIT_OUTPUTS,
        description: "Hand your results back to Dispand. Call it once you have every value.",
        inputSchema: {
          type: "object",
          properties: Object.fromEntries(start.expectedOutputs.map((f) => [f.name, { type: "string", description: f.description ?? f.name }])),
          required: start.expectedOutputs.map((f) => f.name),
          additionalProperties: false,
        },
      };
      // Only when the start offers it (`offersAsk`).
      const askSpec = { type: "function" as const, name: ASK, description: askDescription(start), inputSchema: ASK_INPUT_SCHEMA };
      // `Sessions` passes a CLI session id only for a thread the runner recorded for this run folder.
      const opened = start.resumeCliSessionId
        ? await codex.request("thread/resume", { threadId: start.resumeCliSessionId, ...overrides })
        : await codex.request("thread/start", { ...overrides, dynamicTools: restricted ? [spec] : [spec, approvalSpec, ...(asks ? [askSpec] : [])] });
      // A `sandbox_mode` in the user's config.toml makes Codex ignore profiles: no turn runs then.
      if (opened.activePermissionProfile?.id !== (bypass ? BYPASS_PROFILE : PROFILE)) return finish({ type: "error", message: PROFILE_REFUSED });
      threadId = opened.thread.id;
      emit({ type: "cli-session", cliSessionId: threadId });
      // Until the owner's first message comes, the chat waits between turns, like after any turn.
      if (!start.prompt && start.interactive && waiting.length === 0) emit({ type: "turn-end" });
      void nextTurn();
      await codex.exited;
      if (!finished && !closing) finish({ type: "error", message: "codex exited before the session finished" });
    } catch (err) {
      finish({ type: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      stopCodex.abort();
      await rpc?.exited;
      questions.endAll();
    }
  })();

  return {
    commands: async () => {
      if (!rpc) throw new Error("Session starting");
      const list = await rpc.request("skills/list", { cwds: [cwd], forceReload: true });
      return skillCommands(list.data.flatMap((entry) => entry.skills));
    },
    send(text) {
      if (admit(text)) say(text);
    },
    steer(target, text) {
      if (!admit(text)) return Promise.resolve("queued");
      const codex = rpc;
      if (!running || target !== turnId || !codex || !threadId) {
        say(text);
        return Promise.resolve("queued");
      }
      const id = randomUUID();
      const thread = threadId;
      return new Promise((settle) => {
        steers.set(id, { text, settle });
        // Refused (the turn ended, or can't be steered): the next message, unless its end already made it one.
        void inputOf(codex, text)
          .then((input) => codex.request("turn/steer", { threadId: thread, expectedTurnId: target, clientUserMessageId: id, input }))
          .catch(() => {
            if (!steers.delete(id)) return;
            say(text);
            settle("queued");
          });
      });
    },
    narrowPermissions: tools.narrow,
    answer: questions.answer,
    interrupt: async (target) => {
      if (target !== undefined) {
        if (!running || target !== turnId || !rpc || !threadId) return "stale";
        try {
          await rpc.request("turn/interrupt", { threadId, turnId: target });
          // The reply may follow completion and the next turn's start.
          if (running && turnId === target) {
            interrupted = true;
            turnAbort.abort();
            turnAbort = new AbortController();
          }
          return "requested";
        } catch {
          return "failed";
        }
      }
      // Idle: nothing to cut short, and no later turn may pass for an interrupted one.
      if (!running) return;
      interrupted = true;
      turnAbort.abort();
      turnAbort = new AbortController();
      if (rpc && threadId && turnId) await rpc.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
    },
    close() {
      closing = true;
      waiting.length = 0;
      if (!running) stopCodex.abort();
    },
    toolsInFlight: () => inFlight.size,
    stop: (message) => finish({ type: "error", message }),
    abort() {
      // Nothing more is emitted: what was already emitted is in the backlog.
      finished = true;
      waiting.length = 0;
      turnAbort.abort();
      stopCodex.abort();
    },
    done,
  };
}
