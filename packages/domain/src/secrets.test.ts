import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { createSecretBox, secretAad, SecretError } from "./secrets.ts";

const box = createSecretBox(randomBytes(32));
const aad = secretAad("harnesses", "h1", "api_key");
const plain = "sk-test-0123456789";

test("seal then open returns the plaintext", () => {
  const sealed = box.seal(plain, aad);
  expect(sealed).toMatch(/^v2\.[0-9a-f]{8}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
  expect(sealed.startsWith(box.current)).toBe(true);
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
  const [v, id, iv, body] = sealed.split(".");
  const bytes = Buffer.from(body!, "base64url");
  for (const i of [0, bytes.length - 1]) {
    const altered = Buffer.from(bytes);
    altered[i]! ^= 1;
    expect(() => box.open(`${v}.${id}.${iv}.${altered.toString("base64url")}`, aad)).toThrow(SecretError);
  }
  const ivBytes = Buffer.from(iv!, "base64url");
  ivBytes[0]! ^= 1;
  expect(() => box.open(`${v}.${id}.${ivBytes.toString("base64url")}.${body}`, aad)).toThrow(SecretError);
});

test("malformed sealed text throws SecretError without echoing it", () => {
  for (const sealed of ["", "v1", "v2.a.b", "v1.a.b.c", "v1..", "v2...", "v3.a.b.c", plain]) {
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

test("a key that isn't 32 bytes is refused, current or previous, and so is the same key twice", () => {
  expect(() => createSecretBox(randomBytes(16))).toThrow("32 bytes");
  expect(() => createSecretBox(randomBytes(32), randomBytes(16))).toThrow("32 bytes");
  const key = randomBytes(32);
  expect(() => createSecretBox(key, Buffer.from(key))).toThrow("differ");
});

// Sealed by the release before key ids (`v1`), with this key: a value stored then still opens.
const V1_KEY = Buffer.from("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=", "base64");
const V1_SEALED = "v1.IDg2DU_vtkMrWYa6.GeKzOe0dmgacYi_VNW4_L-tJXAwWzE9-err6g0nM5_Md0Q";

test("a v1 value opens under its key, current or previous, and under no other", () => {
  expect(createSecretBox(V1_KEY).open(V1_SEALED, aad)).toBe(plain);
  expect(createSecretBox(randomBytes(32), V1_KEY).open(V1_SEALED, aad)).toBe(plain);
  expect(() => createSecretBox(randomBytes(32)).open(V1_SEALED, aad)).toThrow(SecretError);
  expect(() => createSecretBox(randomBytes(32), randomBytes(32)).open(V1_SEALED, aad)).toThrow(SecretError);
  expect(() => createSecretBox(V1_KEY).open(V1_SEALED, secretAad("harnesses", "h2", "api_key"))).toThrow(SecretError);
});

test("after a rotation the previous key's values open, new ones seal under the current key, and reseal moves an old one over", () => {
  const before = randomBytes(32);
  const after = randomBytes(32);
  const old = createSecretBox(before).seal(plain, aad);
  const ring = createSecretBox(after, before);
  expect(ring.rotating).toBe(true);
  expect(createSecretBox(after).rotating).toBe(false);
  expect(ring.open(old, aad)).toBe(plain);
  expect(old.startsWith(ring.current)).toBe(false);
  expect(ring.current).toBe(createSecretBox(after).current);
  const moved = ring.reseal(old, aad);
  expect(moved.startsWith(ring.current)).toBe(true);
  expect(createSecretBox(after).open(moved, aad)).toBe(plain);
  expect(() => ring.reseal(old, secretAad("harnesses", "h2", "api_key"))).toThrow(SecretError);
  // Once the previous key is gone, what it alone sealed no longer opens.
  expect(() => createSecretBox(after).open(old, aad)).toThrow(SecretError);
  // A value naming a key the ring doesn't hold doesn't open, even when its bytes are another key's.
  expect(() => ring.open(old.replace(/^v2\.[0-9a-f]{8}\./, "v2.00000000."), aad)).toThrow(SecretError);
});

test("aad parts can't run into each other", () => {
  expect(secretAad("a", "b.c", "d")).not.toBe(secretAad("a.b", "c", "d"));
});

test("an origin binds a secret to it, and without one the AAD is the same as before origins", () => {
  expect(secretAad("tools", "t1", "header:x")).toBe('["tools","t1","header:x"]');
  const sealed = box.seal(plain, secretAad("tools", "t1", "header:x", "https://a.example"));
  expect(box.open(sealed, secretAad("tools", "t1", "header:x", "https://a.example"))).toBe(plain);
  expect(() => box.open(sealed, secretAad("tools", "t1", "header:x", "https://b.example"))).toThrow(SecretError);
  expect(() => box.open(sealed, secretAad("tools", "t1", "header:x"))).toThrow(SecretError);
});
