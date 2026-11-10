import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test, vi } from "vitest";
import { logError } from "./log.ts";

test("logError keeps the error's kind, code and constraint, never its message or params", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const cause = Object.assign(new Error('value "secret" violates'), { code: "23505", constraint: "runners_token_hash_unique" });
  const err = Object.assign(new Error("Failed query: insert … params: secret"), { cause, name: "DrizzleQueryError" });
  logError("runner message failed", err, { runnerId: "runner_1" });
  const logged = JSON.stringify(error.mock.calls);
  expect(logged).not.toContain("secret");
  expect(error.mock.calls[0]?.[0]).toBe("runner message failed");
  expect(error.mock.calls[0]?.[1]).toMatchObject({
    runnerId: "runner_1",
    error: { name: "DrizzleQueryError", cause: "Error", code: "23505", constraint: "runners_token_hash_unique" },
  });
  error.mockRestore();
});

test("nothing derived from error text is logged, even a forged stack frame", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  // A sessionId chosen by the runner ends up in Drizzle's message, and so in the stack.
  const err = new Error('Failed query: insert … params: ses\nat secret-payload (file.ts:1:1)');
  err.stack = `Error: ${err.message}\n    at real (hub.ts:1:1)`;
  Object.assign(err, { code: "secret code", constraint: "x; secret", cause: Object.assign(new Error("secret"), { name: "secret name!" }) });
  logError("runner message failed", err, { runnerId: "runner_1" });
  expect(JSON.stringify(error.mock.calls)).not.toMatch(/secret|at |hub\.ts/);
  expect(error.mock.calls[0]).toEqual(["runner message failed", { runnerId: "runner_1", error: { name: "Error", cause: "Error" } }]);
  error.mockRestore();
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
