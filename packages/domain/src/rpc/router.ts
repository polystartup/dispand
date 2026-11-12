import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { count, sql } from "drizzle-orm";
import { account, user } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { agents } from "../agents/procedures.ts";
import { audit } from "../audit/procedures.ts";
import { files } from "../data/files.ts";
import { rows } from "../data/rows.ts";
import { fields, tables } from "../data/tables.ts";
import { onboarding } from "../onboarding.ts";
import { jobs } from "../jobs/procedures.ts";
import { harnesses } from "../harnesses/procedures.ts";
import { workspace } from "../workspace/procedures.ts";
import { pages, widgets } from "../pages/procedures.ts";
import { questions } from "../questions/procedures.ts";
import { runners } from "../runners/procedures.ts";
import { marketplaces, plugins, seedMarketplaces } from "../plugins/procedures.ts";
import { tools } from "../tools/procedures.ts";
import { triggers } from "../triggers/procedures.ts";
import { skills } from "../skills/procedures.ts";
import { runs, workflows } from "../workflows/procedures.ts";
import { authed, base } from "./context.ts";

/** Constant-time comparison (digests have equal length whatever the inputs). */
function sameSecret(given: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

const setup = base
  .input(
    z.object({
      name: z.string().trim().min(1),
      email: z.email(),
      setupCode: z.string().max(256),
      password: z.string().min(8).max(128), // 128 is Better Auth's sign-in limit
    }),
  )
  .handler(async ({ input, context }) => {
    // Same error as "owner exists", so a wrong code reveals nothing. Checked before any work.
    if (!sameSecret(input.setupCode, context.setupCode)) throw new ORPCError("FORBIDDEN", { message: "Setup is not allowed" });
    // Cheap refusal first: a finished install must not spend a password hash per request.
    const [existing] = await context.db.select({ n: count() }).from(user);
    if (existing && existing.n > 0) throw new ORPCError("FORBIDDEN", { message: "Setup is not allowed" });
    const ownerId = newId("user");
    const ctx = await context.auth.$context;
    const password = await ctx.password.hash(input.password);
    await context.db.transaction(async (tx) => {
      // Serializes concurrent first-run requests: the second one sees the owner and is refused.
      // (Checked again here: another request may have finished since the cheap check.)
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('dispand:setup'))`);
      const [row] = await tx.select({ n: count() }).from(user);
      if (row && row.n > 0) throw new ORPCError("FORBIDDEN", { message: "Setup is not allowed" });
      await tx.insert(user).values({ id: ownerId, name: input.name, email: input.email.toLowerCase() });
      await tx.insert(account).values({
        id: newId("acct"),
        accountId: ownerId,
        providerId: "credential",
        userId: ownerId,
        password,
      });
      await seedMarketplaces(tx, ownerId);
    });
    return { ownerId };
  });

const status = base.handler(async ({ context }) => {
  const [row] = await context.db.select({ n: count() }).from(user);
  return { needsSetup: !row || row.n === 0 };
});

const me = base.use(authed).handler(async ({ context }) => ({ ownerId: context.ownerId }));

export const router = {
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
  pages,
  widgets,
  onboarding,
  tables,
  fields,
  rows,
  files,
  tools,
  workspace,
  audit,
};

export type Router = typeof router;
