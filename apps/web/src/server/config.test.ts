import { expect, test } from "vitest";
import { loadServerConfig } from "./config.ts";

const full = {
  DATABASE_URL: "postgres://x",
  BETTER_AUTH_URL: "https://app.example",
  BETTER_AUTH_SECRET: "s".repeat(40),
  DISPAND_SETUP_CODE: "c".repeat(20),
  DISPAND_FILES_DIR: "/data/files",
  DISPAND_SECRET_KEY: Buffer.alloc(32, 7).toString("base64"),
};

test("production loads every setting and turns the rate limit on", () => {
  expect(loadServerConfig(full, "production")).toEqual({
    mode: "production",
    databaseUrl: "postgres://x",
    baseURL: "https://app.example",
    secret: "s".repeat(40),
    setupCode: "c".repeat(20),
    rateLimit: true,
    secretKey: Buffer.alloc(32, 7),
    port: 3000,
    filesDir: "/data/files",
    gitFileUrls: false,
  });
  expect(loadServerConfig({ ...full, PORT: "8080", HOST: "0.0.0.0" }, "production")).toMatchObject({
    port: 8080,
    host: "0.0.0.0",
  });
});

test.each(Object.keys(full))("production throws when %s is missing", (name) => {
  const env = { ...full, [name]: undefined };
  expect(() => loadServerConfig(env, "production")).toThrow(name);
});

test("production lists all missing settings", () => {
  expect(() => loadServerConfig({}, "production")).toThrow(
    "Missing settings: DATABASE_URL, BETTER_AUTH_URL, BETTER_AUTH_SECRET, DISPAND_SETUP_CODE, DISPAND_SECRET_KEY, DISPAND_FILES_DIR",
  );
});

test("production refuses a setup code shorter than 16 characters", () => {
  expect(() => loadServerConfig({ ...full, DISPAND_SETUP_CODE: "short" }, "production")).toThrow(
    "DISPAND_SETUP_CODE",
  );
});

test("production without DISPAND_SECRET_KEY throws", () => {
  expect(() => loadServerConfig({ ...full, DISPAND_SECRET_KEY: undefined }, "production")).toThrow(
    "Missing settings: DISPAND_SECRET_KEY",
  );
});

test.each([
  ["16 bytes", Buffer.alloc(16, 1).toString("base64")],
  ["33 bytes", Buffer.alloc(33, 1).toString("base64")],
  ["hex", Buffer.alloc(32, 1).toString("hex")],
  ["base64url", Buffer.alloc(32, 0xff).toString("base64url")],
  ["not base64", "!".repeat(43) + "="],
])("a key that isn't 32 bytes of base64 is refused (%s)", (_, key) => {
  expect(() => loadServerConfig({ ...full, DISPAND_SECRET_KEY: key }, "production")).toThrow(
    "DISPAND_SECRET_KEY must be 32 bytes, base64",
  );
});

test("a key with a trailing newline is accepted", () => {
  const key = Buffer.alloc(32, 9);
  expect(loadServerConfig({ ...full, DISPAND_SECRET_KEY: `${key.toString("base64")}\n` }, "production").secretKey).toEqual(key);
});

test("development fills the dev defaults, but still needs a database", () => {
  const config = loadServerConfig({ DATABASE_URL: "pglite://memory" }, "development");
  expect(config).toMatchObject({ mode: "development", baseURL: "http://localhost:3000", rateLimit: false });
  expect(config.secretKey).toHaveLength(32);
  expect(loadServerConfig({ DATABASE_URL: "pglite://memory" }, "development").secretKey).toEqual(config.secretKey);
  expect(() => loadServerConfig({}, "development")).toThrow("DATABASE_URL");
});

test("production requires DISPAND_FILES_DIR; development keeps files under .data/files", () => {
  expect(() => loadServerConfig({ ...full, DISPAND_FILES_DIR: undefined }, "production")).toThrow("DISPAND_FILES_DIR");
  expect(loadServerConfig({ DATABASE_URL: "pglite://memory" }, "development").filesDir).toMatch(/\/\.data\/files$/);
});

test("file:// marketplaces only in development, and only when asked", () => {
  expect(loadServerConfig({ ...full, DISPAND_GIT_FILE_URLS: "1" }, "production").gitFileUrls).toBe(false);
  expect(loadServerConfig({ DATABASE_URL: "pglite://memory" }, "development").gitFileUrls).toBe(false);
  expect(loadServerConfig({ DATABASE_URL: "pglite://memory", DISPAND_GIT_FILE_URLS: "1" }, "development").gitFileUrls).toBe(true);
});
