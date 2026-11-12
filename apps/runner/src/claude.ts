import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  type CanUseTool,
  createSdkMcpServer,
  type McpServerConfig,
  type PermissionResult,
  type PreToolUseHookInput,
  query,
  type SDKMessage,
  type SDKUserMessage,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeSessionStart, HarnessEvent, QuestionPayload } from "@dispand/runner-protocol";
import { runnerArgumentsAllowed, narrowUnasked, unaskedTools } from "./mcp.ts";
import { z } from "zod";
import { permissionBoundary, PROTECTED_DENIAL, READ_ASK, READ_DENIAL } from "./boundary.ts";
import { askChoices, MAX_WAITING, MAX_WAITING_BYTES, BypassRefused, type ChoiceQuestion, consult, CONSULT, consultDescription, type HarnessSession, ownerQuestions, REQUEST_APPROVAL, REQUEST_APPROVAL_DESCRIPTION, requestApproval, sessionOutcome, TURN_DENIED } from "./outcome.ts";
import { fitsWhole } from "./sanitize.ts";
import { PLANS_DIR } from "./workdir.ts";

export { BypassRefused };
export type ClaudeSession = HarnessSession;

export type ClaudeDeps = {
  query?: typeof query;
  /** The CLI's environment, from `claudeEnv`: the boundary reads `CLAUDE_CONFIG_DIR` from it too. */
  env?: NodeJS.ProcessEnv;
  /** From the machine's config: whether `bypassPermissions` may be used. */
  allowBypass?: boolean;
  /** The signed-in `claude` binary to run. */
  claudePath?: string;
  /** This session's skill packages, written as plugins (`skills.ts` `writeSkills`): loaded, readable, never editable. */
  pluginRoots?: string[];
  /** The session's MCP servers (`mcp.ts` `mcpConfigFor`): each must connect before the first turn. */
  mcpServers?: Record<string, McpServerConfig>;
  /** The name of Dispand's Job server among them, when the session has one: its tools run without a question. */
  jobServer?: string;
  /** With `jobServer`: the tools of the Job's tools server that run without a question, by their name there. */
  unasked?: string[];
  secrets?: string[];
};

/**
 * Why one of the session's own plugins (`roots`) didn't load, from the init message's
 * `plugin_errors`, or null. An error is ours when it names one of the roots' paths or
 * `<name>@inline`. A duplicate-name error, which the machine's own plugin of the same name could
 * cause, isn't a failure: the skills still load (recorded on Claude Code 2.1.316, which reports
 * none at all: `fixtures/init-duplicate-plugin.json`).
 */
export function pluginFailure(errors: { plugin: string; type: string; message: string; path?: string }[] | undefined, roots: string[]): string | null {
  for (const error of errors ?? []) {
    const root = roots.find((r) => error.path === r || error.plugin === `${basename(r)}@inline`);
    if (!root || /duplicate/i.test(error.type)) continue;
    return `skill package ${basename(root)} didn't load: ${error.message}`;
  }
  return null;
}

const SUBMIT_OUTPUTS = "mcp__dispand__submit_outputs";
/** Tools that run commands or scripts (Monitor runs one and streams it; PowerShell is the Windows shell; Workflow runs scripts). */
const SHELL_TOOLS = new Set(["Bash", "Monitor", "PowerShell", "Workflow"]);
const SHELL_ASK = "Dispand asks the owner about every shell command.";
const REQUEST_APPROVAL_TOOL = `mcp__dispand__${REQUEST_APPROVAL}`;
const CONSULT_TOOL = `mcp__dispand__${CONSULT}`;
const MCP_ASK = "Dispand asks the owner about every MCP tool call.";
/** An MCP server's tool, Dispand's own (`submit_outputs`, `request_approval`, `consult`) aside: each call asks the owner. */
const isMcpTool = (name: string) => name.startsWith("mcp__") && name !== SUBMIT_OUTPUTS && name !== REQUEST_APPROVAL_TOOL && name !== CONSULT_TOOL;


/**
 * The user messages fed to the CLI: a queue the SDK reads until it is closed, from once `gate`
 * settles (the session's MCP servers are set up).
 */
function inputQueue(verbatim: (text: string) => Promise<boolean>, gate: Promise<void>) {
  const messages: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  async function* read(): AsyncGenerator<SDKUserMessage> {
    await gate;
    for (;;) {
      if (messages.length > 0) {
        const next = messages.shift()!;
        // A slash command Dispand may not run goes as written; everything else as usual, so the
        // turn keeps the CLI's turn-start context (skill listings, CLAUDE.md), which client_composed drops.
        if (await verbatim(String(next.message.content))) yield { ...next, client_composed: true };
        else yield next;
      }
      else if (closed) return;
      else await new Promise<void>((resolve) => (wake = resolve));
    }
  }
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  return {
    iterable: read(),
    /** Queues a message; returns its uuid, or null once closed. */
    push(text: string): string | null {
      if (closed) return null;
      const uuid = randomUUID();
      messages.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid });
      notify();
      return uuid;
    },
    isClosed: () => closed,
    /** Ends the input: messages still queued are dropped, so no further turn starts. */
    close() {
      closed = true;
      messages.length = 0;
      notify();
    },
  };
}

/**
 * Runs one Claude Code session through the Agent SDK, which spawns the machine's signed-in
 * `claude`. Permission prompts and `AskUserQuestion` become `question` events; the agent hands
 * its results back through the `submit_outputs` tool of the in-process `dispand` MCP server.
 */
export function startClaudeSession(
  start: ClaudeSessionStart,
  cwd: string,
  sessionEmit: (e: HarnessEvent) => void,
  deps: ClaudeDeps = {},
): ClaudeSession {
  if (start.permissionMode === "bypassPermissions" && !deps.allowBypass) {
    throw new BypassRefused();
  }
  // Set once the query exists: the SDK may start reading the input before `query()` returns.
  let onQuery!: (q: ReturnType<typeof query>) => void;
  const queryReady = new Promise<ReturnType<typeof query>>((resolve) => (onQuery = resolve));
  let commands: Promise<Set<string>> | undefined;
  /**
   * Whether `text` must go as written: it starts (after any whitespace) with `/` and isn't a
   * command the CLI may run for Dispand, a skill or a plugin/custom command, never a built-in.
   */
  async function verbatim(text: string): Promise<boolean> {
    // An @ mention makes the CLI read a file before any tool check runs: never expanded.
    if (text.includes("@")) return true;
    const trimmed = text.trimStart();
    if (!trimmed.startsWith("/")) return false;
    const name = /^\/([^\s/]+)/.exec(trimmed)?.[1];
    if (!name) return true;
    commands ??= queryReady.then(
      (q) => q.supportedCommands(),
    ).then(
      (list) => {
        // CLIs that flag built-ins: everything else is a skill or a plugin/custom command, minus
        // every spelling a built-in owns (a custom `config` or an alias of it stays a built-in's).
        // Others: plugin (namespaced) names only.
        const spellings = (c: (typeof list)[number]) => [c.name, ...(c.aliases ?? [])];
        const flagged = list.some((c) => c.builtin !== undefined);
        const builtin = new Set(list.filter((c) => c.builtin === true).flatMap(spellings));
        const allowed = flagged
          ? list.filter((c) => c.builtin !== true).flatMap(spellings)
          : list.flatMap(spellings).filter((name) => name.includes(":"));
        return new Set(allowed.filter((name) => !builtin.has(name)));
      },
      () => new Set<string>(),
    );
    return !(await commands).has(name);
  }
  let openGate!: () => void;
  const input = inputQueue(verbatim, new Promise<void>((resolve) => (openGate = resolve)));
  /** Set once the session has its outcome (result or error): nothing runs or is emitted after it. */
  let finished = false;
  const emit = (e: HarnessEvent) => {
    if (!finished) sessionEmit(e);
  };
  const questions = ownerQuestions(emit);
  const ask = questions.ask;
  const outcome = sessionOutcome(start, { emit, ask, finish, say });
  /** Set by `interrupt()` during a turn: the turn it cuts short ends with an error result. */
  let interrupted = false;
  /** Aborted by `interrupt()`: withdraws the outputs confirmation the cut turn was waiting for. */
  let turnAbort = new AbortController();
  /** Messages sent and not yet answered by a result: a turn runs while there is one. */
  const unanswered: string[] = [];
  const unansweredBytes = new Map<string, number>();
  const pluginRoots = deps.pluginRoots ?? [];
  const boundary = permissionBoundary(cwd, homedir(), deps.env ?? process.env, pluginRoots);

  /** Every user message starts (or joins) a turn. */
  function say(text: string) {
    const uuid = input.push(text);
    if (uuid) {
      unanswered.push(uuid);
      unansweredBytes.set(uuid, Buffer.byteLength(text));
    }
  }

  /** A result answers the messages it lists (several may have run as one turn), or else the oldest. */
  function answered(msg: Extract<SDKMessage, { type: "result" }>) {
    const uuids = msg.user_message_uuids ?? (msg.user_message_uuid ? [msg.user_message_uuid] : []);
    const drop = (n: number) => {
      for (const uuid of unanswered.splice(0, n)) unansweredBytes.delete(uuid);
    };
    if (uuids.length === 0) drop(1);
    for (const uuid of uuids) {
      const i = unanswered.indexOf(uuid);
      // Messages before it were folded into this turn or an earlier one.
      if (i >= 0) drop(i + 1);
    }
  }

  const submitOutputs = tool(
    "submit_outputs",
    "Hand your results back to Dispand. Call it once you have every value.",
    Object.fromEntries(start.expectedOutputs.map((f) => [f.name, z.string().describe(f.description ?? f.name)])),
    async (args, extra) => {
      // Withdrawn when the call is cancelled or its turn interrupted: a late answer finds nothing to resolve.
      const callSignal = (extra as { signal?: AbortSignal } | undefined)?.signal;
      const signal = callSignal ? AbortSignal.any([callSignal, turnAbort.signal]) : turnAbort.signal;
      return { content: [{ type: "text", text: await outcome.submit(args as Record<string, unknown>, signal) }] };
    },
  );

  /**
   * A tool of Dispand's Job server (Dispand authorizes each of its calls itself), or an action
   * of the agent's tools that it lets run unasked: the owner isn't asked.
   */
  const { names: unasked, servers: agentServers } = unaskedTools(start.mcpServers, deps.jobServer === undefined ? undefined : (deps.unasked ?? []));
  let permissionsVersion = 0;
  const runnerTool = (name: string) => agentServers.some((server) => server !== "job_tools" && name.startsWith(`mcp__${server}__`));
  const protectedArgs = (name: string, args: unknown) => runnerTool(name) && !runnerArgumentsAllowed(args, [...(deps.secrets ?? []), join(cwd, ".claude"), join(cwd, ".codex"), join(cwd, ".mcp.json"), ...pluginRoots]);
  const isJobTool = (name: string) => deps.jobServer !== undefined && (name.startsWith(`mcp__${deps.jobServer}__`) || unasked.has(name));

  /**
   * The approval the turn waits on, from the moment the CLI is about to call `request_approval`:
   * a model may send other calls in the same turn, and those that run unasked (Dispand's own
   * tools) would act before the owner answered. They wait for the answer, and aren't run after
   * a "no". Settled by the tool; a turn that ends first settles it as not approved.
   */
  let approval: { answered: Promise<boolean>; settle: (approved: boolean) => void } | null = null;
  const expectApproval = () => {
    if (approval) return;
    let settle!: (approved: boolean) => void;
    const mine = { answered: new Promise<boolean>((resolve) => (settle = resolve)), settle };
    approval = mine;
    // A turn that ends before the tool answered (the call never ran, or was cut): its other
    // calls aren't run, and the next turn starts with nothing pending.
    turnAbort.signal.addEventListener(
      "abort",
      () => {
        settle(false);
        if (approval === mine) approval = null;
      },
      { once: true },
    );
  };
  /** False when the turn's approval request was denied (true when there is none, or it was approved). */
  const turnApproved = () => approval?.answered ?? Promise.resolve(true);

  const requestApprovalTool = tool(
    REQUEST_APPROVAL,
    REQUEST_APPROVAL_DESCRIPTION,
    // Anything is let through to the tool, which says in words what is wrong with it: a call the
    // CLI rejected before it ran would leave the turn's other calls waiting for an answer that never comes.
    {
      message: z.unknown().describe("What you ask to be approved, as one clear question (text)"),
      proposal: z.unknown().optional().describe("The id propose gave you, when you ask for a proposal: the owner then approves its listed writes"),
    },
    async (args, extra) => {
    const callSignal = (extra as { signal?: AbortSignal } | undefined)?.signal;
    const signal = callSignal ? AbortSignal.any([callSignal, turnAbort.signal]) : turnAbort.signal;
    expectApproval();
    const waiting = approval;
    const outcome = await requestApproval(ask, args as Record<string, unknown>, signal);
      waiting?.settle(outcome.approved);
      if (approval === waiting) approval = null;
      return { content: [{ type: "text", text: outcome.text }] };
    },
  );

  /** Only when the start lists agents to consult: Dispand answers it with their Jobs, so the owner isn't asked about calling it. */
  const consults = start.consults ?? [];
  const consultTool = tool(
    CONSULT,
    consultDescription(consults),
    // As for `request_approval`: anything is let through, and the tool says what is wrong with it.
    {
      agent: z.unknown().describe("The id of the agent to consult, as listed"),
      question: z.unknown().describe("Your question, with all it needs to be answered"),
    },
    async (args, extra) => {
      const callSignal = (extra as { signal?: AbortSignal } | undefined)?.signal;
      const signal = callSignal ? AbortSignal.any([callSignal, turnAbort.signal]) : turnAbort.signal;
      const outcome = await consult(ask, args as Record<string, unknown>, consults, signal);
      return { content: [{ type: "text", text: outcome.text }], ...(outcome.ok ? {} : { isError: true }) };
    },
  );

  const canUseTool: CanUseTool = async (toolName, toolInput, { signal, suggestions }): Promise<PermissionResult> => {
    if (toolName !== REQUEST_APPROVAL_TOOL && !(await turnApproved())) return { behavior: "deny", message: TURN_DENIED };
    // `request_approval` asks the owner itself, in the agent's words: no second question about calling it.
    if (toolName === SUBMIT_OUTPUTS || toolName === REQUEST_APPROVAL_TOOL || (toolName === CONSULT_TOOL && consults.length > 0) || isJobTool(toolName)) return { behavior: "allow", updatedInput: toolInput };
    // canUseTool doesn't learn the CLI's current directory: relative paths are the owner's call.
    const edit = boundary.editDecision(toolName, toolInput, null);
    const read = boundary.readDecision(toolName, toolInput, null);
    // A path the runner can't decide on as written: the owner decides (the question below).
    if (edit !== "ask" && read !== "ask") {
      if (edit === "deny") return { behavior: "deny", message: PROTECTED_DENIAL };
      if (read === "deny") return { behavior: "deny", message: READ_DENIAL };
      // Inside the read allowlist (a skill's own files under plugins/, outside the working
      // directory, which the CLI would ask about): allowed without a question.
      if (read === "allow") return { behavior: "allow", updatedInput: toolInput };
    }
    if (toolName === "AskUserQuestion") {
      const questions = (toolInput.questions ?? []) as ChoiceQuestion[];
      const chosen = await askChoices(ask, questions, signal);
      if (chosen === "indistinct") {
        return { behavior: "deny", message: "These questions are too long to tell apart once shown to the owner: shorten them and ask again." };
      }
      if (chosen === null) return { behavior: "deny", message: "The question was not answered." };
      const answers: Record<string, string> = {};
      questions.forEach((q, i) => {
        const a = chosen[i];
        if (a !== undefined) answers[q.question] = a.join(", ");
      });
      return { behavior: "allow", updatedInput: { ...toolInput, answers } };
    }
    // An MCP call is approved one at a time: no rule may let the next ones through.
    const updates = isMcpTool(toolName) ? [] : boundary.sessionUpdates(suggestions);
    // One of the Job's agent's tools (its tools server's, or a runner tool's): "always" is the
    // owner taking that action off the agent's asking ones, on the server. Here it only means
    // this session stops asking about it too.
    const jobTool = agentServers.some((server) => toolName.startsWith(`mcp__${server}__`));
    const canAlwaysAllow = updates.length > 0 || jobTool;
    const version = permissionsVersion;
    const payload: QuestionPayload = { kind: "permission", toolName, input: toolInput, canAlwaysAllow };
    // The owner approves exactly what they see: an input that can't be shown whole isn't asked about.
    if (!fitsWhole({ type: "question", questionId: "", payload })) {
      return { behavior: "deny", message: "The tool input is too large to show for approval (or holds characters that can't be shown): split it up." };
    }
    const answer = await ask(payload, signal);
    if (answer?.kind !== "permission" || answer.decision === "deny") {
      return { behavior: "deny", message: (answer?.kind === "permission" && answer.message) || "The owner denied this." };
    }
    if (answer.decision === "allow-always" && jobTool && version === permissionsVersion) {
      unasked.add(toolName);
      return { behavior: "allow", updatedInput: toolInput };
    }
    if (answer.decision === "allow-always" && canAlwaysAllow) {
      return { behavior: "allow", updatedInput: toolInput, updatedPermissions: updates };
    }
    return { behavior: "allow", updatedInput: toolInput };
  };

  const sdkServers = { dispand: createSdkMcpServer({ name: "dispand", tools: [submitOutputs, requestApprovalTool, ...(consults.length > 0 ? [consultTool] : [])] }) };
  const queryAbort = new AbortController();
  const q = (deps.query ?? query)({
    prompt: input.iterable,
    options: {
      cwd,
      abortController: queryAbort,
      // The user's own settings only: whatever a run folder holds (its .claude/ settings and
      // hooks, .mcp.json) never loads by itself, on start or resume (controller ruling R30).
      settingSources: ["user"],
      systemPrompt: { type: "preset", preset: "claude_code", append: start.systemPrompt },
      ...(start.resumeCliSessionId ? { resume: start.resumeCliSessionId } : {}),
      ...(start.model ? { model: start.model } : {}),
      permissionMode: start.permissionMode,
      ...(start.permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
      includePartialMessages: true,
      mcpServers: sdkServers,
      // Skill packages only: the runner wrote nothing but plugin.json and skills/ there.
      ...(pluginRoots.length > 0 ? { plugins: pluginRoots.map((path) => ({ type: "local" as const, path, skipMcpDiscovery: true })) } : {}),
      canUseTool,
      // The highest-priority settings layer the user controls; disallowed edits are also refused in canUseTool.
      // Plans default to ~/.claude/plans, which the boundary denies: keep them in the run folder.
      // No skill or command runs shell commands as it loads (`!` substitutions): the owner approves every command.
      settings: { ...boundary.settings(deps.allowBypass ?? false), plansDirectory: PLANS_DIR, disableSkillShellExecution: true },
      // The boundary's authority: runs before every tool call, auto-approved ones (acceptEdits, rules) included.
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (hookInput) => {
                const call = hookInput as PreToolUseHookInput;
                const toolInput = (call.tool_input ?? {}) as Record<string, unknown>;
                if (call.hook_event_name !== "PreToolUse") return {};
                // The other calls of a turn that asks for an approval wait for its answer.
                if (call.tool_name === REQUEST_APPROVAL_TOOL) expectApproval();
                else if (!(await turnApproved())) {
                  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: TURN_DENIED } };
                }
                // Relative paths are against the CLI's own current directory (after any `cd`).
                const current = typeof call.cwd === "string" ? call.cwd : null;
                const edit = boundary.editDecision(call.tool_name, toolInput, current);
                if (edit === "ask") {
                  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: READ_ASK } };
                }
                if (edit === "deny") {
                  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: PROTECTED_DENIAL } };
                }
                const read = boundary.readDecision(call.tool_name, toolInput, current);
                if (read === "deny") {
                  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: READ_DENIAL } };
                }
                if (read === "ask") {
                  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: READ_ASK } };
                }
                // Inside the allowlist (a skill's own files under plugins/ included): read without a prompt.
                if (read === "allow") return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
                // The CLI auto-approves some commands (cp, mv, sed in acceptEdits): every one goes to the owner instead.
                if (SHELL_TOOLS.has(call.tool_name) && start.permissionMode !== "bypassPermissions") {
                  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: SHELL_ASK } };
                }
                if (protectedArgs(call.tool_name, toolInput)) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: PROTECTED_DENIAL } };
                // Even where a rule (the user's settings) would allow it.
                if (isMcpTool(call.tool_name) && !isJobTool(call.tool_name) && start.permissionMode !== "bypassPermissions") {
                  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: MCP_ASK } };
                }
                return {};
              },
            ],
          },
        ],
      },
      ...(deps.claudePath ? { pathToClaudeCodeExecutable: deps.claudePath } : {}),
      ...(deps.env ? { env: deps.env } : {}),
    },
  });
  onQuery(q);
  // An empty prompt (a chat whose trigger has no instructions) is no turn: the owner's first
  // message is. Until it comes, the chat waits between turns, like after any turn.
  if (start.prompt || !start.interactive) say(start.prompt);
  else emit({ type: "turn-end" });
  const servers = deps.mcpServers ?? {};
  if (Object.keys(servers).length === 0) openGate();
  else {
    // Over the SDK's control channel, never the CLI's command line (`--mcp-config`), where any
    // user of the machine could read the headers. `dispand` goes last: it stays ours.
    q.setMcpServers({ ...servers, ...sdkServers }).then(
      (set) => {
        // Not the CLI's message: it may quote the server's URL or answer.
        const failed = Object.keys(servers).find((name) => Object.hasOwn(set.errors, name));
        if (failed) finish({ type: "error", message: `the MCP server ${failed} didn't connect` });
      },
      () => finish({ type: "error", message: "the session's MCP servers couldn't be set up" }),
    ).finally(openGate);
  }

  /** The session's last event: queued turns are dropped, the CLI stops, later events are dropped. */
  function finish(event: HarnessEvent) {
    emit(event);
    finished = true;
    input.close();
    unanswered.length = 0;
    unansweredBytes.clear();
    turnAbort.abort();
    // Ends the CLI itself: messages it already took in never run.
    queryAbort.abort();
  }

  function turnEnded(msg: Extract<SDKMessage, { type: "result" }>) {
    // A turn's end leaves nothing pending for the next one.
    approval?.settle(false);
    approval = null;
    const wasInterrupted = interrupted;
    interrupted = false;
    answered(msg);
    outcome.turnEnded({
      // A cut turn, whatever the result's subtype: interrupted from here, or aborted mid-stream.
      interrupted: wasInterrupted || msg.terminal_reason === "aborted_streaming" || msg.terminal_reason === "aborted_tools",
      // A failed turn can come as subtype "success" with is_error (an API error): its text says why.
      ...(msg.subtype !== "success" || msg.is_error ? { error: (msg.subtype === "success" ? msg.result : msg.errors.join("; ")) || msg.subtype } : {}),
      text: msg.subtype === "success" ? msg.result : "",
      queued: unanswered.length > 0,
    });
  }

  const toolNames = new Map<string, string>();
  const done = (async () => {
    try {
      for await (const msg of q) {
        if (msg.type === "system" && msg.subtype === "init") {
          emit({ type: "cli-session", cliSessionId: msg.session_id });
          const failure = pluginFailure(msg.plugin_errors, pluginRoots);
          if (failure) finish({ type: "error", message: failure });
        }
        // Subagents' own text and tools stay inside the tool that runs them.
        else if (msg.type === "stream_event" && msg.parent_tool_use_id === null) {
          const e = msg.event;
          if (e.type === "content_block_delta" && e.delta.type === "text_delta") emit({ type: "text", delta: e.delta.text });
        } else if (msg.type === "assistant" && msg.parent_tool_use_id === null) {
          for (const block of msg.message.content) {
            if (block.type !== "tool_use") continue;
            toolNames.set(block.id, block.name);
            emit({ type: "tool", name: block.name, status: "started" });
          }
        } else if (msg.type === "user" && Array.isArray(msg.message.content)) {
          for (const block of msg.message.content) {
            if (block.type !== "tool_result") continue;
            const name = toolNames.get(block.tool_use_id);
            if (name) {
              emit({ type: "tool", name, status: "done" });
              toolNames.delete(block.tool_use_id);
            }
          }
        } else if (msg.type === "result") turnEnded(msg);
      }
      // The CLI only exits by itself after a result, or once the input is closed.
      // In streaming mode the CLI only exits once its input is closed: any other exit, after a
      // result or not, leaves the session unfinished.
      if (!input.isClosed()) finish({ type: "error", message: "the CLI exited before the session finished" });
    } catch (err) {
      finish({ type: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      input.close();
      questions.endAll();
    }
  })();

  return {
    send(text) {
      // Every error is terminal for the engine, so the session ends with it.
      const waiting = [...unansweredBytes.values()].reduce((a, b) => a + b, 0);
      if (unanswered.length > MAX_WAITING || waiting + Buffer.byteLength(text) > MAX_WAITING_BYTES) return finish({ type: "error", message: "too many messages waiting for the agent: the session was stopped" });
      say(text);
    },
    narrowPermissions: (servers) => { permissionsVersion++; narrowUnasked(unasked, agentServers.filter((s) => s !== "job_tools"), servers); },
    answer: questions.answer,
    interrupt: async () => {
      // Idle: nothing to cut short, and no later error may pass for an interrupted turn.
      if (unanswered.length === 0) return;
      interrupted = true;
      turnAbort.abort();
      turnAbort = new AbortController();
      await q.interrupt();
    },
    close: () => input.close(),
    toolsInFlight: () => toolNames.size,
    stop: (message) => finish({ type: "error", message }),
    abort() {
      // Nothing more is emitted: what was already emitted is in the backlog.
      finished = true;
      input.close();
      unanswered.length = 0;
      unansweredBytes.clear();
      turnAbort.abort();
      queryAbort.abort();
    },
    done,
  };
}
