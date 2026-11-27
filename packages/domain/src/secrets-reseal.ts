import { and, eq, getTableName, gt, isNotNull, notLike, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Db } from "./db/client.ts";
import { eachScope, type Scope } from "./db/scope.ts";
import { harnesses, pushKeys, pushSubscriptions, runs, tools } from "./db/schema.ts";
import { workspaceScopes } from "./engine/discovery.ts";
import { apiKeyAad } from "./harnesses/cloud.ts";
import { errorKind, logError } from "./log.ts";
import { tokenAad } from "./platform/token.ts";
import { subscriptionKeysAad, vapidAad } from "./push/keys.ts";
import { SecretError, type SecretBox } from "./secrets.ts";
import { emitLog, inSpan, meter, tracer } from "./telemetry/index.ts";
import { oauthAad } from "./tools/oauth-store.ts";
import { headerAad, urlAad } from "./tools/store.ts";

const traces = tracer("secrets");
const reseals = meter("secrets").counter("dispand.secrets.reseals", { description: "Stored secrets sealed again under the current key at start-up, or left" });
/** Rows read at a time, so a large table is never held whole. */
const BATCH = 500;

export type ResealTally = { resealed: number; unopened: number; failed: number };

/** A text column holding one sealed value per row; `rewrite` writes `to` only while the row still holds `from`. */
type Column = {
  kind: string;
  table: PgTable;
  id: PgColumn;
  sealed: PgColumn;
  /** What the AAD is made of (the row's id, or the column it names). */
  key: PgColumn;
  aad: (key: string) => string;
  rewrite: (db: Db, id: string, from: string, to: string) => Promise<unknown[]>;
};

const WORKSPACE_COLUMNS: Column[] = [
  {
    kind: "harness.api_key",
    table: harnesses,
    id: harnesses.id,
    sealed: harnesses.apiKeySealed,
    key: harnesses.id,
    aad: apiKeyAad,
    rewrite: (db, id, from, to) =>
      db
        .update(harnesses)
        .set({ apiKeySealed: to })
        .where(and(eq(harnesses.id, id), eq(harnesses.apiKeySealed, from)))
        .returning({ id: harnesses.id }),
  },
  {
    kind: "job.token",
    table: runs,
    id: runs.id,
    sealed: runs.tokenSealed,
    key: runs.id,
    aad: tokenAad,
    rewrite: (db, id, from, to) =>
      db
        .update(runs)
        .set({ tokenSealed: to })
        .where(and(eq(runs.id, id), eq(runs.tokenSealed, from)))
        .returning({ id: runs.id }),
  },
  {
    kind: "tool.url",
    table: tools,
    id: tools.id,
    sealed: tools.urlSealed,
    key: tools.id,
    aad: urlAad,
    rewrite: (db, id, from, to) =>
      db
        .update(tools)
        .set({ urlSealed: to })
        .where(and(eq(tools.id, id), eq(tools.urlSealed, from)))
        .returning({ id: tools.id }),
  },
  {
    kind: "tool.oauth",
    table: tools,
    id: tools.id,
    sealed: tools.oauthSealed,
    key: tools.id,
    aad: oauthAad,
    rewrite: (db, id, from, to) =>
      db
        .update(tools)
        .set({ oauthSealed: to })
        .where(and(eq(tools.id, id), eq(tools.oauthSealed, from)))
        .returning({ id: tools.id }),
  },
];

/** A person's push devices: theirs alone, so read per person. */
const SUBSCRIPTION_KEYS: Column = {
  kind: "push.subscription_keys",
  table: pushSubscriptions,
  id: pushSubscriptions.id,
  sealed: pushSubscriptions.keys,
  key: pushSubscriptions.endpoint,
  aad: subscriptionKeysAad,
  rewrite: (db, id, from, to) =>
    db
      .update(pushSubscriptions)
      .set({ keys: to })
      .where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.keys, from)))
      .returning({ id: pushSubscriptions.id }),
};

/** The install's VAPID key: one row, the install's own. */
const VAPID_KEY: Column = {
  kind: "push.vapid_key",
  table: pushKeys,
  id: pushKeys.id,
  sealed: pushKeys.privateKey,
  key: pushKeys.id,
  aad: () => vapidAad,
  rewrite: (db, id, from, to) =>
    db
      .update(pushKeys)
      .set({ privateKey: to })
      .where(and(eq(pushKeys.id, id), eq(pushKeys.privateKey, from)))
      .returning({ id: pushKeys.id }),
};

/** Every column the pass reads, as `table.column`: a test fails on a sealed column missing here. */
export const RESEALED_COLUMNS = [...WORKSPACE_COLUMNS, SUBSCRIPTION_KEYS, VAPID_KEY]
  .map((c) => `${getTableName(c.table)}.${c.sealed.name}`)
  .concat("tools.headers_sealed");

/** The people with a push device, one scope each, read under SYSTEM (by `eachScope`). */
const subscriberScopes = (db: Db): Promise<Scope[]> => db.selectDistinct({ userId: pushSubscriptions.ownerId }).from(pushSubscriptions);

/**
 * At server start, while a previous key is set (`DISPAND_SECRET_KEY_PREVIOUS`): every stored
 * secret not sealed under the current key is sealed again under it, its plaintext never out of
 * the box. Without a lock, safe with several processes on one database: a row is rewritten only
 * while it still holds the sealed text read, so another process's rewrite, or a new value, wins,
 * and each value is rewritten once. A pass that stops halfway is finished by the next start, which
 * reads only what still isn't under the current key. A value that opens under neither key (a
 * wrong previous key) is left as it is and counted, never cleared; so is a failure, which is
 * logged and doesn't stop the server. Runs after `resealToolHeaders`, which moves headers sealed
 * without their origin to the AAD this pass opens them with.
 */
export async function resealSecrets(db: Db, secrets: SecretBox): Promise<ResealTally> {
  const tally: ResealTally = { resealed: 0, unopened: 0, failed: 0 };
  if (!secrets.rotating) return tally;
  return inSpan(traces, "secrets.reseal", {}, errorKind, async (span) => {
    // Per workspace, then per person, as their rows are read (`eachScope`); once, as is, on a single-tenant database.
    await eachScope(db, workspaceScopes, async () => {
      for (const column of WORKSPACE_COLUMNS) await counted(tally, column.kind, () => resealColumn(db, secrets, column, tally));
      await counted(tally, "tool.header", () => resealHeaders(db, secrets, tally));
    });
    await eachScope(db, subscriberScopes, () => counted(tally, SUBSCRIPTION_KEYS.kind, () => resealColumn(db, secrets, SUBSCRIPTION_KEYS, tally)));
    await counted(tally, VAPID_KEY.kind, () => resealColumn(db, secrets, VAPID_KEY, tally));
    span.setAttributes({ "dispand.secrets.resealed": tally.resealed, "dispand.secrets.unopened": tally.unopened, "dispand.secrets.failed": tally.failed });
    // Counts only: what is left under another key, so the previous key isn't dropped while something still needs it.
    const counts = { "dispand.secrets.resealed": tally.resealed, "dispand.secrets.unopened": tally.unopened, "dispand.secrets.failed": tally.failed };
    if (tally.unopened || tally.failed)
      emitLog("secrets", "error", "secrets.reseal left secrets the current key doesn't seal: keep DISPAND_SECRET_KEY_PREVIOUS", counts);
    else emitLog("secrets", "info", "secrets.reseal done: every stored secret is under the current key", counts);
    return tally;
  });
}

/** Runs one kind's pass; a failure is counted and logged, and the next kind goes on. */
async function counted(tally: ResealTally, kind: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    tally.failed++;
    reseals.add(1, { "dispand.secret.kind": kind, "dispand.result": "failed" });
    logError("secrets.reseal failed", err);
  }
}

/** One value sealed again, or why not: the counts and the metric follow. */
function moved(secrets: SecretBox, tally: ResealTally, kind: string, sealed: string, aad: string): string | undefined {
  try {
    return secrets.reseal(sealed, aad);
  } catch (err) {
    if (!(err instanceof SecretError)) throw err;
    tally.unopened++;
    reseals.add(1, { "dispand.secret.kind": kind, "dispand.result": "unopened" });
    return undefined;
  }
}

async function resealColumn(db: Db, secrets: SecretBox, column: Column, tally: ResealTally): Promise<void> {
  // Ids are text: each batch starts after the last id read, so a value left as it is is read once.
  for (let after = ""; ;) {
    const rows = await db
      .select({ id: sql<string>`${column.id}`, sealed: sql<string>`${column.sealed}`, key: sql<string>`${column.key}` })
      .from(column.table)
      .where(and(gt(column.id, after), isNotNull(column.sealed), notLike(column.sealed, `${secrets.current}%`)))
      .orderBy(column.id)
      .limit(BATCH);
    for (const row of rows) {
      const next = moved(secrets, tally, column.kind, row.sealed, column.aad(row.key));
      if (next === undefined) continue;
      try {
        if ((await column.rewrite(db, row.id, row.sealed, next)).length) {
          tally.resealed++;
          reseals.add(1, { "dispand.secret.kind": column.kind, "dispand.result": "ok" });
        }
      } catch (err) {
        tally.failed++;
        reseals.add(1, { "dispand.secret.kind": column.kind, "dispand.result": "failed" });
        logError("secrets.reseal failed", err, { ref: row.id });
      }
    }
    if (rows.length < BATCH) return;
    after = rows.at(-1)!.id;
  }
}

/** A tool's headers, a map of sealed values: rewritten whole, only while the tool still calls the URL and holds the headers read. */
async function resealHeaders(db: Db, secrets: SecretBox, tally: ResealTally): Promise<void> {
  for (let after = ""; ;) {
    const rows = await db
      .select({ id: tools.id, url: tools.url, headersSealed: tools.headersSealed })
      .from(tools)
      .where(and(gt(tools.id, after), isNotNull(tools.url), sql`${tools.headersSealed} <> '{}'::jsonb`))
      .orderBy(tools.id)
      .limit(BATCH);
    for (const row of rows) {
      const headersSealed = { ...row.headersSealed };
      let changed = 0;
      for (const [name, sealed] of Object.entries(row.headersSealed)) {
        if (sealed.startsWith(secrets.current)) continue;
        const next = moved(secrets, tally, "tool.header", sealed, headerAad(row.id, name, row.url!));
        if (next === undefined) continue;
        headersSealed[name] = next;
        changed++;
      }
      if (!changed) continue;
      try {
        const updated = await db
          .update(tools)
          .set({ headersSealed })
          .where(and(eq(tools.id, row.id), eq(tools.url, row.url!), sql`${tools.headersSealed} = ${JSON.stringify(row.headersSealed)}::jsonb`))
          .returning({ id: tools.id });
        if (updated.length) {
          tally.resealed += changed;
          reseals.add(changed, { "dispand.secret.kind": "tool.header", "dispand.result": "ok" });
        }
      } catch (err) {
        tally.failed++;
        reseals.add(1, { "dispand.secret.kind": "tool.header", "dispand.result": "failed" });
        logError("secrets.reseal failed", err, { ref: row.id });
      }
    }
    if (rows.length < BATCH) return;
    after = rows.at(-1)!.id;
  }
}
