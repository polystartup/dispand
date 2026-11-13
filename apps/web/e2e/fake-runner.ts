import {
  type HarnessEvent,
  parseServerMessage,
  PROTOCOL_VERSION,
  type RunnerToServer,
  type ServerToRunner,
} from "@dispand/runner-protocol";
import { WebSocket } from "ws";

type Message = Exclude<ServerToRunner, { type: "ack" }>;
type Hello = Extract<RunnerToServer, { type: "hello" }>;

/**
 * A runner for tests: pairs like the real one, says `hello`, then lets a test script what it
 * sends (`emit`) and read what the server asks of it (`next`, `waitFor`).
 *
 *     const runner = await FakeRunner.pair("http://localhost:3100", code);
 *     const { start } = await runner.waitFor("session.start");
 *     runner.emit(start.sessionId, { type: "text", delta: "Hello" });
 *     runner.emit(start.sessionId, { type: "question", questionId: "q1", payload: { kind: "choice", questions: [...] } });
 *     const { answer } = await runner.waitFor("session.answer");
 *
 * Events get seq 1, 2, ... and are not resent: a test that reconnects uses a new instance.
 */
export class FakeRunner {
  /** Everything received so far, in order, acks excluded. */
  readonly received: Message[] = [];
  private seq = 0;
  private cursor = 0;
  private waiters: (() => void)[] = [];
  private readonly ws: WebSocket;

  private constructor(
    readonly runnerId: string,
    readonly token: string,
    server: string,
    hello: Hello,
  ) {
    const url = new URL("/runner/ws", server);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${token}`, "dispand-protocol": String(PROTOCOL_VERSION) },
    });
    this.ws.on("open", () => this.send(hello));
    this.ws.on("message", (data) => {
      const msg = parseServerMessage(String(data));
      if (msg.type === "ack") return;
      if (msg.type === "models.request") {
        this.send({ type: "models.replied", requestId: msg.requestId, models: msg.harness === "codex" ? [{ id: "test-codex", label: "Test Codex" }] : [{ id: "sonnet", label: "Sonnet" }] });
        return;
      }
      this.received.push(msg);
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  /** Exchanges a pairing code (any case) for a token, connects and sends `hello`. */
  static async pair(server: string, code: string, clis: Hello["clis"] = { claude: "2.1.0" }, tools: string[] = []): Promise<FakeRunner> {
    const res = await fetch(new URL("/runner/pair", server), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) throw new Error(`pairing failed: HTTP ${res.status}`);
    const { runnerId, token } = (await res.json()) as { runnerId: string; token: string };
    const runner = new FakeRunner(runnerId, token, server, { type: "hello", runnerVersion: "0.0.0-test", clis, tools, liveSessions: [], lastSeq: 0 });
    await new Promise<void>((resolve, reject) => {
      runner.ws.once("open", () => resolve());
      runner.ws.once("error", reject);
    });
    return runner;
  }

  /** Sends a session event, numbered in order. */
  emit(sessionId: string, event: HarnessEvent): void {
    this.seq += 1;
    this.send({ type: "event", seq: this.seq, sessionId, event });
  }

  /** The next message not yet taken by `next` or `waitFor`. */
  async next(timeoutMs = 10_000): Promise<Message> {
    const deadline = Date.now() + timeoutMs;
    while (this.cursor >= this.received.length) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("FakeRunner: timed out waiting for a message");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.received[this.cursor++]!;
  }

  /** Takes messages until one of this type arrives and returns it (the ones before it are skipped). */
  async waitFor<T extends Message["type"]>(type: T, timeoutMs = 10_000): Promise<Extract<Message, { type: T }>> {
    for (;;) {
      const msg = await this.next(timeoutMs);
      if (msg.type === type) return msg as Extract<Message, { type: T }>;
    }
  }

  /** Answers a `tool.discover`. */
  reply(msg: Extract<RunnerToServer, { type: "tool.discovered" }>): void {
    this.send(msg);
  }

  close(): void {
    this.ws.terminate();
  }

  private send(msg: RunnerToServer): void {
    this.ws.send(JSON.stringify(msg));
  }
}
