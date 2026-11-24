import { z } from "zod";
import { id, short, string } from "./bounds.ts";

// Personal CLI subscriptions: a person's own Claude or ChatGPT sign-in on a runner they control.
// The login stays in the runner's supervisor. None of these messages carries a provider token, a
// sign-in link or a provider code: Dispand only learns who is signed in (as a digest) and decides
// which action may spend it. Until the runner and the server both turn personal mode on, nothing
// sends them. Asks the runner starts carry `askId`, not `requestId`, which names the server's own requests.

export const SubscriptionHarness = z.enum(["claude-code", "codex"]);

/**
 * One CLI subscription signed in on the supervisor. `identity` is a SHA-256 digest of the provider's
 * user and account ids, so Dispand can tell when the sign-in changes without learning them.
 * `signInNeeded`: the login can no longer renew, and the person must sign in again on the machine.
 */
export const SubscriptionStatus = z.strictObject({
  harness: SubscriptionHarness,
  identity: string(71).regex(/^sha256:[0-9a-f]{64}$/),
  signInNeeded: z.boolean(),
});
export type SubscriptionStatus = z.infer<typeof SubscriptionStatus>;

/** The longest a grant lives before the runner must check it again: a short, service-issued deadline. */
export const MAX_GRANT_TTL_MS = 10 * 60_000;
const ttlMs = () => z.int().min(1).max(MAX_GRANT_TTL_MS);

/**
 * A personal action's grant, on its `session.start`: the session runs in a fresh worker whose only
 * model transport is the supervisor's relay, for this grant only. `ttlMs` is relative, so the
 * runner measures the deadline on its own monotonic clock from when it receives it.
 */
export const Grant = z.strictObject({ id: id().min(1), enrollmentId: id().min(1), ttlMs: ttlMs() });
export type Grant = z.infer<typeof Grant>;

/** Dispand's one-time enrollment challenge, typed by the person on the signed-in runner: never a provider code. */
const Challenge = string(128).regex(/^[A-Za-z0-9_-]{16,128}$/);

export const SubscriptionServerToRunner = [
  /** The reply to `subscription.enroll`: the enrollment it bound, or why it bound nothing. */
  z.object({ type: z.literal("subscription.enrolled"), askId: id().min(1), enrollmentId: id().min(1).optional(), error: short().min(1).optional() })
    .refine((m) => (m.enrollmentId === undefined) !== (m.error === undefined), "provide either enrollmentId or error"),
  /** The reply to `grant.check`: a fresh deadline when the grant still holds; without one, the request is denied. */
  z.object({ type: z.literal("grant.checked"), askId: id().min(1), ttlMs: ttlMs().optional() }),
  /** The grant is over (revoked, paused, ended, superseded): close its streams and stop its worker. */
  z.object({ type: z.literal("grant.end"), grantId: id().min(1) }),
] as const;

export const SubscriptionRunnerToServer = [
  /** Confirms an enrollment from the signed-in runner, with the identity it signed in as. */
  z.object({ type: z.literal("subscription.enroll"), askId: id().min(1), harness: SubscriptionHarness, identity: SubscriptionStatus.shape.identity, challenge: Challenge }),
  /** Asks, before each relayed model request and to extend an open stream, whether the grant still holds. */
  z.object({ type: z.literal("grant.check"), askId: id().min(1), grantId: id().min(1) }),
] as const;
