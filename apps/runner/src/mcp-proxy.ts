// The in-runner MCP proxy (`dispand-runner mcp-proxy`): a session's CLI starts it in place of a
// runner tool's stdio server, and it starts that server. Every message goes through as it came,
// but a `tools/call` result: in a Job's session, its images, audio and embedded resource blobs go
// to Dispand (`JOB_FILES_PATH`, with the Job's token) and come back as one text naming the Job's
// attachments, so the Job keeps the files and the agent gets their ids, as for its tools reached
// by URL. A relay of lines and not the SDK's Client and Server: those answer only what the proxy
// implements, and a relay leaves resources, prompts, progress, cancellations and the server's own
// requests to the two ends as they were before the proxy.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { resultRefusal } from "@dispand/runner-protocol";
import { z } from "zod";

/** What the proxy starts, as `plugin-servers.ts` `Launch`, and in a Job's session the URL its files go to. */
export const ProxySpec = z.object({
  command: z.string().min(1),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  cwd: z.string().min(1),
  files: z.string().url().optional(),
});
export type ProxySpec = z.infer<typeof ProxySpec>;

/** The variables the proxy reads (its spec, and the Job's token), never passed on to the server it starts. */
export const PROXY_SPEC = "DISPAND_PROXY";
export const PROXY_TOKEN = "DISPAND_JOB_TOKEN";

export const FILES_FAILED = "The call ran, but the files it returned couldn't be kept.";
const UPLOAD_TIMEOUT_MS = 120_000;

type FileOut = { name: string; base64: string };
type Json = Record<string, unknown>;

function nameOf(uri: unknown): string {
  const path = (typeof uri === "string" ? uri : "").split(/[?#]/)[0] ?? "";
  const last = path.slice(path.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(last) || "file";
  } catch {
    return last || "file";
  }
}

/** The file a result's part carries, if it is one: an image, audio, or an embedded resource with a blob. */
function fileOf(part: unknown): FileOut | null {
  if (typeof part !== "object" || part === null) return null;
  const p = part as Json;
  if ((p.type === "image" || p.type === "audio") && typeof p.data === "string") return { name: p.type, base64: p.data };
  const resource = p.resource as Json | undefined;
  if (p.type === "resource" && typeof resource?.blob === "string") return { name: nameOf(resource.uri), base64: resource.blob };
  return null;
}

/** Sends one result's files to Dispand; the text the agent gets in their place, or a fixed reason. */
export async function sendFiles(url: string, token: string, files: FileOut[]): Promise<string> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ files }),
      redirect: "error",
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel();
      return FILES_FAILED;
    }
    const { text } = (await res.json()) as { text?: unknown };
    return typeof text === "string" ? text : FILES_FAILED;
  } catch {
    return FILES_FAILED;
  }
}

/**
 * The result with its files taken out and one text in their place: Dispand's (`keep`), or why
 * none is kept when the result passes a per-result limit, checked here before anything is sent.
 * A result without files is returned as it is.
 */
export async function withoutFiles(result: Json, keep: (files: FileOut[]) => Promise<string>): Promise<Json> {
  const content = Array.isArray(result.content) ? (result.content as unknown[]) : [];
  const files = content.map(fileOf);
  const found = files.filter((f): f is FileOut => f !== null);
  if (found.length === 0) return result;
  const refused = resultRefusal(found.map((f) => ({ name: f.name, size: Buffer.byteLength(f.base64, "base64") })));
  const text = refused ?? (await keep(found));
  // Counts only: no name, no content (the CLI keeps a server's stderr in its logs).
  console.error(`dispand-runner: mcp-proxy: ${found.length} files in a result, ${refused ? "refused" : "sent to Dispand"}`);
  // Files lost on the way are an error, as on Dispand's own tools endpoint; a refusal is the result's text.
  return { ...result, content: [...content.filter((_, i) => files[i] === null), { type: "text", text }], ...(text === FILES_FAILED ? { isError: true } : {}) };
}

function parse(line: string): Json | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
  } catch {
    return null;
  }
}

/**
 * Runs `spec`'s server and relays between it and `input`/`output` (the CLI) until it exits;
 * resolves with its exit code. The server gets the proxy's environment without any `DISPAND_*`
 * variable, plus its own `env`, and starts in `spec.cwd`. Without a token or a files URL (a
 * session without a Job), results go through untouched.
 */
export function runProxy(spec: ProxySpec, token: string | undefined, input: Readable = process.stdin, output: Writable = process.stdout): Promise<number> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DISPAND_")));
  const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: { ...env, ...spec.env }, stdio: ["pipe", "pipe", "inherit"] });
  // The CLI stopping the proxy stops its server, as when it ran the server itself.
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => child.kill(signal));
  const keep = spec.files && token ? (files: FileOut[]) => sendFiles(spec.files!, token, files) : undefined;
  /** The ids of the CLI's `tools/call` requests still waiting for their response. */
  const calls = new Set<string>();
  const fromCli = createInterface({ input, crlfDelay: Infinity });
  fromCli.on("line", (line) => {
    const msg = keep ? parse(line) : null;
    if (msg?.method === "tools/call" && msg.id !== undefined) calls.add(JSON.stringify(msg.id));
    child.stdin.write(`${line}\n`);
  });
  fromCli.on("close", () => child.stdin.end());
  child.stdin.on("error", () => undefined);
  // Every line to the CLI in the order the server sent it: a result being kept holds back what follows.
  let written = Promise.resolve();
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    const msg = keep ? parse(line) : null;
    const response = msg && msg.method === undefined && msg.id !== undefined && calls.delete(JSON.stringify(msg.id));
    written = written.then(async () => {
      const out = response && typeof msg.result === "object" && msg.result !== null ? JSON.stringify({ ...msg, result: await withoutFiles(msg.result as Json, keep!) }) : line;
      // Written out before the next: the proxy exits once the last line is through.
      await new Promise<void>((done) => output.write(`${out}\n`, () => done()));
    });
  });
  return new Promise((resolve) => {
    child.on("error", () => {
      console.error(`dispand-runner: mcp-proxy: the server didn't start`);
      resolve(1);
    });
    child.on("close", (code) => void written.then(() => resolve(code ?? 1)));
  });
}
