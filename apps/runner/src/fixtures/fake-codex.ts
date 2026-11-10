// A stand-in for `codex` in tests: `--version`, and `app-server` speaking JSONL over stdio like
// the real one (no `jsonrpc` field). Every line it receives is appended to `FAKE_CODEX_LOG`.
// Behavior, from the environment:
// - FAKE_CODEX_VERSION: what `--version` prints after `codex-cli ` (default 0.166.0).
// - FAKE_CODEX_ACCOUNT: the `account/read` result, as JSON.
// - FAKE_CODEX_SERVER_REQUESTS: JSON array of `{ method, params }` sent as server requests
//   (ids "s0", "s1"...) once `initialized` arrives.
// - FAKE_CODEX_EXIT_ON: a method that makes it exit at once, without replying.
// - FAKE_CODEX_HANG_ON: a method it never answers.
// - FAKE_CODEX_PID: a file `app-server` writes its pid to.
// - FAKE_CODEX_ENV_LOG: a file `app-server` writes its `DISPAND_*` variables to, as JSON.
// - FAKE_CODEX_BATCH: when set, what it sends in one tick goes out in one write.
// - FAKE_CODEX_TURN_START_DELAY: milliseconds `turn/start` waits before its reply and `turn/started`.
// - FAKE_CODEX_PROFILE: the `activePermissionProfile.id` that `thread/start` and `thread/resume`
//   report (default "dispand"; empty for none, as when `sandbox_mode` is set).
// - FAKE_CODEX_TURNS: JSON array, one entry per `turn/start`: the steps that turn plays in order,
//   then `turn/completed`. A step is `{ notify, params }` (a notification), `{ request, params }`
//   (a server request, ids "r0", "r1"..., waited on), `{ waitInterrupt: true }` (until
//   `turn/interrupt`; the turn ends "interrupted") or `{ fail: "<message>" }` (it ends "failed").
//   "$THREAD", "$TURN" and "$CWD" (its working directory) in any string are replaced. Turns past the array just complete.
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const env = process.env;
if (process.argv[2] === "--version") {
  console.log(`codex-cli ${env.FAKE_CODEX_VERSION ?? "0.166.0"}`);
  process.exit(0);
}

if (env.FAKE_CODEX_PID) writeFileSync(env.FAKE_CODEX_PID, String(process.pid));
if (env.FAKE_CODEX_ENV_LOG) writeFileSync(env.FAKE_CODEX_ENV_LOG, JSON.stringify(Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith("DISPAND_")))));
let batch: string[] | undefined;
const send = (msg: unknown) => {
  const line = `${JSON.stringify(msg)}\n`;
  if (!env.FAKE_CODEX_BATCH) return void process.stdout.write(line);
  // Everything sent in one tick goes out in one write, as the real app-server's can.
  if (!batch) {
    batch = [];
    setImmediate(() => {
      process.stdout.write(batch!.join(""));
      batch = undefined;
    });
  }
  batch.push(line);
};
const account = env.FAKE_CODEX_ACCOUNT
  ? JSON.parse(env.FAKE_CODEX_ACCOUNT)
  : { account: { type: "apiKey" }, requiresOpenaiAuth: true, workspaceRouting: null };
const profile = env.FAKE_CODEX_PROFILE ?? "dispand";
type Step = { notify?: string; request?: string; params?: unknown; waitInterrupt?: boolean; fail?: string };
const turns = JSON.parse(env.FAKE_CODEX_TURNS ?? "[]") as Step[][];
let initialized = false;
let turnCount = 0;
let requestCount = 0;
const replies = new Map<string, () => void>();
let onInterrupt: (() => void) | undefined;

async function play(steps: Step[], threadId: string, turnId: string) {
  const fill = (v: unknown) => JSON.parse(JSON.stringify(v ?? {}).replaceAll("$THREAD", threadId).replaceAll("$TURN", turnId).replaceAll("$CWD", process.cwd())) as unknown;
  let status = "completed";
  let error: { message: string } | null = null;
  for (const step of steps) {
    if (step.notify) send({ method: step.notify, params: fill(step.params) });
    if (step.request) {
      const id = `r${requestCount++}`;
      const replied = new Promise<void>((resolve) => replies.set(id, resolve));
      send({ id, method: step.request, params: fill(step.params) });
      await replied;
    }
    if (step.waitInterrupt) {
      await new Promise<void>((resolve) => (onInterrupt = resolve));
      status = "interrupted";
    }
    if (step.fail) {
      status = "failed";
      error = { message: step.fail };
    }
  }
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], status, error } } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (env.FAKE_CODEX_LOG) appendFileSync(env.FAKE_CODEX_LOG, `${line}\n`);
  const msg = JSON.parse(line) as { id?: string | number; method?: string; params?: Record<string, unknown> };
  if (msg.method === undefined) {
    replies.get(String(msg.id))?.();
    return;
  }
  if (msg.method === env.FAKE_CODEX_EXIT_ON) process.exit(3);
  if (msg.method === env.FAKE_CODEX_HANG_ON) return;
  if (msg.method === "initialized") {
    const requests = JSON.parse(env.FAKE_CODEX_SERVER_REQUESTS ?? "[]") as { method: string; params: unknown }[];
    requests.forEach((r, i) => send({ id: `s${i}`, method: r.method, params: r.params }));
    return;
  }
  if (msg.id === undefined) return;
  const reply = (result: unknown) => send({ id: msg.id, result });
  if (msg.method === "initialize") {
    initialized = true;
    reply({ userAgent: "fake", codexHome: "/nonexistent", platformFamily: "unix", platformOs: "linux" });
  } else if (!initialized) send({ id: msg.id, error: { code: -32600, message: "Not initialized" } });
  else if (msg.method === "account/read") reply(account);
  else if (msg.method === "thread/start" || msg.method === "thread/resume") {
    const id = (msg.params?.threadId as string | undefined) ?? "thr_1";
    reply({ thread: { id }, activePermissionProfile: profile ? { id: profile, extends: ":workspace" } : null });
  } else if (msg.method === "turn/start") {
    const turnId = `turn_${turnCount}`;
    const turn = turns[turnCount++] ?? [];
    const delay = Number(env.FAKE_CODEX_TURN_START_DELAY ?? 0);
    const begin = () => {
      reply({ turn: { id: turnId, items: [], status: "inProgress", error: null } });
      send({ method: "turn/started", params: { threadId: msg.params?.threadId, turn: { id: turnId } } });
      void play(turn, msg.params?.threadId as string, turnId);
    };
    if (delay > 0) setTimeout(begin, delay);
    else begin();
  } else if (msg.method === "turn/interrupt") {
    reply({});
    onInterrupt?.();
  } else reply({});
});
