import { call } from "@orpc/server";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import type { Db } from "../db/client.ts";
import { messages, stepRuns } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { ownerContext, runnerWithClis } from "../runners/test-support.ts";
import { Engine } from "./engine.ts";
import { FakeAdapter } from "./test-support.ts";

// Opt-in (`DISPAND_BENCH=1`): what one streamed answer costs the database through the engine, its
// turn's end included, printed as `deltas | text events | WAL bytes | ms`. WAL is read on PostgreSQL
// (`DISPAND_TEST_DATABASE_URL`), and on PGlite where it reports it. The deltas are 10 letters drawn
// at random (seeded), as Sonnet streams about 10 characters a delta: repeated text would compress
// away and hide what is written.
const SIZES = [2000, 4000];
let seed = 1;
const letters = "abcdefghijklmnopqrstuvwxyz     ";
const DELTAS = Array.from({ length: Math.max(...SIZES) }, () =>
  Array.from({ length: 10 }, () => letters[(seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) % letters.length]).join(""),
);

const rowsOf = async <T>(db: Db, query: ReturnType<typeof sql>) => ((await db.execute(query)) as { rows: T[] }).rows;

async function walPosition(db: Db): Promise<string | null> {
  try {
    const [row] = await rowsOf<{ lsn: string }>(db, sql`select pg_current_wal_insert_lsn()::text as lsn`);
    return row!.lsn;
  } catch {
    return null;
  }
}

/** A chat step with a live session on a fake runner, and a way to send its harness events. */
async function chat() {
  const context = await ownerContext();
  const { runnerId } = await runnerWithClis(context, "Runner");
  const harness = await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context });
  const agent = await call(router.agents.create, { name: "Assistant", harnessId: harness.id, systemPrompt: "" }, { context });
  const engine = new Engine(context.db, new FakeAdapter(), undefined, undefined, undefined, context.secrets);
  onTestFinished(() => engine.stop());
  const config = { kind: "manual" as const, placement: "chat" as const };
  const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Chat", instructions: "Help.", config }, { context });
  const runId = await engine.startJob(trigger.id, context.ownerId);
  const step = async () =>
    (
      await context.db
        .select()
        .from(stepRuns)
        .where(and(eq(stepRuns.runId, runId), isNotNull(stepRuns.sessionId)))
    )[0]!;
  await vi.waitFor(async () => expect((await step()).startDeliveredAt).toBeTruthy());
  const { sessionId } = await step();
  let seq = 0;
  const emit = (event: Parameters<Engine["onHarnessEvent"]>[1]) => engine.onHarnessEvent(sessionId!, event, { runnerId, seq: ++seq });
  return { db: context.db, runId, emit };
}

test.runIf(process.env.DISPAND_BENCH)("streamed text: WAL and time per answer", { timeout: 600_000 }, async () => {
  const lines: string[] = [];
  for (const n of SIZES) {
    const c = await chat();
    await c.emit({ type: "turn-start", turnId: "t", interruptible: false });
    // Each answer starts after a checkpoint, so the full-page images it writes are its own.
    await c.db.execute(sql`checkpoint`).catch(() => undefined);
    const before = await walPosition(c.db);
    const started = performance.now();
    for (let i = 0; i < n; i++) await c.emit({ type: "text", delta: DELTAS[i]!, ...(i === 0 ? { newMessage: true as const } : {}) });
    await c.emit({ type: "turn-end", turnId: "t" });
    const ms = Math.round(performance.now() - started);
    const after = await walPosition(c.db);
    const wal =
      before && after ? (await rowsOf<{ n: string }>(c.db, sql`select pg_wal_lsn_diff(${after}::pg_lsn, ${before}::pg_lsn)::bigint as n`))[0]!.n : "n/a";
    const [answer] = await c.db
      .select()
      .from(messages)
      .where(and(eq(messages.runId, c.runId), eq(messages.role, "assistant")));
    expect(answer!.text).toBe(DELTAS.slice(0, n).join(""));
    lines.push([n, n, wal, ms].join(" | "));
  }
  process.stdout.write(`\ndeltas | text events | WAL bytes | ms\n${lines.join("\n")}\n`);
});
