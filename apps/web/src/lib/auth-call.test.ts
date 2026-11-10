import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { AuthCallError, authCall, authErrorMessage } from "./auth-call.ts";

test("authCall returns the data when the call succeeds", async () => {
  await expect(authCall(async () => ({ data: { ok: true }, error: null }))).resolves.toEqual({ ok: true });
});

test("authCall throws when the call resolves with an error", async () => {
  const error = await authCall(async () => ({ data: null, error: { status: 500 } })).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AuthCallError);
  expect(error).toMatchObject({ status: 500 });
});

test("authCall throws when the call rejects, without exposing the cause", async () => {
  const error = await authCall(async () => {
    throw new Error("connect ECONNREFUSED 10.0.0.5");
  }).catch((e: unknown) => e);
  expect(error).toMatchObject({ status: 0, message: "Authentication request failed" });
});

test("authErrorMessage maps statuses to client-safe text", () => {
  expect(authErrorMessage(new AuthCallError(401))).toBe("Wrong email or password.");
  expect(authErrorMessage(new AuthCallError(429))).toMatch(/Too many/);
  expect(authErrorMessage(new AuthCallError(500))).toBe("Something went wrong. Try again.");
  expect(authErrorMessage(new Error("anything"))).toMatch(/reach the server/);
});

test("the Better Auth client is only used inside auth-call.ts", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
    );
  const offenders = files(join(import.meta.dirname, ".."))
    .filter((file) => !/auth-call(\.test)?\.ts$/.test(file))
    .filter((file) => /authClient|better-auth\/(react|client)/.test(readFileSync(file, "utf8")));
  expect(offenders).toEqual([]);
});
