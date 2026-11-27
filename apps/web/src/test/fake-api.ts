import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { InferRouterOutputs, RouterClient } from "@orpc/server";
import type { Router } from "@dispand/domain";
import { type Mock, vi } from "vitest";

/** What each procedure resolves to, to type a test's fixtures. */
export type Outputs = InferRouterOutputs<Router>;

/**
 * The API client with every procedure a `vi.fn()`, typed from the real router: a test that
 * resolves a procedure with a value of the wrong shape, or names a procedure that no longer
 * exists, fails to compile, so a renamed output field can't pass unnoticed.
 */
export type FakeApi<T = RouterClient<Router>> = T extends (...args: infer A) => infer R ? Mock<(...args: A) => R> : { [K in keyof T]: FakeApi<T[K]> };

// A node is a mock and a namespace at once, as the fake doesn't know which procedures are leaves:
// its own members (`mockResolvedValue`, `name`...) stay the mock's, any other name is a child.
const node = (): unknown => {
  const mock = vi.fn();
  const children = new Map<string, unknown>();
  return new Proxy(mock, {
    get: (target, name, receiver) => {
      if (name in target || typeof name === "symbol" || name === "then") return Reflect.get(target, name, receiver) as unknown;
      if (!children.has(name)) children.set(name, node());
      return children.get(name);
    },
  });
};

/** One fake per test file: the module is evaluated once per file, like the `lib/api.ts` it replaces. */
export const fake = node() as FakeApi;

/** The replacement of `lib/api.ts`: `vi.mock("../../lib/api.ts", async () => (await import("../../test/fake-api.ts")).apiModule())`. */
export const apiModule = () => ({ api: fake, orpc: createTanstackQueryUtils(fake as never), setWorkspace: () => {} });

/** A stream procedure's answer that says nothing until the call is aborted. */
export const idleStream = async (_input: unknown, options?: { signal?: AbortSignal }) =>
  (async function* (): AsyncGenerator<never> {
    await new Promise((resolve) => options!.signal!.addEventListener("abort", resolve));
    yield* [];
  })();
