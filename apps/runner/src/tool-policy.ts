import { type Answer, JOB_TOOLS_SERVER, type QuestionPayload, type SessionStart, type SessionToolPermissions } from "@dispand/runner-protocol";
import { PROTECTED_DENIAL } from "./boundary.ts";
import { deniedTools, narrowUnasked, runnerArgumentsAllowed, unaskedTools } from "./mcp.ts";
import { fitsWhole } from "./sanitize.ts";

export const TOOL_DISABLED = "This tool action is disabled for this session.";
const TOO_LARGE = "The tool input is too large to show for approval (or holds characters that can't be shown): split it up.";

type Permission = Extract<QuestionPayload, { kind: "permission" }>;

/** A call to an MCP server's tool, as `mcp__<server>__<tool>`; `server` when the CLI names it apart (no prefix guess then). */
export type ToolCall = { name: string; server?: string; input: Permission["input"] };
export type ToolDecision = { allow: true } | { allow: false; message: string };

export type ToolPolicyOptions = {
  harness: "claude-code" | "codex";
  /** Dispand's own Job server: Dispand authorizes each of its calls itself, so the owner isn't asked. */
  jobServer?: string;
  /** With `jobServer`: the Job's tools server's tools that run without a question, by their name there. */
  unasked?: string[];
  /** Skips the question, except for the agent's own tools. */
  bypass: boolean;
  /** Paths a runner tool's arguments may not reach. */
  forbidden: string[];
  /** Where each plugin server starts: relative paths in its arguments are read from there. */
  serverDirs?: Record<string, string>;
};

/**
 * What a session does with a call to one of its MCP servers' tools, the same on every harness:
 * disabled actions and protected arguments are refused, Dispand's own tools and the actions the
 * agent lets run unasked go through, and every other call asks the owner, one call at a time.
 * Grants only narrow while the session runs (`narrow`), apart from what the owner answers here.
 */
export function toolPolicy(start: Pick<SessionStart, "mcpServers">, options: ToolPolicyOptions) {
  const { names: unasked, servers: agentServers } = unaskedTools(start.mcpServers, options.jobServer === undefined ? undefined : (options.unasked ?? []), options.harness);
  const denied = deniedTools(start.mcpServers, options.harness);
  /** Bumped by every narrowing: an answer given to a question asked before it grants nothing lasting. */
  let version = 0;
  /**
   * The server a call goes to: the CLI's own word when it names it apart (Codex), else the first
   * segment of `mcp__<server>__<tool>` (Claude Code; the check at use stops a session whose other
   * servers would make that reading ambiguous, `ambiguousServer`). Every grant and exemption is
   * matched against this exact server, never a prefix of the call's name.
   */
  const serverOf = (call: ToolCall) => call.server ?? /^mcp__(.+?)__/.exec(call.name)?.[1];
  /** The agent's server the call goes to (its tools server's, or a runner tool's), if any. */
  const agentServer = (call: ToolCall) => agentServers.find((server) => server === serverOf(call));
  const preApproved = (call: ToolCall) => unasked.get(call.name) !== undefined && unasked.get(call.name) === serverOf(call);

  /** The decision as far as it needs no question: "ask" when only the owner can say. */
  function check(call: ToolCall): "allow" | "ask" | { deny: string } {
    if (denied.blocks(call.name)) return { deny: TOOL_DISABLED };
    const server = agentServer(call);
    if (server !== undefined && server !== JOB_TOOLS_SERVER && !runnerArgumentsAllowed(call.input, options.forbidden, options.serverDirs?.[server])) return { deny: PROTECTED_DENIAL };
    if ((options.jobServer !== undefined && serverOf(call) === options.jobServer) || preApproved(call)) return "allow";
    return options.bypass && server === undefined ? "allow" : "ask";
  }

  return {
    check,
    /** `check`, then the owner's answer where it takes one. */
    async decide(call: ToolCall, ask: (payload: QuestionPayload, signal?: AbortSignal) => Promise<Answer | null>, signal?: AbortSignal): Promise<ToolDecision> {
      const verdict = check(call);
      if (verdict === "allow") return { allow: true };
      if (verdict !== "ask") return { allow: false, message: verdict.deny };
      // One of the Job's agent's tools: "always" is the owner taking that action off the agent's
      // asking ones, on the server. Here it only means this session stops asking about it too.
      const agentTool = agentServer(call) !== undefined;
      const canAlwaysAllow = agentTool && options.jobServer !== undefined;
      const asked = version;
      const payload: Permission = { kind: "permission", toolName: call.name, input: call.input, canAlwaysAllow };
      // The owner approves exactly what they see: an input that can't be shown whole isn't asked about.
      if (!fitsWhole({ type: "question", questionId: "", payload })) return { allow: false, message: TOO_LARGE };
      const answer = await ask(payload, signal);
      // Disabled while the owner was answering.
      if (denied.blocks(call.name)) return { allow: false, message: TOOL_DISABLED };
      const permission = answer?.kind === "permission" ? answer : null;
      if (permission?.remember && agentTool) {
        if (permission.decision === "deny") denied.names.add(call.name);
        else if (permission.decision === "allow" && asked === version) unasked.set(call.name, serverOf(call)!);
      }
      if (!permission || permission.decision === "deny") return { allow: false, message: permission?.message || "The owner denied this." };
      if (permission.decision === "allow-always" && canAlwaysAllow && asked === version) unasked.set(call.name, serverOf(call)!);
      return { allow: true };
    },
    /** The server's current grants: an action or server it no longer lists is lost, none is gained. */
    narrow(servers: SessionToolPermissions[]) {
      version++;
      denied.narrow(servers);
      narrowUnasked(unasked, agentServers.filter((server) => server !== JOB_TOOLS_SERVER), servers, options.harness);
    },
    /** The disabled actions known when the session starts, for a CLI that takes such a list. */
    disabled: () => [...denied.names],
  };
}
