import { ORPCError } from "@orpc/client";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { MutationObserver, QueryObserver } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import { createQueryClient, staleQueries } from "./query-client.ts";

const fake = {
  skills: { list: vi.fn(async () => []), get: vi.fn(async () => ({})), create: vi.fn(async () => ({})), delete: vi.fn(async () => ({})) },
  tools: { list: vi.fn(async () => []), update: vi.fn(async () => ({})) },
  agents: { list: vi.fn(async () => []) },
  widgets: { saveLayout: vi.fn(async () => ({})) },
  pages: { list: vi.fn(async () => []) },
};
const orpc = createTanstackQueryUtils(fake as never) as never as Record<
  string,
  Record<string, { queryOptions: (o?: object) => never; mutationOptions: (o?: object) => never }>
>;

/** Every query read through `watch` stays mounted, as a screen's would. */
function setup() {
  const client = createQueryClient({ defaultOptions: { queries: { retry: false } } });
  const watch = (options: never) => {
    const observer = new QueryObserver(client, options);
    observer.subscribe(() => {});
  };
  const run = (procedure: { mutationOptions: (o?: object) => never }, options?: object, variables: unknown = {}) =>
    new MutationObserver(client, procedure.mutationOptions(options)).mutate(variables as never);
  return { client, watch, run };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("a mutation reads again its own namespace and no other", async () => {
  vi.clearAllMocks();
  const { watch, run } = setup();
  watch(orpc.skills!.list!.queryOptions());
  watch(orpc.skills!.get!.queryOptions({ input: { id: "a" } }));
  watch(orpc.pages!.list!.queryOptions());
  await settle();
  vi.clearAllMocks();
  await run(orpc.skills!.create!);
  await settle();
  expect(fake.skills.list).toHaveBeenCalledTimes(1);
  expect(fake.skills.get).toHaveBeenCalledTimes(1);
  expect(fake.pages.list).not.toHaveBeenCalled();
});

test("a mutation that changes more than its namespace reads those again too", async () => {
  vi.clearAllMocks();
  const { watch, run } = setup();
  watch(orpc.tools!.list!.queryOptions());
  watch(orpc.agents!.list!.queryOptions());
  await settle();
  vi.clearAllMocks();
  await run(orpc.tools!.update!);
  await settle();
  expect(fake.tools.list).toHaveBeenCalledTimes(1);
  expect(fake.agents.list).toHaveBeenCalledTimes(1);
});

test("the queries are read again before the mutation's own callback runs", async () => {
  vi.clearAllMocks();
  const { watch, run } = setup();
  watch(orpc.skills!.list!.queryOptions());
  await settle();
  vi.clearAllMocks();
  const seen: number[] = [];
  await run(orpc.skills!.create!, { onSuccess: () => seen.push(fake.skills.list.mock.calls.length) });
  expect(seen).toEqual([1]);
});

test("a delete reads the lists again, not the deleted one's own details", async () => {
  vi.clearAllMocks();
  const { watch, run } = setup();
  watch(orpc.skills!.list!.queryOptions());
  watch(orpc.skills!.get!.queryOptions({ input: { id: "a" } }));
  await settle();
  vi.clearAllMocks();
  await run(orpc.skills!.delete!);
  await settle();
  expect(fake.skills.list).toHaveBeenCalledTimes(1);
  expect(fake.skills.get).not.toHaveBeenCalled();
});

test("a mutation that fails, or one that reads again by itself, reads nothing", async () => {
  vi.clearAllMocks();
  const { watch, run } = setup();
  watch(orpc.skills!.list!.queryOptions());
  watch(orpc.pages!.list!.queryOptions());
  await settle();
  vi.clearAllMocks();
  fake.skills.create.mockRejectedValueOnce(new Error("no"));
  await run(orpc.skills!.create!).catch(() => {});
  await run(orpc.widgets!.saveLayout!);
  await settle();
  expect(fake.skills.list).not.toHaveBeenCalled();
  expect(fake.pages.list).not.toHaveBeenCalled();
});

test.each([
  ["runs", "stop"],
  ["workspace", "revokeInvitation"],
])("%s.%s reads its namespace again after a failure too, before anything waits on it", async (namespace, procedure) => {
  const { client } = setup();
  const invalidate = vi.spyOn(client, "invalidateQueries").mockReturnValue(new Promise(() => {}));
  const mutation = new MutationObserver(client, {
    mutationKey: [[namespace, procedure], { type: "mutation" }],
    mutationFn: () => Promise.reject(new Error("no")),
  });
  await expect(mutation.mutate()).rejects.toThrow("no");
  expect(invalidate.mock.calls).toEqual([[{ queryKey: [[namespace]] }]]);
});

test("a dry run reads nothing again", async () => {
  vi.clearAllMocks();
  const { watch, run } = setup();
  watch(orpc.skills!.list!.queryOptions());
  await settle();
  vi.clearAllMocks();
  await run(orpc.skills!.create!, undefined, { dryRun: true });
  await settle();
  expect(fake.skills.list).not.toHaveBeenCalled();
});

test("only a mutation made by oRPC has a key to read from", () => {
  expect(staleQueries(undefined)).toEqual([]);
  expect(staleQueries(["turn", "run_1", "stop"])).toEqual([]);
  expect(staleQueries([["tables", "rename"], { type: "mutation" }])).toEqual(["tables"]);
  expect(staleQueries([["plugins", "install"], { type: "mutation" }])).toEqual(
    expect.arrayContaining(["plugins", "tables", "triggers", "tools", "skills", "agents"]),
  );
});

test("a query is asked again up to three times, but not after the server refused it", async () => {
  const client = createQueryClient();
  const retry = client.getDefaultOptions().queries!.retry as (failures: number, error: Error) => boolean;
  expect(retry(0, new Error("down"))).toBe(true);
  expect(retry(2, new Error("down"))).toBe(true);
  expect(retry(3, new Error("down"))).toBe(false);
  expect(retry(0, new ORPCError("NOT_FOUND", { status: 404 }))).toBe(false);
  expect(retry(0, new ORPCError("INTERNAL_SERVER_ERROR", { status: 500 }))).toBe(true);
});
