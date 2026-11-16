import { createRunner, pair } from "@dispand/domain";
import { ownerContext } from "@dispand/domain/test-support";
import { expect, test } from "vitest";
import { handlePlugin } from "./plugins.ts";

const get = (id: string, token?: string) => new Request(`http://localhost/runner/plugins/${id}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

test("a runner's plugin request needs its token, and any tool that isn't a plugin server on that runner is 404", async () => {
  const { db, ownerId } = await ownerContext();
  const { pairingCode } = await createRunner(db, ownerId, "Workstation");
  const { token } = await pair(db, pairingCode);
  expect((await handlePlugin(get("tool_x"), db, "tool_x")).status).toBe(401);
  expect((await handlePlugin(get("tool_x", "nope"), db, "tool_x")).status).toBe(401);
  expect((await handlePlugin(get("tool_x", token), db, "tool_x")).status).toBe(404);
});
