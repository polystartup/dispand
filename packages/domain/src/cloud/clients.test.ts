import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { expect, test } from "vitest";
import { SecretError } from "../secrets.ts";
import { MAX_RETRY_WAIT_MS, MODEL_RETRIES, retryDelay } from "./clients.ts";

const failure = (status: number | undefined, headers: Record<string, string> = {}) =>
  Object.assign(new Error("provider"), { status, headers: new Headers(headers) });

test("a transient failure waits what the provider asks for", () => {
  expect(retryDelay(failure(429, { "retry-after-ms": "250" }), 0)).toBe(250);
  expect(retryDelay(failure(503, { "retry-after": "2" }), 0)).toBe(2_000);
  const date = retryDelay(failure(529, { "retry-after": new Date(Date.now() + 60_000).toUTCString() }), 0);
  expect(date).toBeGreaterThan(55_000);
  expect(date).toBeLessThanOrEqual(60_000);
  expect(retryDelay(failure(429, { "retry-after-ms": "", "retry-after": "1" }), 0)).toBe(1_000);
  expect(retryDelay(failure(429, { "retry-after": new Date(Date.now() - 60_000).toUTCString() }), 0)).toBe(0);
});

test("without a wait asked, retries back off from 5 s, doubling", () => {
  for (const [retried, full] of [
    [0, 5_000],
    [1, 10_000],
    [4, 80_000],
  ] as const) {
    const wait = retryDelay(failure(500), retried)!;
    expect(wait).toBeGreaterThan(full * 0.75 - 1);
    expect(wait).toBeLessThanOrEqual(full);
  }
});

test("a failure is retried at most MODEL_RETRIES times, and never past the longest wait", () => {
  expect(retryDelay(failure(429, { "retry-after": "1" }), MODEL_RETRIES - 1)).toBe(1_000);
  expect(retryDelay(failure(429, { "retry-after": "1" }), MODEL_RETRIES)).toBeUndefined();
  expect(retryDelay(failure(429, { "retry-after-ms": String(MAX_RETRY_WAIT_MS) }), 0)).toBe(MAX_RETRY_WAIT_MS);
  expect(retryDelay(failure(429, { "retry-after": String(MAX_RETRY_WAIT_MS / 1000 + 1) }), 0)).toBeUndefined();
});

test("only what the SDKs retry is transient, unless the provider says otherwise", () => {
  for (const status of [408, 409, 429, 500, 502, 503, 529]) expect(retryDelay(failure(status), 0), String(status)).toBeDefined();
  for (const status of [400, 401, 403, 404, 413, 422]) expect(retryDelay(failure(status), 0), String(status)).toBeUndefined();
  expect(retryDelay(failure(503, { "x-should-retry": "false" }), 0)).toBeUndefined();
  expect(retryDelay(failure(400, { "x-should-retry": "true" }), 0)).toBeDefined();
  expect(retryDelay(new Anthropic.APIConnectionError({ message: "reset" }), 0)).toBeDefined();
  expect(retryDelay(new OpenAI.APIConnectionTimeoutError(), 0)).toBeDefined();
  const streamed = (type: string) =>
    new Anthropic.APIError(undefined, { type: "error", error: { type, message: "" } }, undefined, new Headers(), type as never);
  expect(retryDelay(streamed("overloaded_error"), 0)).toBeDefined();
  expect(retryDelay(streamed("api_error"), 0)).toBeDefined();
  expect(retryDelay(streamed("invalid_request_error"), 0)).toBeUndefined();
  expect(retryDelay(new OpenAI.APIUserAbortError(), 0)).toBeUndefined();
  expect(retryDelay(new SecretError(), 0)).toBeUndefined();
  expect(retryDelay(new Error("The model's stream ended before the response did"), 0)).toBeUndefined();
  expect(retryDelay(undefined, 0)).toBeUndefined();
});
