import { PluginOperation, PROTOCOL_VERSION } from "@dispand/runner-protocol";
import { ORPCError } from "@orpc/server";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { harnesses, runners as runnersTable } from "../db/schema.ts";
import type { Db } from "../db/client.ts";
import { base, manager, member } from "../rpc/context.ts";
import { newId } from "../ids.ts";
import { RunnerRequestFailed } from "./hub.ts";
import { createRunner, revokeRunner } from "./pairing.ts";
import { subscriptionProcedures } from "./subscriptions.ts";
import { workspacePlugin, workspaceSkills } from "./workspace-plugin.ts";
import { message } from "../messages/index.ts";

const reader = base.use(member);
const writer = base.use(manager);

const Name = z.string().trim().min(1).max(100);

const create = writer
  .input(z.object({ name: Name }))
  .handler(async ({ input, context }) => {
    const { runnerId, pairingCode } = await createRunner(context.db, context.actorId, input.name, context.access);
    const server = context.auth.options.baseURL;
    // The code goes in the environment, never in an argv another local user could read in `ps`.
    const installCommand = `curl -fsSL ${server}/runner/install.sh | DISPAND_PAIRING_CODE=${pairingCode} sh -s -- --server ${server}`;
    return { runnerId, pairingCode, installCommand };
  });

const list = reader.handler(async ({ context }) => {
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
    .where(and(eq(runnersTable.workspaceId, context.access.workspaceId), isNull(runnersTable.revokedAt)))
    .orderBy(asc(runnersTable.createdAt), asc(runnersTable.id));
  // An outdated runner can't connect (the hub answers 426) until it is updated in place: its config and token stay.
  const updateCommand = `curl -fsSL ${context.auth.options.baseURL}/runner/install.sh | sh -s -- --update`;
  return rows.map(({ protocolVersion, ...row }) => {
    const r = { ...row, runnerUpdate: context.hub.updates.status(row.id) };
    if (context.hub.isOnline(r.id)) return { ...r, status: "online" as const };
    if (protocolVersion !== null && protocolVersion < PROTOCOL_VERSION) return { ...r, status: "outdated" as const, updateCommand };
    return { ...r, status: "offline" as const };
  });
});

/** The workspace's live runner, or NOT_FOUND. */
async function requireRunner(context: { db: Db; access: { workspaceId: string } }, runnerId: string) {
  const [runner] = await context.db.select({ id: runnersTable.id, ownerId: runnersTable.ownerId }).from(runnersTable)
    .where(and(eq(runnersTable.id, runnerId), eq(runnersTable.workspaceId, context.access.workspaceId), isNull(runnersTable.revokedAt)));
  if (!runner) throw new ORPCError("NOT_FOUND", message("tools.runnerNotFound"));
  return runner;
}

const update = writer.input(z.object({ runnerId: z.string(), name: Name })).handler(async ({ input, context }) => {
  const [row] = await context.db
    .update(runnersTable)
    .set({ name: input.name })
    .where(and(eq(runnersTable.id, input.runnerId), eq(runnersTable.workspaceId, context.access.workspaceId), isNull(runnersTable.revokedAt)))
    .returning({ id: runnersTable.id });
  if (!row) throw new ORPCError("NOT_FOUND", message("tools.runnerNotFound"));
});

const revoke = writer.input(z.object({ runnerId: z.string() })).handler(async ({ input, context }) => {
  if (!(await revokeRunner(context.db, context.actorId, input.runnerId, context.access))) throw new ORPCError("NOT_FOUND", message("tools.runnerNotFound"));
  context.hub.disconnect(input.runnerId);
  // Its open sessions can't come back: fail them rather than leave their runs waiting (in the runner's workspace, as all of this).
  await context.engine.runnerRevoked(input.runnerId);
});

/**
 * Native plugin operations of any source, on the runner's own machine: only for the manager who
 * registered it, since what they install runs under that machine's account. A workspace's verified
 * plugins and skills go through `workspacePlugin`, for any manager.
 */
const plugins = writer.input(z.object({ runnerId: z.string(), operation: PluginOperation })).handler(async ({ input, context }) => {
  const runner = await requireRunner(context, input.runnerId);
  if (runner.ownerId !== context.actorId) throw new ORPCError("FORBIDDEN", message("runners.registrantOnly"));
  if ("targets" in input.operation) {
    const available = await context.db.select({ kind: harnesses.kind }).from(harnesses)
      .where(and(eq(harnesses.runnerId, runner.id), eq(harnesses.workspaceId, context.access.workspaceId), eq(harnesses.type, "cli")));
    if (input.operation.targets.some((h) => !available.some((a) => a.kind === h))) throw new ORPCError("BAD_REQUEST", message("runners.targetNeedsHarness"));
  }
  try {
    return (await context.hub.plugins(runner.id, { type: "plugin.request", requestId: newId("req"), operation: input.operation })).report;
  } catch (error) {
    if (!(error instanceof RunnerRequestFailed)) throw error;
    throw new ORPCError("CONFLICT", message("runners.unavailable"));
  }
});

const refreshClis = writer.input(z.object({ runnerId: z.string() })).handler(async ({ input, context }) => {
  const runner = await requireRunner(context, input.runnerId);
  try {
    const reply = await context.hub.refreshClis(runner.id, newId("req"));
    if (reply.error) throw new ORPCError("CONFLICT", message("runners.cliRefreshFailed"));
  } catch (error) {
    if (!(error instanceof RunnerRequestFailed)) throw error;
    throw new ORPCError("CONFLICT", message("runners.cliRefreshFailed"));
  }
});

const installUpdate = writer.input(z.object({ runnerId: z.string() })).handler(async ({ input, context }) => {
  const runner = await requireRunner(context, input.runnerId);
  if (!context.hub.updates.request(runner.id)) throw new ORPCError("CONFLICT", message("runners.noUpdate"));
});

export const runners = { create, list, update, revoke, plugins, workspacePlugin, workspaceSkills, installUpdate, refreshClis, ...subscriptionProcedures };
