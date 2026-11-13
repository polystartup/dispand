// A client for `codex app-server`: JSONL over its stdio, JSON-RPC 2.0 without the `jsonrpc`
// field. Protocol types are generated from the pinned Codex (`pnpm codex:types`), never written by hand.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import pkg from "../../package.json" with { type: "json" };
import type { ClientRequest } from "./protocol/ClientRequest.ts";
import type { InitializeResponse } from "./protocol/InitializeResponse.ts";
import type { ServerNotification } from "./protocol/ServerNotification.ts";
import type { ServerRequest } from "./protocol/ServerRequest.ts";
import type { GetAccountResponse } from "./protocol/v2/GetAccountResponse.ts";
import type { ThreadResumeResponse } from "./protocol/v2/ThreadResumeResponse.ts";
import type { ThreadStartResponse } from "./protocol/v2/ThreadStartResponse.ts";
import type { TurnStartResponse } from "./protocol/v2/TurnStartResponse.ts";

type Method = ClientRequest["method"];
export type ParamsOf<M extends Method> = Extract<ClientRequest, { method: M }>["params"];

/** The result type of each request the runner sends (the generated protocol has no such map). */
interface Results {
  "model/list": import("./protocol/v2/ModelListResponse.ts").ModelListResponse;
  initialize: InitializeResponse;
  "account/read": GetAccountResponse;
  "thread/start": ThreadStartResponse;
  "thread/resume": ThreadResumeResponse;
  "turn/start": TurnStartResponse;
}
export type ResultOf<M extends Method> = M extends keyof Results ? Results[M] : unknown;

/** Server requests no handler may answer: the runner never hands Codex credentials or attestations. */
const REFUSED = new Set<string>(["account/chatgptAuthTokens/refresh", "attestation/generate"]);

type Pending = { resolve: (result: unknown) => void; reject: (err: Error) => void };
type Incoming = { id?: string | number; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string } };

export class CodexRpc {
  readonly exited: Promise<void>;
  private nextId = 1;
  private pending = new Map<string | number, Pending>();
  private gone = false;
  private notified: (n: ServerNotification) => void = () => {};
  private serverRequest: ((r: ServerRequest) => Promise<unknown>) | undefined;

  private child: ChildProcessWithoutNullStreams;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.exited = new Promise((resolve) => {
      const end = () => {
        if (this.gone) return;
        this.gone = true;
        for (const p of this.pending.values()) p.reject(new Error("codex app-server exited"));
        this.pending.clear();
        resolve();
      };
      child.on("exit", end);
      child.on("error", end);
    });
    // A write after the process died: the exit rejects what was pending.
    child.stdin.on("error", () => {});
    child.stderr.resume();
    createInterface({ input: child.stdout }).on("line", (line) => this.receive(line));
  }

  /**
   * Starts `codex app-server` in `cwd` and completes the handshake (`initialize`, then
   * `initialized`) before anything else is sent. Once `signal` aborts, the process is stopped,
   * during the handshake or after it, and what was pending rejects.
   */
  static async spawn(codexPath: string, env: NodeJS.ProcessEnv, cwd: string, signal?: AbortSignal): Promise<CodexRpc> {
    const rpc = new CodexRpc(spawn(codexPath, ["app-server"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] }));
    if (signal) {
      const stop = () => void rpc.close();
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
      void rpc.exited.then(() => signal.removeEventListener("abort", stop));
    }
    try {
      await rpc.request("initialize", {
        clientInfo: { name: "dispand-runner", title: null, version: pkg.version },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
    } catch (err) {
      await rpc.close();
      throw err;
    }
    rpc.write({ method: "initialized" });
    return rpc;
  }

  request<M extends Method>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    if (this.gone) return Promise.reject(new Error("codex app-server exited"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject });
      this.write({ id, method, params });
    });
  }

  onNotification(h: (n: ServerNotification) => void): void {
    this.notified = h;
  }

  onServerRequest(h: (r: ServerRequest) => Promise<unknown>): void {
    this.serverRequest = h;
  }

  async close(): Promise<void> {
    if (!this.gone) {
      this.child.stdin.end();
      this.child.kill("SIGTERM");
    }
    await this.exited;
  }

  private write(msg: unknown) {
    if (!this.gone) this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private receive(line: string) {
    let msg: Incoming;
    try {
      msg = JSON.parse(line) as Incoming;
    } catch {
      return;
    }
    if (typeof msg !== "object" || msg === null) return;
    if (msg.method === undefined) {
      if (msg.id === undefined) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`codex ${msg.error.message ?? "error"} (${msg.error.code ?? "?"})`));
      else p.resolve(msg.result);
    } else if (msg.id === undefined) {
      this.notified(msg as ServerNotification);
    } else {
      void this.answer(msg.id, msg as ServerRequest);
    }
  }

  private async answer(id: string | number, req: ServerRequest) {
    const handler = this.serverRequest;
    if (REFUSED.has(req.method)) return this.write({ id, error: { code: -32600, message: "refused by dispand-runner" } });
    if (!handler) return this.write({ id, error: { code: -32601, message: `${req.method} not handled` } });
    try {
      this.write({ id, result: await handler(req) });
    } catch (err) {
      this.write({ id, error: { code: -32603, message: (err as Error).message } });
    }
  }
}
