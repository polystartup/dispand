import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runs } from "../db/schema.ts";
import { inScope, SYSTEM } from "../db/scope.ts";
import { router } from "../rpc/router.ts";
import { runnerWithClis, asCli, ownerContext, recordScopes } from "../runners/test-support.ts";
import type { PlatformApp } from "./call.ts";
import { handleJobFiles } from "./job-files.ts";
import { handleJobMcp } from "./mcp.ts";
import { jobTokenOf } from "./token.ts";
import { handleJobToolsMcp } from "./tools-mcp.ts";

// Every entry a Job's token opens: its scope comes from the run the token names (looked up under
// SYSTEM), never from whoever forwards the request. Each runs on the guarded database from another
// workspace's scope, and every statement after the lookup runs in the Job's workspace.

const listTools = (path: string, token: string) =>
  new Request(`https://dispand.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

/** [module, handler, the request it answers]: every entry that takes a Job's token. */
const ENTRIES: [string, (request: Request, app: PlatformApp) => Promise<Response>, (token: string) => Request][] = [
  ["platform/mcp.ts", handleJobMcp, (token) => listTools("/mcp/job", token)],
  ["platform/tools-mcp.ts", handleJobToolsMcp, (token) => listTools("/mcp/job/tools", token)],
  ["platform/job-files.ts", handleJobFiles, (token) =>
    new Request("https://dispand.test/mcp/job/files", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ files: [{ name: "note.txt", base64: Buffer.from("hi").toString("base64") }] }),
    })],
];

test("every module that reads a Job's token from a request is listed here", () => {
  const dir = join(import.meta.dirname, "..");
  const callers = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .filter((file) => /\bjobOfRequest\(request/.test(readFileSync(join(dir, file), "utf8")))
    .map((file) => file.split("\\").join("/"))
    .sort();
  expect(callers).toEqual(ENTRIES.map(([module]) => module).sort());
});

for (const [module, handle, request] of ENTRIES) {
  test(`${module} runs in the Job's scope on the guarded db, whatever scope its caller is in`, async () => {
    const context = await ownerContext();
    const { runnerId } = await runnerWithClis(context);
    const harness = asCli(await call(router.harnesses.create, { name: "Claude", runnerId, kind: "claude-code", permissionMode: "default" }, { context }));
    const agent = await call(router.agents.create, { name: "Clerk", harnessId: harness.id, systemPrompt: "" }, { context });
    const trigger = await call(router.triggers.create, { agentId: agent.id, name: "Go", instructions: "Work.", config: { kind: "manual", placement: "button" } }, { context });
    const { runId } = await call(router.jobs.start, { triggerId: trigger.id }, { context });
    const [run] = await context.db.select().from(runs).where(eq(runs.id, runId));
    const recorder = await recordScopes(context.db);
    const res = await inScope({ workspaceId: "ws_other" }, () => handle(request(jobTokenOf(context.secrets, run!)!), { ...context, db: recorder.db }));
    expect(res.status).toBe(200);
    const jobScope = { userId: context.ownerId, organizationId: context.organizationId, workspaceId: context.workspaceId };
    expect(recorder.statements[0]!.scope).toBe(SYSTEM);
    expect(recorder.statements.length).toBeGreaterThan(1);
    // A procedure's own session check runs under its person alone.
    for (const { scope } of recorder.statements.slice(1)) expect([jobScope, { userId: context.ownerId }]).toContainEqual(scope);
  });
}
