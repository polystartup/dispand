import { createRunner } from "@dispand/domain";
import { ownerContext } from "@dispand/domain/test-support";
import { expect, test } from "vitest";
import { handlePair } from "./pair.ts";

async function withCode() {
  const { db, ownerId } = await ownerContext();
  return { db, ...(await createRunner(db, ownerId, "Workstation")) };
}

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request("http://localhost/runner/pair", { method: "POST", body, headers, duplex: "half" } as RequestInit);

test("a normal pairing request works", async () => {
  const { db, runnerId, pairingCode } = await withCode();
  const res = await handlePair(post(JSON.stringify({ code: pairingCode }), { "content-type": "application/json" }), db);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ runnerId });
});

test("an 8 MiB chunked body is refused with 413 without being read whole", async () => {
  const { db } = await withCode();
  let pulled = 0;
  const chunk = new Uint8Array(64 * 1024).fill(0x20);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= 8 * 1024 * 1024) return controller.close();
      pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  const res = await handlePair(post(body), db);
  expect(res.status).toBe(413);
  expect(pulled).toBeLessThanOrEqual(3 * chunk.byteLength); // a chunk or two, not 8 MiB
});

test("a body announced larger than the limit is refused unread", async () => {
  const { db } = await withCode();
  const res = await handlePair(post("{}", { "content-length": String(8 * 1024 * 1024) }), db);
  expect(res.status).toBe(413);
});

test("a bad body is a 400, an unknown code a 401", async () => {
  const { db } = await withCode();
  expect((await handlePair(post("not json"), db)).status).toBe(400);
  expect((await handlePair(post(JSON.stringify({ code: "AAAAAAAA" })), db)).status).toBe(401);
});
