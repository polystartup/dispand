import { PluginOperation, PROTOCOL_VERSION } from "@dispand/runner-protocol";
import { ORPCError } from "@orpc/server";
import { and, asc, count, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { harnesses, runners as runnersTable } from "../db/schema.ts";
import { authed, base } from "../rpc/context.ts";
import { newId } from "../ids.ts";
import { RunnerRequestFailed } from "./hub.ts";
import { createRunner, revokeRunner } from "./pairing.ts";

const owner = base.use(authed);

const Name = z.string().trim().min(1).max(100);

const create = owner
  .input(z.object({ name: Name }))
  .handler(async ({ input, context }) => {
    const { runnerId, pairingCode } = await createRunner(context.db, context.ownerId, input.name);
    const server = context.auth.options.baseURL;
    // The code goes in the environment, never in an argv another local user could read in `ps`.
    const installCommand = `curl -fsSL ${server}/runner/install.sh | DISPAND_PAIRING_CODE=${pairingCode} sh -s -- --server ${server}`;
    return { runnerId, pairingCode, installCommand };
  });

const list = owner.handler(async ({ context }) => {
  const rows = await context.db
    .select({
      id: runnersTable.id,
      name: runnersTable.name,
      lastSeenAt: runnersTable.lastSeenAt,
      clis: runnersTable.clis,
      // The MCP servers in its own config, for runner tools.
      tools: runnersTable.tools,
      protocolVersion: runnersTable.protocolVersion,
    })
    .from(runnersTable)
    .where(and(eq(runnersTable.ownerId, context.ownerId), isNull(runnersTable.revokedAt)))
    .orderBy(asc(runnersTable.createdAt), asc(runnersTable.id));
  // An outdated runner can't connect (the hub answers 426) until it is updated in place: its config and token stay.
  const updateCommand = `curl -fsSL ${context.auth.options.baseURL}/runner/install.sh | sh -s -- --update`;
  return rows.map(({ protocolVersion, ...r }) => {
    if (context.hub.isOnline(r.id)) return { ...r, status: "online" as const };
    if (protocolVersion !== null && protocolVersion < PROTOCOL_VERSION) return { ...r, status: "outdated" as const, updateCommand };
    return { ...r, status: "offline" as const };
  });
});

const update = owner.input(z.object({ runnerId: z.string(), name: Name })).handler(async ({ input, context }) => {
  const [row] = await context.db
    .update(runnersTable)
    .set({ name: input.name })
    .where(and(eq(runnersTable.id, input.runnerId), eq(runnersTable.ownerId, context.ownerId), isNull(runnersTable.revokedAt)))
    .returning({ id: runnersTable.id });
  if (!row) throw new ORPCError("NOT_FOUND");
});

const revoke = owner.input(z.object({ runnerId: z.string() })).handler(async ({ input, context }) => {
  const [used] = await context.db
    .select({ n: count() })
    .from(harnesses)
    .where(and(eq(harnesses.runnerId, input.runnerId), eq(harnesses.ownerId, context.ownerId)));
  if (used && used.n > 0) throw new ORPCError("CONFLICT", { message: "A harness uses this runner" });
  if (!(await revokeRunner(context.db, context.ownerId, input.runnerId))) throw new ORPCError("NOT_FOUND");
  context.hub.disconnect(input.runnerId);
  // Its open sessions can't come back: fail them rather than leave their runs waiting.
  await context.engine.runnerRevoked(input.runnerId);
});

const plugins = owner.input(z.object({ runnerId: z.string(), operation: PluginOperation })).handler(async ({ input, context }) => {
  if (context.job) throw new ORPCError("FORBIDDEN", { message: "Native installation requires an owner session" });
  const [runner] = await context.db.select({ id: runnersTable.id }).from(runnersTable)
    .where(and(eq(runnersTable.id, input.runnerId), eq(runnersTable.ownerId, context.ownerId), isNull(runnersTable.revokedAt)));
  if (!runner) throw new ORPCError("NOT_FOUND");
  if ("targets" in input.operation) {
    const available = await context.db.select({ kind: harnesses.kind }).from(harnesses)
      .where(and(eq(harnesses.runnerId, runner.id), eq(harnesses.ownerId, context.ownerId), eq(harnesses.type, "cli")));
    if (input.operation.targets.some((h) => !available.some((a) => a.kind === h))) throw new ORPCError("BAD_REQUEST", { message: "Each target needs a CLI harness on this runner" });
  }
  try {
    return (await context.hub.plugins(runner.id, { type: "plugin.request", requestId: newId("req"), operation: input.operation })).report;
  } catch (error) {
    if (!(error instanceof RunnerRequestFailed)) throw error;
    throw new ORPCError("CONFLICT", { message: "Runner unavailable or operation timed out. Refresh inventory before retrying; native changes may have completed." });
  }
});

export const runners = { create, list, update, revoke, plugins };
