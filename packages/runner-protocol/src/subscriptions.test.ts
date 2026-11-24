import { expect, test } from "vitest";
import { MAX_GRANT_TTL_MS, RunnerToServer, ServerToRunner } from "./index.ts";
import { Grant, SubscriptionRunnerToServer, SubscriptionServerToRunner, SubscriptionStatus } from "./subscriptions.ts";

// The personal-subscription messages carry ids, a digest, a deadline and Dispand's own challenge:
// never a provider token, a sign-in link or code, an origin, a mount or an image. A new field fails
// here until it is listed on purpose.
test("personal-subscription messages hold only the fields listed here", () => {
  const fields = Object.fromEntries(
    [...SubscriptionServerToRunner, ...SubscriptionRunnerToServer].map((schema) => [schema.shape.type.value, Object.keys(schema.shape).sort()]),
  );
  expect(fields).toEqual({
    "subscription.enrolled": ["askId", "enrollmentId", "error", "type"],
    "grant.checked": ["askId", "ttlMs", "type"],
    "grant.end": ["grantId", "type"],
    "subscription.enroll": ["askId", "challenge", "harness", "identity", "type"],
    "grant.check": ["askId", "grantId", "type"],
  });
  expect(Object.keys(Grant.shape).sort()).toEqual(["enrollmentId", "id", "ttlMs"]);
  expect(Object.keys(SubscriptionStatus.shape).sort()).toEqual(["harness", "identity", "signInNeeded"]);
});

test("a status and a grant refuse extra fields, so a token can't ride along", () => {
  const identity = `sha256:${"a".repeat(64)}`;
  expect(SubscriptionStatus.safeParse({ harness: "codex", identity, signInNeeded: false }).success).toBe(true);
  expect(SubscriptionStatus.safeParse({ harness: "codex", identity, signInNeeded: false, accessToken: "x" }).success).toBe(false);
  expect(SubscriptionStatus.safeParse({ harness: "codex", identity: "user@example.test", signInNeeded: false }).success).toBe(false);
  expect(Grant.safeParse({ id: "g1", enrollmentId: "e1", ttlMs: 1000, token: "x" }).success).toBe(false);
});

test("a grant's deadline is short and relative", () => {
  const start = (ttlMs: number) => ServerToRunner.safeParse({
    type: "session.start",
    start: {
      sessionId: "ses_1", harness: "codex", permissionMode: "default", cwd: { mode: "per-run", runKey: "run_1" },
      systemPrompt: "", prompt: "hi", expectedOutputs: [], interactive: true, skills: [], mcpServers: [],
      grant: { id: "grant_1", enrollmentId: "enr_1", ttlMs },
    },
  }).success;
  expect(start(60_000)).toBe(true);
  expect(start(MAX_GRANT_TTL_MS + 1)).toBe(false);
  expect(start(0)).toBe(false);
  expect(ServerToRunner.safeParse({ type: "grant.checked", askId: "r1", ttlMs: MAX_GRANT_TTL_MS + 1 }).success).toBe(false);
});

test("an enrollment reply is either bound or refused, and the challenge is Dispand's own format", () => {
  expect(ServerToRunner.safeParse({ type: "subscription.enrolled", askId: "r1" }).success).toBe(false);
  expect(ServerToRunner.safeParse({ type: "subscription.enrolled", askId: "r1", enrollmentId: "e1", error: "no" }).success).toBe(false);
  const enroll = (challenge: string) =>
    RunnerToServer.safeParse({ type: "subscription.enroll", askId: "r1", harness: "claude-code", identity: `sha256:${"b".repeat(64)}`, challenge }).success;
  expect(enroll("Abc_def-1234567890")).toBe(true);
  expect(enroll("short")).toBe(false);
  expect(enroll("https://provider.example/oauth?code=abcdefghijklmnop")).toBe(false);
});
