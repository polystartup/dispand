import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { createSecretBox, secretAad, SecretError } from "./secrets.ts";

const box = createSecretBox(randomBytes(32));
const aad = secretAad("harnesses", "h1", "api_key");
const plain = "sk-test-0123456789";

test("seal then open returns the plaintext", () => {
  const sealed = box.seal(plain, aad);
  expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
  expect(sealed).not.toContain(plain);
  expect(box.open(sealed, aad)).toBe(plain);
  expect(box.open(box.seal("", aad), aad)).toBe("");
});

test("open with another aad throws SecretError", () => {
  const sealed = box.seal(plain, aad);
  expect(() => box.open(sealed, secretAad("harnesses", "h2", "api_key"))).toThrow(SecretError);
  expect(() => box.open(sealed, secretAad("harnesses", "h1", "other"))).toThrow(SecretError);
});

test("another key can't open it", () => {
  expect(() => createSecretBox(randomBytes(32)).open(box.seal(plain, aad), aad)).toThrow(SecretError);
});

test("a flipped byte throws SecretError", () => {
  const sealed = box.seal(plain, aad);
  const [v, iv, body] = sealed.split(".");
  const bytes = Buffer.from(body!, "base64url");
  for (const i of [0, bytes.length - 1]) {
    const altered = Buffer.from(bytes);
    altered[i]! ^= 1;
    expect(() => box.open(`${v}.${iv}.${altered.toString("base64url")}`, aad)).toThrow(SecretError);
  }
  const ivBytes = Buffer.from(iv!, "base64url");
  ivBytes[0]! ^= 1;
  expect(() => box.open(`${v}.${ivBytes.toString("base64url")}.${body}`, aad)).toThrow(SecretError);
});

test("malformed sealed text throws SecretError without echoing it", () => {
  for (const sealed of ["", "v1", "v2.a.b", "v1.a.b.c", "v1..", plain]) {
    expect(() => box.open(sealed, aad)).toThrow(SecretError);
    try {
      box.open(sealed, aad);
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(plain);
    }
  }
});

test("two seals of the same text differ", () => {
  expect(box.seal(plain, aad)).not.toBe(box.seal(plain, aad));
});

test("a key that isn't 32 bytes is refused", () => {
  expect(() => createSecretBox(randomBytes(16))).toThrow("32 bytes");
});

test("aad parts can't run into each other", () => {
  expect(secretAad("a", "b.c", "d")).not.toBe(secretAad("a.b", "c", "d"));
});
