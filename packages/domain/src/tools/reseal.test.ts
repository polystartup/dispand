import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { tools } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { ownerContext } from "../runners/test-support.ts";
import { secretAad } from "../secrets.ts";
import { toolTarget } from "./store.ts";
import { resealToolHeaders } from "./reseal.ts";

const URL_A = "https://a.example/mcp";

test("the re-seal binds a tool's old headers to its origin, leaves a tool without headers alone, and runs once", async () => {
  const context = await ownerContext();
  const withHeaders = newId("tool");
  const without = newId("tool");
  const legacy = (name: string, value: string) => context.secrets.seal(value, secretAad("tools", withHeaders, `header:${name}`));
  await context.db.insert(tools).values([
    { id: withHeaders, ownerId: context.ownerId, workspaceId: context.workspaceId, name: "With", kind: "http", url: URL_A, transport: "streamable-http", auth: "headers", headersSealed: { authorization: legacy("authorization", "Bearer a"), "x-team": legacy("x-team", "t") } },
    { id: without, ownerId: context.ownerId, workspaceId: context.workspaceId, name: "Without", kind: "http", url: URL_A, transport: "sse", auth: "none", headersSealed: {} },
  ]);
  // Before: the headers don't open under the origin-bound AAD.
  const [before] = await context.db.select().from(tools).where(eq(tools.id, withHeaders));
  expect(() => toolTarget(before!, context.secrets)).toThrow();

  expect(await resealToolHeaders(context.db, context.secrets)).toEqual({ resealed: 2 });
  const [after] = await context.db.select().from(tools).where(eq(tools.id, withHeaders));
  expect(toolTarget(after!, context.secrets).headers).toEqual({ authorization: "Bearer a", "x-team": "t" });
  const [bare] = await context.db.select().from(tools).where(eq(tools.id, without));
  expect(bare!.headersSealed).toEqual({});

  // A second start changes nothing.
  expect(await resealToolHeaders(context.db, context.secrets)).toEqual({ resealed: 0 });
  const [again] = await context.db.select().from(tools).where(eq(tools.id, withHeaders));
  expect(again!.headersSealed).toEqual(after!.headersSealed);
});
