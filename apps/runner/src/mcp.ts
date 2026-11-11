// The MCP servers a session gets: by URL from Dispand, or the runner's own (runner tools).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { Client, type Tool } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { JOB_SERVER_NAME, JOB_TOOLS_SERVER, McpAction, type McpServerRef, SHORT } from "@dispand/runner-protocol";
import { overlapping, type RunnerConfig } from "./config.ts";
import type { JsonValue } from "./codex/protocol/serde_json/JsonValue.ts";
import { cleanJson, FRAME_BUDGET, protocolString } from "./sanitize.ts";

export type LocalServer = NonNullable<RunnerConfig["mcpServers"]>[string];

/** A session's MCP server the runner won't give it: the session ends before its CLI starts. */
export class ToolRefused extends Error {
  override name = "ToolRefused";
}

/**
 * `refs` plus Dispand's two servers when the session has a Job token: always `/mcp/job` and
 * `/mcp/job/tools` of this runner's own configured server, with the token as their bearer. The address is never the
 * start's to give, so a start can't make the runner send the token, or the tools' unasked
 * calls, anywhere else.
 */
export function withJobServer(refs: McpServerRef[], server: string, jobToken: string | undefined): McpServerRef[] {
  if (jobToken === undefined) return refs;
  const headers = { authorization: `Bearer ${jobToken}` };
  const ours = (name: string, path: string): McpServerRef => ({ name, type: "http", url: new URL(path, server).href, transport: "streamable-http", headers });
  // `job`: Dispand's own tools, which run unasked. `job_tools`: the agent's tools reached by URL,
  // called on Dispand's server; each of their calls asks the owner, like any other MCP tool.
  return [...refs, ours(JOB_SERVER_NAME, "/mcp/job"), ours(JOB_TOOLS_SERVER, "/mcp/job/tools")];
}

/**
 * The CLI's MCP servers for `refs`, in the SDK's shapes. A runner tool is the machine's own
 * server of that name (`mcpServers` in its config): the server names one, and never says what
 * it runs. It starts from `dir` (the home folder), never the CLI's working directory, where the
 * agent can write files its command would load (`.npmrc`, `package.json`): `sh` changes to it
 * and runs the command. An unknown one, or a name given twice, throws `ToolRefused`.
 */
export function mcpConfigFor(refs: McpServerRef[], local: RunnerConfig["mcpServers"], dir = homedir()): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const ref of refs) {
    if (ref.name in out) throw new ToolRefused(`the MCP server name ${ref.name} is given twice`);
    if (ref.type === "http") {
      out[ref.name] = { type: ref.transport === "sse" ? "sse" : "http", url: ref.url, headers: ref.headers };
      continue;
    }
    const server = Object.hasOwn(local ?? {}, ref.tool) ? local![ref.tool] : undefined;
    if (!server) throw new ToolRefused(`this runner has no MCP server ${ref.tool} in its config`);
    out[ref.name] = { type: "stdio", command: "/bin/sh", args: ["-c", 'cd "$1" && shift && exec "$@"', "sh", dir, server.command, ...(server.args ?? [])], env: server.env ?? {} };
  }
  return out;
}

/**
 * The same servers as Codex's `mcp_servers`, and the environment their header values go in: an
 * HTTP server's headers are named in `env_http_headers` (`DISPAND_MCP_<i>_<j>`), so the
 * values travel in the app-server's environment, never in `thread/start`, and Codex keeps
 * `DISPAND_*` out of shells. Codex has no SSE transport: such a server is refused.
 */
export function codexMcpServers(refs: McpServerRef[], local: RunnerConfig["mcpServers"], dir = homedir()): { servers: Record<string, JsonValue>; env: Record<string, string> } {
  const servers: Record<string, JsonValue> = {};
  const env: Record<string, string> = {};
  Object.entries(mcpConfigFor(refs, local, dir)).forEach(([name, config], i) => {
    if (config.type === "sse") throw new ToolRefused(`Codex can't use the MCP server ${name}: it only speaks SSE`);
    if (config.type === "http") {
      const names: Record<string, string> = {};
      Object.entries(config.headers ?? {}).forEach(([header, value], j) => {
        names[header] = `DISPAND_MCP_${i}_${j}`;
        env[`DISPAND_MCP_${i}_${j}`] = value;
      });
      servers[name] = { url: config.url, env_http_headers: names };
    } else if (config.type === "stdio" || config.type === undefined) {
      servers[name] = { command: config.command, args: config.args ?? [], env: config.env ?? {} };
    }
  });
  return { servers, env };
}

export const DISCOVER_TIMEOUT_MS = 30_000;
/** As Dispand's own listing of HTTP tools (`packages/domain/src/tools/mcp.ts`). */
const MAX_ACTIONS = 200;
const MAX_PAGES = 64;
const MAX_SCHEMA_BYTES = 64 * 1024;
/** What `tool.discovered` may hold, well inside a frame. */
const MAX_REPLY_BYTES = FRAME_BUDGET - 64 * 1024;

/** A failed listing, with the runner's own words: never the server's output, which may quote its keys. */
export class DiscoverFailed extends Error {
  override name = "DiscoverFailed";
}

/**
 * `value` with each of `secrets` (the server's `env` values, 4 characters or more) replaced by
 * "••••" in every string and key: the server has them, and may echo them in what it lists.
 */
function redact<T>(value: T, secrets: string[]): T {
  if (secrets.length === 0) return value;
  const clean = (v: unknown): unknown => {
    if (typeof v === "string") return secrets.reduce((text, secret) => text.replaceAll(secret, "••••"), v);
    if (Array.isArray(v)) return v.map(clean);
    if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, item]) => [clean(k), clean(item)]));
    return v;
  };
  return clean(value) as T;
}

/** One listed tool as an action, each field redacted on its own (the envelope keeps its keys). */
function action(tool: Tool, secrets: string[]): McpAction {
  const name = protocolString(redact(tool.name, secrets), Infinity);
  const inputSchema = cleanJson(redact(tool.inputSchema, secrets), Infinity);
  if (JSON.stringify(inputSchema).length > MAX_SCHEMA_BYTES) throw new DiscoverFailed(`the schema of the action ${name.slice(0, 100)} is larger than 64 KiB`);
  const parsed = McpAction.safeParse({ name, description: protocolString(redact(tool.description ?? "", secrets), SHORT), inputSchema, ...(tool.annotations?.readOnlyHint === true ? { readOnly: true } : {}) });
  if (!parsed.success) throw new DiscoverFailed(`the action ${name.slice(0, 100)} isn't valid`);
  return parsed.data;
}

/**
 * Lists the actions of one of the machine's own MCP servers: starts it as its config says, with
 * the environment an MCP client gives by default plus its `env`, its stderr dropped, and stops
 * it again. The whole of it ends at `timeoutMs`.
 */
export async function discoverTool(name: string, server: LocalServer, timeoutMs = DISCOVER_TIMEOUT_MS): Promise<McpAction[]> {
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args ?? [],
    env: { ...getDefaultEnvironment(), ...server.env },
    stderr: "ignore",
    cwd: homedir(),
  });
  const client = new Client({ name: "dispand-runner", version: "1.0.0" });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DiscoverFailed(`the MCP server ${name} didn't answer in time`)), timeoutMs);
  });
  try {
    const tools = await Promise.race([
      (async () => {
        await client.connect(transport, { timeout: timeoutMs });
        const all: Tool[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
          const listed = await client.request({ method: "tools/list", params: cursor === undefined ? {} : { cursor } }, { timeout: timeoutMs });
          all.push(...listed.tools);
          if (all.length > MAX_ACTIONS) throw new DiscoverFailed(`the MCP server ${name} offers more than ${MAX_ACTIONS} actions`);
          cursor = listed.nextCursor;
          if (!cursor) return all;
        }
        throw new DiscoverFailed(`the MCP server ${name} lists its actions on more than ${MAX_PAGES} pages`);
      })(),
      deadline,
    ]);
    // Redacted before anything reads them, error messages included.
    const secrets = [...new Set(Object.values(server.env ?? {}).filter((v) => v.length >= 4))].sort((a, b) => b.length - a.length);
    const actions = tools.map((tool) => action(tool, secrets));
    if (Buffer.byteLength(JSON.stringify(actions)) > MAX_REPLY_BYTES) throw new DiscoverFailed(`the actions of the MCP server ${name} are too large to send`);
    return actions;
  } catch (error) {
    if (error instanceof DiscoverFailed) throw error;
    throw new DiscoverFailed(`the MCP server ${name} didn't start or failed while listing its actions`);
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

export const CALL_TIMEOUT_MS = 30_000;

/** A call the runner refused or that failed, with the runner's own words. */
export class CallFailed extends Error {
  override name = "CallFailed";
}

/**
 * Calls one action of one of the machine's own MCP servers, for a poll: starts it as listing
 * does, and calls the action only if the server marks it read-only (`readOnlyHint`) or the
 * server's `pollable` in the runner's config names it; a `pollable` left empty forbids every
 * call. The reply is redacted of the server's `env` values and must fit a frame. The whole of it
 * ends at `timeoutMs`.
 */
export async function callTool(
  name: string,
  server: LocalServer,
  actionName: string,
  args: Record<string, unknown>,
  guard: { forbidden: string[]; secrets: string[] } = { forbidden: [], secrets: [] },
  timeoutMs = CALL_TIMEOUT_MS,
): Promise<{ content: Record<string, unknown>[]; isError: boolean }> {
  if (server.pollable?.length === 0) throw new CallFailed(`the MCP server ${name} allows no polls on this runner`);
  // No approval stands between a poll and its call: a path the runner keeps sessions out of
  // (its own config, the CLIs' credentials) is refused in any argument, as sessions are kept from it.
  const paths = pathsIn(args);
  if (paths === null || paths.some((path) => overlapping(path, guard.forbidden))) throw new CallFailed(`the call names a path this runner keeps out of reach`);
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args ?? [],
    env: { ...getDefaultEnvironment(), ...server.env },
    stderr: "ignore",
    cwd: homedir(),
  });
  const client = new Client({ name: "dispand-runner", version: "1.0.0" });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CallFailed(`the MCP server ${name} didn't answer in time`)), timeoutMs);
  });
  try {
    const result = await Promise.race([
      (async () => {
        await client.connect(transport, { timeout: timeoutMs });
        if (!server.pollable?.includes(actionName)) {
          // Read from the server itself: whatever the call asks, only what it marks read-only goes.
          let cursor: string | undefined;
          let found: Tool | undefined;
          for (let page = 0; page < MAX_PAGES && !found; page++) {
            const listed = await client.request({ method: "tools/list", params: cursor === undefined ? {} : { cursor } }, { timeout: timeoutMs });
            found = listed.tools.find((t) => t.name === actionName);
            cursor = listed.nextCursor;
            if (!cursor) break;
          }
          if (!found) throw new CallFailed(`the MCP server ${name} has no action ${actionName.slice(0, 100)}`);
          if (found.annotations?.readOnlyHint !== true) throw new CallFailed(`the action ${actionName.slice(0, 100)} of ${name} isn't read-only, and this runner's config doesn't list it as pollable`);
        }
        return client.callTool({ name: actionName, arguments: args }, { timeout: timeoutMs });
      })(),
      deadline,
    ]);
    const secrets = [...new Set([...Object.values(server.env ?? {}), ...guard.secrets].filter((v) => v.length >= 4))].sort((a, b) => b.length - a.length);
    // Each item's own keys and its `type` are MCP's envelope and stay; everything inside its
    // values, keys included, is redacted.
    const content = ((result.content ?? []) as Record<string, unknown>[]).map(
      (item) => cleanJson(Object.fromEntries(Object.entries(item).map(([k, v]) => [k, k === "type" ? v : redact(v, secrets)])), Infinity) as Record<string, unknown>,
    );
    if (content.length > 100 || Buffer.byteLength(JSON.stringify(content)) > MAX_REPLY_BYTES) throw new CallFailed(`the result of ${actionName.slice(0, 100)} is too large to send`);
    return { content, isError: result.isError === true };
  } catch (error) {
    if (error instanceof CallFailed) throw error;
    throw new CallFailed(`the MCP server ${name} didn't start or failed while calling ${actionName.slice(0, 100)}`);
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

/**
 * Every path a string in `args` could name, read every way a file reader might: as given, with its
 * percent-encoding decoded, and as a file URL; relative to the home folder, where the server
 * starts (`~` expanded). A `file:` string no reading turns into a path is refused (`null`), so a
 * spelling the guard can't read never passes it.
 */
function pathsIn(args: unknown): string[] | null {
  const out: string[] = [];
  let unreadable = false;
  const add = (p: string) => {
    const expanded = p === "~" || p.startsWith("~/") ? homedir() + p.slice(1) : p;
    out.push(isAbsolute(expanded) ? expanded : resolve(homedir(), expanded));
  };
  const walk = (v: unknown) => {
    if (typeof v === "string" && v.length > 0 && v.length <= 4096) {
      const readings = new Set<string>([v]);
      try {
        readings.add(decodeURIComponent(v));
      } catch {
        // Not percent-encoded text: read as given.
      }
      for (const r of [...readings]) {
        // The literal reading stays too: a server may read it as a path from its working directory.
        if (!/^file:/i.test(r)) continue;
        try {
          readings.add(fileURLToPath(r));
        } catch {
          // A file URL a file reader might still open: its path, decoded as text.
          const path = r.replace(/^file:\/\/[^/]*/i, "");
          if (path.startsWith("/")) readings.add(path);
          else unreadable = true;
        }
      }
      readings.forEach(add);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === "object" && v !== null) Object.values(v).forEach(walk);
  };
  walk(args);
  return unreadable ? null : out;
}

/**
 * Every string of 16 characters or more in `files` (JSON read whole, other text as one value):
 * the CLIs' and the runner's credentials, redacted from a poll's result by value, however the
 * server reached the file (another path, a link, a copy). A file that can't be read gives none.
 */
export function credentialValues(files: string[]): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string" && v.length >= 16) out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === "object" && v !== null) Object.values(v).forEach(walk);
  };
  for (const file of files) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    try {
      walk(JSON.parse(raw));
    } catch {
      walk(raw.trim());
    }
  }
  return out;
}
