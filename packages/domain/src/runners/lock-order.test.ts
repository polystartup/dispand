import { expect, test } from "vitest";
import * as schema from "../db/schema.ts";
import { createRunner, pair, revokeRunner } from "./pairing.ts";
import { recordingDb } from "./test-support.ts";

// On Postgres, `pair` and `revokeRunner` deadlock if they lock the two tables in opposite orders.
// CI has no Postgres: record the statements and check both lock `runners` first.
const WS = { organizationId: "org", workspaceId: "ws" };

async function ownerDb() {
  const recording = await recordingDb();
  await recording.db.insert(schema.user).values({ id: "user_1", name: "Ada", email: "ada@example.com" });
  await recording.db.insert(schema.organizations).values({ id: "org" });
  await recording.db.insert(schema.workspaces).values({ id: "ws", organizationId: "org" });
  await recording.db.insert(schema.organizationMembers).values({ organizationId: "org", userId: "user_1", role: "owner" });
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

test("pair locks the runner before its pairing code", { tags: ["pglite-only"] }, async () => {
  const { db, statements } = await ownerDb();
  const { pairingCode } = await createRunner(db, "user_1", "Workstation", WS);
  statements.length = 0;
  await pair(db, pairingCode);
  expect(lockedTables(statements)[0]).toBe("runners");
  expect(lockedTables(statements)).toContain("runner_pairings");
});

test("revoke locks the runner before its pairing codes", { tags: ["pglite-only"] }, async () => {
  const { db, statements } = await ownerDb();
  const { runnerId } = await createRunner(db, "user_1", "Workstation", WS);
  statements.length = 0;
  await revokeRunner(db, "user_1", runnerId, WS);
  expect(lockedTables(statements)[0]).toBe("runners");
  expect(lockedTables(statements)).toContain("runner_pairings");
});
