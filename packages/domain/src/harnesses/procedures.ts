import { ORPCError } from "@orpc/server";
import { ClaudePermissionMode, CodexPermissionMode } from "@dispand/runner-protocol";
import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { agents, harnesses as harnessesTable, runners, stepRuns } from "../db/schema.ts";
import { listModels, ModelListError } from "../cloud/models.ts";
import { newId } from "../ids.ts";
import { authed, base } from "../rpc/context.ts";
import type { SecretBox } from "../secrets.ts";
import { StorableText } from "../workflows/model.ts";
import { apiKeyAad, CLOUD_KINDS, loadCloudHarness, type CloudKind } from "./cloud.ts";

const owner = base.use(authed);

/** A model the CLI is started with (`--model`): an alias like `opus` or a full model id. */
export const ModelName = StorableText(100).trim().min(1);

const Name = z.string().trim().min(1).max(100);

const CliShared = {
  // Optional: CLI harnesses came first, and callers still send them without a type.
  type: z.literal("cli").optional(),
  name: Name,
  runnerId: z.string(),
  model: ModelName.optional(),
};
// Each CLI takes the permission modes its runner sessions accept.
const ClaudeFields = z.object({ ...CliShared, kind: z.literal("claude-code"), permissionMode: ClaudePermissionMode });
const CodexFields = z.object({ ...CliShared, kind: z.literal("codex"), permissionMode: CodexPermissionMode });

const CloudFields = z.object({
  type: z.literal("cloud"),
  name: Name,
  kind: z.enum(CLOUD_KINDS),
  baseUrl: z.url({ protocol: /^https?$/ }).max(2000).optional(),
  // Omitted on update: keep the stored key. "": no key (clears it on update).
  apiKey: z.string().trim().max(4000).optional(),
  model: z.string().trim().min(1).max(200),
  systemPrompt: StorableText(100_000),
  maxTokens: z.int().min(1).max(1_000_000).optional(),
  effort: z.enum(["low", "medium", "high"]).optional(),
  temperature: z.number().min(0).max(2).optional(),
});
type CloudFields = z.infer<typeof CloudFields>;

const Fields = z.union([ClaudeFields, CodexFields, CloudFields]);

type Row = typeof harnessesTable.$inferSelect;

function toHarness(row: Row) {
  const { id, ownerId, name, model } = row;
  if (row.type === "cloud") {
    const { baseUrl, systemPrompt, maxTokens, effort, temperature } = row;
    return {
      id,
      ownerId,
      name,
      type: "cloud" as const,
      kind: row.kind as CloudKind,
      ...(baseUrl === null ? {} : { baseUrl }),
      model: model ?? "",
      systemPrompt: systemPrompt ?? "",
      ...(maxTokens === null ? {} : { maxTokens }),
      ...(effort === null ? {} : { effort }),
      ...(temperature === null ? {} : { temperature }),
      apiKeySet: row.apiKeySealed !== null,
    };
  }
  const cli = { id, ownerId, name, type: "cli" as const, runnerId: row.runnerId!, ...(model === null ? {} : { model }) };
  return row.kind === "codex"
    ? { ...cli, kind: "codex" as const, permissionMode: row.permissionMode as z.infer<typeof CodexPermissionMode> }
    : { ...cli, kind: "claude-code" as const, permissionMode: row.permissionMode! };
}

/** Plain http only reaches this machine: a key never crosses the network in clear. */
export function isLoopback(url: URL): boolean {
  const host = url.hostname;
  return host === "localhost" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

function bad(message: string): never {
  throw new ORPCError("BAD_REQUEST", { message });
}

/** The rules the schema can't say alone. `hasKey`: whether the harness will hold a key. */
function checkCloud(kind: CloudKind, baseUrl: string | undefined, hasKey: boolean) {
  if (kind === "openai-compatible" && !baseUrl) bad("An OpenAI-compatible provider needs a base URL");
  if (kind !== "openai-compatible" && !hasKey) bad("An API key is required");
  if (hasKey && baseUrl && new URL(baseUrl).protocol === "http:" && !isLoopback(new URL(baseUrl))) {
    bad("A key is only sent to an https:// base URL");
  }
}

function cloudValues(fields: CloudFields, id: string, secrets: SecretBox, keptSealed: string | null) {
  if (fields.temperature !== undefined && fields.kind !== "openai-compatible") bad("Temperature is only for OpenAI-compatible providers");
  const sealed = fields.apiKey === undefined ? keptSealed : fields.apiKey === "" ? null : secrets.seal(fields.apiKey, apiKeyAad(id));
  checkCloud(fields.kind, fields.baseUrl, sealed !== null);
  return {
    type: "cloud" as const,
    name: fields.name,
    runnerId: null,
    kind: fields.kind,
    permissionMode: null,
    model: fields.model,
    baseUrl: fields.baseUrl ?? null,
    apiKeySealed: sealed,
    systemPrompt: fields.systemPrompt,
    maxTokens: fields.maxTokens ?? null,
    effort: fields.effort ?? null,
    temperature: fields.temperature ?? null,
  };
}

async function requireRunner(db: Db, ownerId: string, runnerId: string) {
  const [row] = await db
    .select({ id: runners.id })
    .from(runners)
    .where(and(eq(runners.id, runnerId), eq(runners.ownerId, ownerId), isNull(runners.revokedAt)));
  if (!row) throw new ORPCError("NOT_FOUND", { message: "Runner not found" });
}

async function find(db: Db, ownerId: string, id: string) {
  const [row] = await db
    .select()
    .from(harnessesTable)
    .where(and(eq(harnessesTable.id, id), eq(harnessesTable.ownerId, ownerId)));
  if (!row) throw new ORPCError("NOT_FOUND");
  return row;
}

const create = owner.input(Fields).handler(async ({ input, context }) => {
  const id = newId("harness");
  if (input.type === "cloud") {
    const [row] = await context.db
      .insert(harnessesTable)
      .values({ ...cloudValues(input, id, context.secrets, null), id, ownerId: context.ownerId })
      .returning();
    return toHarness(row!);
  }
  await requireRunner(context.db, context.ownerId, input.runnerId);
  const [row] = await context.db
    .insert(harnessesTable)
    .values({ ...input, type: "cli", model: input.model ?? null, id, ownerId: context.ownerId })
    .returning();
  return toHarness(row!);
});

const update = owner
  .input(z.union([ClaudeFields.extend({ id: z.string() }), CodexFields.extend({ id: z.string() }), CloudFields.extend({ id: z.string() })]))
  .handler(async ({ input, context }) => {
    const { id, ...fields } = input;
    const current = await find(context.db, context.ownerId, id);
    if ((fields.type ?? "cli") !== current.type) bad("A harness can't change between CLI and cloud");
    let values;
    if (fields.type === "cloud") {
      values = cloudValues(fields, id, context.secrets, current.apiKeySealed);
    } else {
      // Only a new runner is checked: a harness on a runner revoked since can still be renamed.
      if (fields.runnerId !== current.runnerId) await requireRunner(context.db, context.ownerId, fields.runnerId);
      values = { ...fields, type: "cli" as const, model: fields.model ?? null };
    }
    const [row] = await context.db
      .update(harnessesTable)
      .set(values)
      .where(and(eq(harnessesTable.id, id), eq(harnessesTable.ownerId, context.ownerId)))
      .returning();
    return toHarness(row!);
  });

const remove = owner.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
  await find(context.db, context.ownerId, input.id);
  const [used] = await context.db.select({ n: count() }).from(agents).where(eq(agents.harnessId, input.id));
  if (used && used.n > 0) throw new ORPCError("CONFLICT", { message: "An agent uses this harness" });
  await context.db.delete(harnessesTable).where(eq(harnessesTable.id, input.id));
});

const list = owner.handler(async ({ context }) => {
  const rows = await context.db
    .select()
    .from(harnessesTable)
    .where(eq(harnessesTable.ownerId, context.ownerId))
    .orderBy(asc(harnessesTable.createdAt), asc(harnessesTable.id));
  return rows.map(toHarness);
});

const get = owner.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
  return toHarness(await find(context.db, context.ownerId, input.id));
});

/**
 * The models a cloud provider offers, for the harness form: of a saved harness (with its stored
 * key), or of what the form holds. Provider failures come back as a short reason, never its body.
 */
const models = owner
  .input(
    z.union([
      z.object({ harnessId: z.string() }),
      CloudFields.pick({ kind: true, baseUrl: true, apiKey: true }),
    ]),
  )
  .handler(async ({ input, context }) => {
    let target: { kind: CloudKind; baseUrl?: string; apiKey?: string };
    if ("harnessId" in input) {
      const row = await find(context.db, context.ownerId, input.harnessId);
      if (row.type !== "cloud") throw new ORPCError("NOT_FOUND");
      target = await loadCloudHarness(context.db, context.secrets, context.ownerId, row.id);
    } else {
      target = { kind: input.kind, ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}), ...(input.apiKey ? { apiKey: input.apiKey } : {}) };
    }
    if (target.kind === "openai-compatible" && !target.baseUrl) bad("An OpenAI-compatible provider needs a base URL");
    if (target.apiKey && target.baseUrl && new URL(target.baseUrl).protocol === "http:" && !isLoopback(new URL(target.baseUrl))) {
      bad("A key is only sent to an https:// base URL");
    }
    try {
      return await listModels(target.kind, target.baseUrl, target.apiKey);
    } catch (error) {
      if (error instanceof ModelListError) bad(error.message);
      throw new ORPCError("INTERNAL_SERVER_ERROR");
    }
  });

/** How many sessions of a harness may work on a turn at once (design 6.1). */
export const MaxWorking = z.number().int().min(1).max(100);

/** Every harness with its limit, and its sessions working and its steps queued now. */
const limits = owner.handler(async ({ context }) => {
  const rows = await context.db
    .select({ id: harnessesTable.id, name: harnessesTable.name, kind: harnessesTable.kind, maxWorking: harnessesTable.maxWorking })
    .from(harnessesTable)
    .where(eq(harnessesTable.ownerId, context.ownerId))
    .orderBy(asc(harnessesTable.createdAt), asc(harnessesTable.id));
  const ids = rows.map((r) => r.id);
  const now = ids.length
    ? await context.db
        .select({
          harnessId: stepRuns.harnessId,
          working: sql<number>`count(*) filter (where ${stepRuns.working})`.mapWith(Number),
          queued: sql<number>`count(*) filter (where ${stepRuns.queuedAt} is not null)`.mapWith(Number),
        })
        .from(stepRuns)
        .where(inArray(stepRuns.harnessId, ids))
        .groupBy(stepRuns.harnessId)
    : [];
  const byHarness = new Map(now.map((n) => [n.harnessId, n]));
  return rows.map((r) => ({ ...r, working: byHarness.get(r.id)?.working ?? 0, queued: byHarness.get(r.id)?.queued ?? 0 }));
});

/**
 * Sets a harness's limit. Raising it starts queued steps at once; lowering it stops nothing: new
 * turns wait until the sessions working are fewer than the limit.
 */
const setLimit = owner.input(z.object({ id: z.string(), maxWorking: MaxWorking })).handler(async ({ input, context }) => {
  await find(context.db, context.ownerId, input.id);
  await context.engine.setLimit(input.id, input.maxWorking);
  return { id: input.id, maxWorking: input.maxWorking };
});

export const harnesses = { create, update, delete: remove, list, get, models, limits, setLimit };
