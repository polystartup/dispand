import { expect, onTestFinished, test } from "vitest";
import { ensureAssistants } from "../agents/builtin.ts";
import { syncPlatformSkills } from "../assistant/skill.ts";
import { ownerContext, recordScopes } from "../runners/test-support.ts";
import { secretAad } from "../secrets.ts";
import { resealToolHeaders } from "../tools/reseal.ts";
import { tools, workspaces } from "./schema.ts";
import { inScope, setTenancy, shared, SYSTEM, type Scope } from "./scope.ts";

// The startup routines span every workspace: on a single-tenant database they run once, under the
// startup's SYSTEM; a tenancy that splits work runs them in each workspace's scope instead.

async function installed() {
  const base = await ownerContext();
  const b = { organizationId: base.organizationId, workspaceId: "ws_b" };
  await base.db.insert(workspaces).values({ id: b.workspaceId, organizationId: b.organizationId });
  // A header sealed before headers were bound to their tool's origin.
  await base.db.insert(tools).values({
    id: "tool_legacy", workspaceId: base.workspaceId, ownerId: base.ownerId, name: "Mail", kind: "http", url: "https://example.com/mcp", transport: "streamable-http",
    headersSealed: { authorization: base.secrets.seal("Bearer x", secretAad("tools", "tool_legacy", "header:authorization")) },
  } as never);
  const recorder = await recordScopes(base.db);
  /** Each routine, one after the other. */
  const routines = async () => {
    await syncPlatformSkills(recorder.db);
    await ensureAssistants(recorder.db);
    await resealToolHeaders(recorder.db, base.secrets);
  };
  return { base, a: { organizationId: base.organizationId, workspaceId: base.workspaceId }, b, recorder, routines };
}

test("with a single-tenant database, the startup routines run once, under SYSTEM", async () => {
  const { recorder, routines } = await installed();
  await inScope(SYSTEM, routines);
  expect(recorder.statements.length).toBeGreaterThan(0);
  expect(new Set(recorder.statements.map((s) => s.scope))).toEqual(new Set([SYSTEM]));
});

test("with a tenancy that splits work, every startup statement runs in workspace A or B", async () => {
  const { a, b, recorder, routines } = await installed();
  const passes: Scope[] = [];
  setTenancy(recorder.db, {
    async each(db, scopes, work) {
      for (const scope of await scopes(db)) {
        passes.push(scope);
        await inScope(scope, work);
      }
    },
    forRun: shared.forRun,
  });
  onTestFinished(() => setTenancy(recorder.db, shared));
  await inScope(SYSTEM, routines);
  expect(passes).toEqual(expect.arrayContaining([a, b]));
  // Under SYSTEM, only the listing of workspaces; the work, in A and B.
  const system = recorder.statements.filter((s) => s.scope === SYSTEM);
  expect(system.every((s) => /^select distinct .* from "workspaces"/.test(s.sql))).toBe(true);
  const scoped = recorder.statements.flatMap((s) => (s.scope === SYSTEM ? [] : [s.scope.workspaceId]));
  expect(new Set(scoped)).toEqual(new Set([a.workspaceId, b.workspaceId]));
});
