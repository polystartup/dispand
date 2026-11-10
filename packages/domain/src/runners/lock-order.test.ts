import { expect, test } from "vitest";
import * as schema from "../db/schema.ts";
import { createRunner, pair, revokeRunner } from "./pairing.ts";
import { recordingDb } from "./test-support.ts";

// On Postgres, `pair` and `revokeRunner` deadlock if they lock the two tables in opposite orders.
// CI has no Postgres: record the statements and check both lock `runners` first.
async function ownerDb() {
  const recording = await recordingDb();
  await recording.db.insert(schema.user).values({ id: "user_1", name: "Ada", email: "ada@example.com" });
  return recording;
}

/** The tables each statement locks rows of, in order. */
function lockedTables(statements: string[]): string[] {
  return statements.flatMap((q) => {
    const update = /^update "(\w+)"/.exec(q);
    if (update) return [update[1]!];
    const forUpdate = /^select .* from "(\w+)".* for update/s.exec(q);
    return forUpdate ? [forUpdate[1]!] : [];
  });
}

test("pair locks the runner before its pairing code", async () => {
  const { db, statements } = await ownerDb();
  const { pairingCode } = await createRunner(db, "user_1", "Workstation");
  statements.length = 0;
  await pair(db, pairingCode);
  expect(lockedTables(statements)[0]).toBe("runners");
  expect(lockedTables(statements)).toContain("runner_pairings");
});

test("revoke locks the runner before its pairing codes", async () => {
  const { db, statements } = await ownerDb();
  const { runnerId } = await createRunner(db, "user_1", "Workstation");
  statements.length = 0;
  await revokeRunner(db, "user_1", runnerId);
  expect(lockedTables(statements)[0]).toBe("runners");
  expect(lockedTables(statements)).toContain("runner_pairings");
});
