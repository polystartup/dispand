// One Codex session: a `codex app-server` of its own, confined by Dispand's permission profile.
import { join } from "node:path";
import type { HarnessEvent, QuestionPayload, SessionStart } from "@dispand/runner-protocol";
import { JOB_TOOLS_SERVER } from "@dispand/runner-protocol";
import { codexDenied, codexDeniedEdit, sandboxDenied } from "../boundary.ts";
import { askChoices, BypassRefused, consult, CONSULT, consultDescription, type HarnessSession, MAX_WAITING, MAX_WAITING_BYTES, ownerQuestions, REQUEST_APPROVAL, REQUEST_APPROVAL_DESCRIPTION, requestApproval, sessionOutcome } from "../outcome.ts";
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
  /** The session's MCP servers (`mcp.ts` `codexMcpServers`): the config, and the header values for the app-server's environment. */
  mcp?: { servers: Record<string, JsonValue>; env: Record<string, string> };
  /** The name of Dispand's Job server among them, when the session has one: its tools run without a question. */
  jobServer?: string;
  /** With `jobServer`: the tools of the Job's tools server that run without a question, by their name there. */
  unasked?: string[];
};

const SUBMIT_OUTPUTS = "submit_outputs";
export const PROFILE_REFUSED = "Codex didn't apply Dispand's permission profile: remove sandbox_mode from ~/.codex/config.toml";

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
  const bypass = start.permissionMode === "bypassPermissions";
  if (bypass && !deps.allowBypass) throw new BypassRefused();
  /** What the session may neither read nor write, symlinks inside followed: its profile and file changes deny it. */
  const denied = codexDenied(deps.secrets);
  /** Set once the session has its outcome (result or error): nothing runs or is emitted after it. */
  let finished = false;
  const emit = (e: HarnessEvent) => {
    if (!finished) sessionEmit(e);
  };
  const questions = ownerQuestions(emit);
  const ask = questions.ask;
  /** The agents the session may consult: its `consult` tool exists only when there are some. */
  const consults = start.consults ?? [];
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
  /** Messages waiting for the running turn to end: each starts a turn of its own, in order. The prompt goes first, whatever arrives while the thread opens. */
  const waiting: string[] = [start.prompt];
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
      const { turn } = await rpc.request("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }] });
      if (running && started === turnsStarted) learnTurn(turn.id);
    } catch (err) {
      finish({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  /** The running turn's id, from `turn/start`'s reply or `turn/started`: an interrupt asked before it was known is sent now. */
  function learnTurn(id: string) {
    if (turnId) return;
    turnId = id;
    if (interrupted && rpc && threadId) void rpc.request("turn/interrupt", { threadId, turnId: id }).catch(() => undefined);
  }

  function turnCompleted(turn: Turn) {
    if (!running) return;
    running = false;
    turnId = undefined;
    const wasInterrupted = interrupted;
    interrupted = false;
    outcome.turnEnded({
      interrupted: wasInterrupted || turn.status === "interrupted",
      ...(turn.status === "failed" ? { error: turn.error?.message || "the turn failed" } : {}),
      text: lastText,
      queued: waiting.length > 0,
    });
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
  /** The tools of the Job's tools server that run without a question: the start's, and those the owner always allowed since. */
  const unasked = new Set(deps.unasked ?? []);

  async function approve(payload: Extract<QuestionPayload, { kind: "permission" }>, signal: AbortSignal) {
    if (!fitsWhole({ type: "question", questionId: "", payload })) return null;
    const answer = await ask(payload, signal);
    return answer?.kind === "permission" && answer.decision !== "deny" ? answer.decision : null;
  }

  async function handle(r: ServerRequest, signal: AbortSignal): Promise<unknown> {
    switch (r.method) {
      case "item/commandExecution/requestApproval": {
        const p = r.params;
        const key = `${p.itemId}/${p.approvalId ?? ""}`;
        // A second approval for one command is Codex offering to run it again outside the sandbox
        // ("retry without sandbox?"); additional permissions widen the profile: neither is asked.
        const extra = p.additionalPermissions && (p.additionalPermissions.network || p.additionalPermissions.fileSystem);
        if (askedCommands.has(key) || extra) return { decision: "decline" };
        // The owner approves only what they see: input for a running terminal (`writeStdin`) or a command Codex doesn't name.
        if (p.kind !== "command" || !p.command) return { decision: "decline" };
        askedCommands.add(key);
        const input = { command: p.command, cwd: p.cwd ?? "", reason: p.reason ?? "" };
        const decision = await approve({ kind: "permission", toolName: "Shell", input, canAlwaysAllow: true }, signal);
        // Never an execpolicy or network amendment: they persist rules beyond the session.
        return { decision: decision === "allow-always" ? "acceptForSession" : decision === "allow" ? "accept" : "decline" };
      }
      case "item/fileChange/requestApproval": {
        const changes = fileChanges.get(r.params.itemId) ?? [];
        const paths = changes.flatMap((c) => [c.path, ...(c.kind.type === "update" && c.kind.move_path ? [c.kind.move_path] : [])]);
        if (paths.length === 0 || paths.some((path) => codexDeniedEdit(cwd, path, denied))) return { decision: "decline" };
        const input = { changes: changes.map((c) => ({ path: c.path, kind: c.kind, diff: c.diff })), reason: r.params.reason ?? "" };
        // Each change asks: "for the session" could let later changes skip this check.
        const decision = await approve({ kind: "permission", toolName: "FileChange", input, canAlwaysAllow: false }, signal);
        return { decision: decision ? "accept" : "decline" };
      }
      case "item/permissions/requestApproval":
        // More permissions widen the boundary: none is granted, and the owner isn't asked.
        return { permissions: {}, scope: "turn" };
      case "item/tool/requestUserInput": {
        const asked = r.params.questions;
        // A secret never goes through Dispand.
        if (asked.some((q) => q.isSecret)) return { answers: {} };
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
        // Dispand's own tools: authorized by Dispand on every call, so the owner isn't asked.
        if (deps.jobServer !== undefined && p.serverName === deps.jobServer) return { action: "accept" as const, content: {}, _meta: null };
        const tool = typeof meta.tool_name === "string" ? meta.tool_name : "";
        // An action the agent lets run unasked: the server runs it without an approval.
        const jobTool = deps.jobServer !== undefined && p.serverName === JOB_TOOLS_SERVER;
        if (jobTool && unasked.has(tool)) return { action: "accept" as const, content: {}, _meta: null };
        const input = isObject(meta.tool_params) ? meta.tool_params : {};
        // Each call asks: Codex's "for the session" and "always" would persist beyond what the owner sees.
        // For one of the Job's tools, "always" is the owner taking that action off the agent's asking
        // ones, on the server: here it only means this session stops asking about it too.
        const decision = await approve({ kind: "permission", toolName: `mcp__${p.serverName}__${tool}`, input, canAlwaysAllow: jobTool }, signal);
        if (decision === "allow-always" && jobTool) unasked.add(tool);
        return decision ? { action: "accept" as const, content: {}, _meta: null } : decline;
      }
      case "item/tool/call": {
        const p = r.params;
        if (p.tool === REQUEST_APPROVAL && p.namespace === null && p.threadId === threadId) {
          const asked = typeof p.arguments === "object" && p.arguments !== null && !Array.isArray(p.arguments) ? (p.arguments as Record<string, unknown>) : {};
          const outcome = await requestApproval(ask, asked, signal);
          return { contentItems: [{ type: "inputText", text: outcome.text }], success: outcome.ok };
        }
        // Dispand answers it with the consulted agent's Job (or why there is none): the owner isn't asked.
        if (p.tool === CONSULT && consults.length > 0 && p.namespace === null && p.threadId === threadId) {
          const asked = typeof p.arguments === "object" && p.arguments !== null && !Array.isArray(p.arguments) ? (p.arguments as Record<string, unknown>) : {};
          const outcome = await consult(ask, asked, consults, signal);
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
      const overrides = {
        cwd,
        model: start.model ?? null,
        approvalPolicy: bypass ? ("never" as const) : ("untrusted" as const),
        approvalsReviewer: "user" as const,
        config: codexConfig({ denied: sandboxDenied(denied, deps.codexPath), ...(deps.pluginsDir ? { pluginsDir: deps.pluginsDir } : {}), bypass, ...(deps.mcp ? { mcpServers: deps.mcp.servers } : {}) }),
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
      // Only when the start lists agents to consult.
      const consultSpec = {
        type: "function" as const,
        name: CONSULT,
        description: consultDescription(consults),
        inputSchema: {
          type: "object",
          properties: {
            agent: { type: "string", description: "The id of the agent to consult, as listed" },
            question: { type: "string", description: "Your question, with all it needs to be answered" },
          },
          required: ["agent", "question"],
          additionalProperties: false,
        },
      };
      // `Sessions` passes a CLI session id only for a thread the runner recorded for this run folder.
      const opened = start.resumeCliSessionId
        ? await codex.request("thread/resume", { threadId: start.resumeCliSessionId, ...overrides })
        : await codex.request("thread/start", { ...overrides, dynamicTools: [spec, approvalSpec, ...(consults.length > 0 ? [consultSpec] : [])] });
      // A `sandbox_mode` in the user's config.toml makes Codex ignore profiles: no turn runs then.
      if (opened.activePermissionProfile?.id !== (bypass ? BYPASS_PROFILE : PROFILE)) return finish({ type: "error", message: PROFILE_REFUSED });
      threadId = opened.thread.id;
      emit({ type: "cli-session", cliSessionId: threadId });
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
    send(text) {
      // Every error is terminal for the engine, so the session ends with it.
      const bytes = waiting.reduce((sum, t) => sum + Buffer.byteLength(t), 0);
      if (waiting.length >= MAX_WAITING || bytes + Buffer.byteLength(text) > MAX_WAITING_BYTES) {
        return finish({ type: "error", message: "too many messages waiting for the agent: the session was stopped" });
      }
      say(text);
    },
    answer: questions.answer,
    interrupt: async () => {
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
