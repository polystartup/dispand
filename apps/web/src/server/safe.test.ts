import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ORPCError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { redirect } from "@tanstack/react-router";
import { afterEach, expect, test, vi } from "vitest";
import { safe } from "./safe.ts";

afterEach(() => vi.restoreAllMocks());

test("unexpected errors are logged and replaced by a generic one", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const run = safe(async () => {
    throw new Error('Failed query: select count(*) from "user"');
  });
  const error = await run().catch((e: unknown) => e);
  expect(error).toEqual(new Error("Something went wrong"));
  expect(String((error as Error).message)).not.toMatch(/query|select|user/i);
  expect(log.mock.calls.flat().join(" ")).toContain("Failed query"); // kept server-side
});

test("redirects and client-facing API errors pass through", async () => {
  const to = redirect({ to: "/login" });
  await expect(safe(async () => Promise.reject(to))()).rejects.toBe(to);
  const forbidden = new ORPCError("FORBIDDEN");
  await expect(safe(async () => Promise.reject(forbidden))()).rejects.toBe(forbidden);
  vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(safe(async () => Promise.reject(new ORPCError("INTERNAL_SERVER_ERROR", { message: "db at 10.0.0.5" })))()).rejects.toThrow(
    "Something went wrong",
  );
});

test("every createServerFn handler goes through safe()", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
    );
  const offenders: string[] = [];
  let found = 0;
  for (const file of files(join(import.meta.dirname, ".."))) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("createServerFn(") || file.endsWith("safe.ts")) continue;
    const handlers = text.match(/\.handler\(/g)?.length ?? 0;
    const wrapped = text.match(/\.handler\(\s*safe\(/g)?.length ?? 0;
    found += handlers;
    if (handlers !== wrapped) offenders.push(file);
  }
  expect(found).toBeGreaterThan(0);
  expect(offenders).toEqual([]);
});

test("oRPC hides the message of a plain Error", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const handler = new RPCHandler({
    boom: os.handler(() => {
      throw new Error('Failed query: select count(*) from "user"');
    }),
  });
  const { response } = await handler.handle(
    new Request("http://localhost/api/rpc/boom", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    { prefix: "/api/rpc", context: {} },
  );
  expect(response?.status).toBe(500);
  const text = await response!.text();
  expect(text).toContain("INTERNAL_SERVER_ERROR");
  expect(text).not.toMatch(/query|select|user"/i);
});
