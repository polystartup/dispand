import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { logError } from "./log.ts";
import { startTelemetry, stopTelemetry } from "./telemetry/index.ts";
import { captureTelemetry } from "./telemetry/testing.ts";

afterEach(() => stopTelemetry());

/** What telemetry prints to the output, as the app starts it without a collector. */
function printed() {
  startTelemetry({ console: true });
  const dir = vi.spyOn(console, "dir").mockImplementation(() => {});
  return () => {
    const calls = [...dir.mock.calls];
    dir.mockRestore();
    return calls.map(([record]) => record as { body: unknown; attributes: Record<string, unknown> });
  };
}

test("logError prints the error's kind, code and constraint once, never its message or params", () => {
  const records = printed();
  const cause = Object.assign(new Error('value "secret" violates'), { code: "23505", constraint: "runners_token_hash_unique" });
  const err = Object.assign(new Error("Failed query: insert … params: secret"), { cause, name: "DrizzleQueryError" });
  logError("runner message failed", err, { runnerId: "runner_1" });
  const logged = records();
  expect(JSON.stringify(logged)).not.toContain("secret");
  expect(logged).toHaveLength(1);
  expect(logged[0]).toMatchObject({
    body: "runner message failed",
    attributes: { runnerId: "runner_1", "error.type": "DrizzleQueryError", "error.cause": "Error", "db.response.status_code": "23505", "error.constraint": "runners_token_hash_unique" },
  });
});

test("nothing derived from error text is logged, even a forged stack frame", () => {
  const records = printed();
  // A sessionId chosen by the runner ends up in Drizzle's message, and so in the stack.
  const err = new Error('Failed query: insert … params: ses\nat secret-payload (file.ts:1:1)');
  err.stack = `Error: ${err.message}\n    at real (hub.ts:1:1)`;
  Object.assign(err, { code: "secret code", constraint: "x; secret", cause: Object.assign(new Error("secret"), { name: "secret name!" }) });
  logError("runner message failed", err, { runnerId: "runner_1" });
  const logged = records();
  expect(JSON.stringify(logged)).not.toMatch(/secret|at |hub\.ts/);
  expect(logged.map((r) => [r.body, r.attributes])).toEqual([["runner message failed", { runnerId: "runner_1", "error.type": "Error", "error.cause": "Error" }]]);
});

test("the domain logs only through logError", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [join(dir, e.name)] : [],
    );
  const offenders = files(import.meta.dirname)
    .filter((file) => !file.endsWith("/log.ts"))
    .filter((file) => /\bconsole\.\w+/.test(readFileSync(file, "utf8")))
    .map((file) => relative(import.meta.dirname, file));
  expect(offenders).toEqual([]);
});

test("a logged error is also a log record, with the same fields and never the error's text", async () => {
  const t = await captureTelemetry();
  const cause = Object.assign(new Error('value "secret" violates'), { code: "23505", constraint: "runners_token_hash_unique" });
  logError("runner message failed", Object.assign(new Error("params: secret"), { cause, name: "DrizzleQueryError" }), { runnerId: "runner_1" });
  const [record] = t.logs();
  expect(record!.body).toBe("runner message failed");
  expect(record!.attributes).toEqual({ runnerId: "runner_1", "error.type": "DrizzleQueryError", "error.cause": "Error", "db.response.status_code": "23505", "error.constraint": "runners_token_hash_unique" });
  expect(await t.all()).not.toContain("secret");
});
