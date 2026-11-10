import { emptyContext } from "@dispand/domain/test-support";
import { expect, test } from "vitest";
import { createRpcHandler, handleRpc, STREAM_HEARTBEAT_MS } from "./rpc.ts";

const body = { json: { name: "Ada", email: "ada@example.com", password: "correct horse battery", setupCode: "test-setup-code-0123456789" } };

function post(headers: Record<string, string>, content: string, contentType: string, procedure = "setup") {
  return new Request(`http://localhost:3000/api/rpc/auth/${procedure}`, {
    method: "POST",
    headers: { origin: "http://evil.example", "content-type": contentType, ...headers },
    body: content,
  });
}

test("a cross-origin form-style request is refused and creates no owner", async () => {
  const app = await emptyContext();
  const res = await handleRpc(post({}, JSON.stringify(body), "text/plain"), app);
  expect(res.status).toBe(403);
  const status = await handleRpc(post({ "x-csrf-token": "orpc" }, "{}", "application/json", "status"), app).then((r) => r.json());
  expect(status).toMatchObject({ json: { needsSetup: true } }); // the refused request created nothing
});

test("a request with the client's CSRF header works", async () => {
  const app = await emptyContext();
  const res = await handleRpc(post({ "x-csrf-token": "orpc" }, JSON.stringify(body), "application/json"), app);
  expect(res.status).toBe(200);
  const again = await handleRpc(post({ "x-csrf-token": "orpc" }, JSON.stringify(body), "application/json"), app);
  expect(again.status).toBe(403);
});

test("an idle stream sends a heartbeat comment, well within a proxy's read timeout", async () => {
  expect(STREAM_HEARTBEAT_MS).toBeLessThanOrEqual(30_000);
  const app = await emptyContext();
  const csrf = { "x-csrf-token": "orpc", origin: "http://localhost:3000" };
  expect((await handleRpc(post(csrf, JSON.stringify(body), "application/json"), app)).status).toBe(200);
  const signIn = await app.auth.api.signInEmail({ body: { email: "ada@example.com", password: "correct horse battery" }, returnHeaders: true });
  const cookie = signIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const abort = new AbortController();
  const res = await handleRpc(
    new Request("http://localhost:3000/api/rpc/questions/stream", {
      method: "POST",
      headers: { ...csrf, cookie, "content-type": "application/json" },
      body: "{}",
      signal: abort.signal,
    }),
    app,
    createRpcHandler(50),
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("x-accel-buffering")).toBe("no");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 2000;
  // The first event (the pending count), then nothing happens: comments keep the stream alive.
  while (Date.now() < deadline && (text.match(/^:.*$/gm)?.length ?? 0) < 3) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  abort.abort();
  await reader.cancel().catch(() => {});
  expect(text).toMatch(/^event: message$/m);
  expect(text.match(/^:.*$/gm)?.length ?? 0).toBeGreaterThanOrEqual(3);
});
