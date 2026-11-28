import { assistantCommands } from "../assistant/commands.ts";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { getIP } from "better-auth/api";
import { count, sql } from "drizzle-orm";
import { account, user } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { bootstrapOrganization, DisplayName } from "../workspace/lifecycle.ts";
import { type Auth, withIdentity } from "../auth.ts";
import { inScope, SYSTEM } from "../db/scope.ts";
import { agents } from "../agents/procedures.ts";
import { artifacts } from "../artifacts/procedures.ts";
import { audit } from "../audit/procedures.ts";
import { files } from "../data/files.ts";
import { rows } from "../data/rows.ts";
import { fields, tables } from "../data/tables.ts";
import { onboarding } from "../onboarding.ts";
import { jobs } from "../jobs/procedures.ts";
import { memoriesRouter as memories } from "../memory/procedures.ts";
import { harnesses } from "../harnesses/procedures.ts";
import { workspace } from "../workspace/procedures.ts";
import { organization } from "../workspace/organization.ts";
import { profile } from "../workspace/profile.ts";
import { system } from "../workspace/system.ts";
import { pages, widgets } from "../pages/procedures.ts";
import { push } from "../push/procedures.ts";
import { questions } from "../questions/procedures.ts";
import { runners } from "../runners/procedures.ts";
import { marketplaces } from "../plugins/marketplace-procedures.ts";
import { plugins } from "../plugins/procedures.ts";
import { tools } from "../tools/procedures.ts";
import { triggers } from "../triggers/procedures.ts";
import { skills } from "../skills/procedures.ts";
import { runs, workflows } from "../workflows/procedures.ts";
import { base, signedInProcedure } from "./context.ts";
import { message } from "../messages/index.ts";

/** Constant-time comparison (digests have equal length whatever the inputs). */
function sameSecret(given: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/**
 * Wrong setup codes, counted per install (its Better Auth) in one window that starts at the first:
 * per client address, and in all, so changing address doesn't escape the limit. In memory, like
 * Better Auth's default sign-in throttle: a restart clears them.
 */
const SETUP_WINDOW_MS = 15 * 60_000;
const SETUP_FAILURES_PER_ADDRESS = 5;
const SETUP_FAILURES_IN_ALL = 20;
type SetupFailures = { since: number; total: number; byAddress: Map<string, number> };
const setupFailures = new WeakMap<Auth, SetupFailures>();

const setup = base
  .input(
    z.object({
      name: z.string().trim().min(1),
      email: z.email(),
      organizationName: DisplayName.optional(),
      workspaceName: DisplayName.optional(),
      setupCode: z.string().max(256),
      password: z.string().min(8).max(128), // 128 is Better Auth's sign-in limit
    }),
  )
  .handler(async ({ input, context }) => {
    if (context.setup === false) throw new ORPCError("FORBIDDEN", message("auth.setupRefused"));
    // The sign-in throttle's client address (X-Real-IP, through Better Auth's options); none is one address of its own.
    const address = getIP(context.headers, context.auth.options) ?? "";
    const now = (context.now?.() ?? new Date()).getTime();
    const counted = setupFailures.get(context.auth);
    const failures = counted && now - counted.since < SETUP_WINDOW_MS ? counted : undefined;
    // Refused even with the right code. Checked and counted before any await, so parallel requests can't overshoot.
    if (failures && (failures.total >= SETUP_FAILURES_IN_ALL || (failures.byAddress.get(address) ?? 0) >= SETUP_FAILURES_PER_ADDRESS)) {
      throw new ORPCError("TOO_MANY_REQUESTS", message("auth.setupThrottled"));
    }
    // Same error as "owner exists", so a wrong code reveals nothing. Checked before any work.
    if (!sameSecret(input.setupCode, context.setupCode)) {
      const next = failures ?? { since: now, total: 0, byAddress: new Map<string, number>() };
      next.total++;
      next.byAddress.set(address, (next.byAddress.get(address) ?? 0) + 1);
      setupFailures.set(context.auth, next);
      throw new ORPCError("FORBIDDEN", message("auth.setupRefused"));
    }
    // Cheap refusal first: a finished install must not spend a password hash per request.
    const [existing] = await inScope(SYSTEM, () => context.db.select({ n: count() }).from(user));
    if (existing && existing.n > 0) throw new ORPCError("FORBIDDEN", message("auth.setupRefused"));
    // First run creates the owner and their workspace atomically: only with Better Auth's tables on `db`.
    if (context.authDb !== context.db) throw new ORPCError("FORBIDDEN", message("auth.setupRefused"));
    const ownerId = newId("user");
    const ctx = await context.auth.$context;
    const password = await ctx.password.hash(input.password);
    await withIdentity(
      context,
      async (tx) => {
        // Serializes concurrent first-run requests: the second one sees the owner and is refused.
        // (Checked again here: another request may have finished since the cheap check.)
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('dispand:setup'))`);
        const [row] = await tx.select({ n: count() }).from(user);
        if (row && row.n > 0) throw new ORPCError("FORBIDDEN", message("auth.setupRefused"));
        await tx.insert(user).values({ id: ownerId, name: input.name, email: input.email.toLowerCase() });
        await tx.insert(account).values({
          id: newId("acct"),
          accountId: ownerId,
          providerId: "credential",
          userId: ownerId,
          password,
        });
      },
      async (tx) => {
        const workspaceId = newId("ws");
        await bootstrapOrganization(tx, {
          userId: ownerId,
          organizationId: newId("org"),
          workspaceId,
          name: input.organizationName,
          workspaceName: input.workspaceName,
        });
      },
    );
    return { ownerId };
  });

// `enrollsAccounts`: whether this server makes accounts itself (first setup, invitations), which an
// embedding server started with `setup: false` does its own way.
const status = base.handler(async ({ context }) => {
  if (context.setup === false) return { needsSetup: false, enrollsAccounts: false };
  const [row] = await inScope(SYSTEM, () => context.db.select({ n: count() }).from(user));
  return { needsSetup: !row || row.n === 0, enrollsAccounts: true };
});

const me = signedInProcedure.handler(async ({ context }) => ({ ownerId: context.ownerId }));

export const router = {
  assistantCommands,
  auth: { setup, status, me },
  runners,
  harnesses,
  agents,
  triggers,
  jobs,
  skills,
  marketplaces,
  plugins,
  workflows,
  runs,
  questions,
  push,
  pages,
  widgets,
  onboarding,
  tables,
  fields,
  rows,
  files,
  tools,
  workspace,
  organization,
  profile,
  system,
  audit,
  memories,
  artifacts,
};

export type Router = typeof router;
