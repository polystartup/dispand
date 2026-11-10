import { z } from "zod";
import { id, jsonObject, record, short, string, text } from "./bounds.ts";
import { Answer, HarnessEvent, OutputField } from "./harness.ts";

/**
 * Sent by the runner as the `Dispand-Protocol` header when it connects. Bumped by every
 * change a runner of the previous version can't parse or honor; the hub turns older runners away.
 */
export const PROTOCOL_VERSION = 8;

/** A message that isn't valid JSON or doesn't match the protocol. */
export class ProtocolError extends Error {
  override name = "ProtocolError";
}

/** Event seqs: any safe integer, stored in Postgres `bigint` columns (`runners.last_seq`, `runner_events.seq`). */
const MAX_SEQ = Number.MAX_SAFE_INTEGER;

/** The most sessions a runner runs at once: `hello` lists them all. */
export const MAX_LIVE_SESSIONS = 1000;

/** The name the runner gives Dispand's Job server among a session's MCP servers: its tools are `mcp__job__<tool>`. */
export const JOB_SERVER_NAME = "job";
/** The name of the second server a Job's session gets: its agent's tools reached by URL, called on Dispand's server. Their calls ask the owner. */
export const JOB_TOOLS_SERVER = "job_tools";

/** An MCP server name: one key of the CLI's `mcpServers`, never the runner's own `dispand` (submit_outputs) or `job` (the Job server). */
export const McpServerName = id()
  .regex(/^[a-zA-Z0-9_-]{1,64}$/)
  .refine((n) => n !== "dispand" && n !== JOB_SERVER_NAME && n !== JOB_TOOLS_SERVER, "reserved name");

/**
 * The name a session's MCP server gets in the CLI: words joined by single `_`, so never `__`
 * inside and never `_` at either end. A CLI names a tool `mcp__<server>__<tool>`: with such
 * names, only the server `job` gives tools that start with `mcp__job__` (`job__x` and `job_`
 * would too, and pass for the Job server's).
 */
const SessionServerName = McpServerName.regex(/^[a-zA-Z0-9-]+(?:_[a-zA-Z0-9-]+)*$/, "a server name is words joined by single underscores");

/** An MCP server a session gets: by URL (with its headers), or one of the runner's own (`mcpServers` in its config). */
export const McpServerRef = z.discriminatedUnion("type", [
  z.object({
    name: SessionServerName,
    type: z.literal("http"),
    url: string(2048).url(),
    transport: z.enum(["streamable-http", "sse"]),
    headers: record(short(), 20),
  }),
  z.object({ name: SessionServerName, type: z.literal("runner"), tool: McpServerName }),
]);
export type McpServerRef = z.infer<typeof McpServerRef>;

/** One action (tool) an MCP server offers. */
export const McpAction = z.object({
  name: id(),
  description: short(),
  inputSchema: jsonObject(64 * 1024),
});
export type McpAction = z.infer<typeof McpAction>;

/** What every session start carries, whatever its CLI. */
const StartFields = {
  sessionId: id().min(1),
  // Sessions run only in a fresh folder the runner creates, `<root>/runs/<runKey>`: the key is
  // one path segment, never `..` or a separator.
  cwd: z.object({ mode: z.literal("per-run"), runKey: id().regex(/^[A-Za-z0-9_-]+$/) }),
  systemPrompt: text(),
  prompt: text(),
  // Each name is one key of the agent's submit_outputs input: a repeated one is refused.
  expectedOutputs: z
    .array(OutputField)
    .max(100)
    .refine((fields) => new Set(fields.map((f) => f.name)).size === fields.length, "duplicate output name"),
  interactive: z.boolean(),
  resumeCliSessionId: id().min(1).optional(),
  model: id().optional(),
  /** Skill packages the runner fetches from Dispand, by id; each name is one path segment. */
  skills: z.array(z.object({ packageId: id().min(1), name: id().regex(/^[a-zA-Z0-9_-]{1,64}$/) })).max(50),
  mcpServers: z.array(McpServerRef).max(20),
  /**
   * The session works for a Job: the runner gives it Dispand's Job server (`/mcp/job` of the
   * runner's own configured server, never an address from this message) with this token, and
   * lets that server's tools run without a question. A token is all the server can say here.
   */
  jobToken: id()
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  /**
   * With a Job token: the tools of the Job's tools server (`job_tools`) that run without a
   * question, by their name there. The runner makes the CLI's names itself
   * (`mcp__job_tools__<name>`), so nothing here can name a command, a file tool or another
   * server's tool. It only spares prompts: the server decides alone whether a call runs.
   */
  unasked: z
    .array(
      id()
        .regex(/^[a-z0-9_-]{1,48}$/)
        .refine((n) => !n.includes("__"), "no double underscore"),
    )
    .max(500)
    .optional(),
};

export const ClaudePermissionMode = z.enum(["default", "acceptEdits", "plan", "bypassPermissions"]);
export const CodexPermissionMode = z.enum(["default", "bypassPermissions"]);

/** Everything the runner needs to start a CLI session. */
export const SessionStart = z.discriminatedUnion("harness", [
  z.object({ ...StartFields, harness: z.literal("claude-code"), permissionMode: ClaudePermissionMode }),
  z.object({ ...StartFields, harness: z.literal("codex"), permissionMode: CodexPermissionMode }),
]);
export type SessionStart = z.infer<typeof SessionStart>;
export type ClaudeSessionStart = Extract<SessionStart, { harness: "claude-code" }>;

export const ServerToRunner = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.start"), start: SessionStart }),
  z.object({ type: z.literal("session.send"), sessionId: id(), text: text() }),
  z.object({ type: z.literal("session.answer"), sessionId: id(), questionId: id(), answer: Answer }),
  z.object({ type: z.literal("session.interrupt"), sessionId: id() }),
  /** Ends the session now (its run was stopped): the CLI is stopped, and nothing is said back for a session that isn't running. */
  z.object({ type: z.literal("session.stop"), sessionId: id() }),
  z.object({ type: z.literal("ack"), seq: z.int().min(0).max(MAX_SEQ) }),
  /** Lists a runner tool's actions (not numbered, not acked: a lost reply times out on the server). */
  z.object({ type: z.literal("tool.discover"), requestId: id().min(1), tool: McpServerName }),
]);
export type ServerToRunner = z.infer<typeof ServerToRunner>;

export const RunnerToServer = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    runnerVersion: id(),
    clis: z.object({ claude: id().optional(), codex: z.object({ version: id(), signedIn: z.boolean() }).optional() }),
    /** The names of the runner's own MCP servers (`mcpServers` in its config). */
    tools: z.array(McpServerName).max(100),
    liveSessions: z.array(id()).max(MAX_LIVE_SESSIONS),
    /** The highest seq among the events the runner resends after this `hello` (0: none). */
    lastSeq: z.int().min(0).max(MAX_SEQ),
  }),
  z.object({ type: z.literal("event"), seq: z.int().min(1).max(MAX_SEQ), sessionId: id(), event: HarnessEvent }),
  /** The reply to `tool.discover`: its actions, or why they couldn't be listed. */
  z.object({ type: z.literal("tool.discovered"), requestId: id().min(1), actions: z.array(McpAction).max(200).optional(), error: short().optional() }),
]);
export type RunnerToServer = z.infer<typeof RunnerToServer>;

function parse<T>(schema: z.ZodType<T>, raw: string): T {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ProtocolError("Message is not valid JSON");
  }
  const result = schema.safeParse(json);
  if (!result.success) throw new ProtocolError(`Invalid message: ${z.prettifyError(result.error)}`);
  return result.data;
}

export function parseServerMessage(raw: string): ServerToRunner {
  return parse(ServerToRunner, raw);
}

export function parseRunnerMessage(raw: string): RunnerToServer {
  return parse(RunnerToServer, raw);
}
