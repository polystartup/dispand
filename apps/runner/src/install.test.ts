import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const run = (...args: string[]) =>
  promisify(execFile)("sh", ["install/install.sh", ...args], { env: { ...process.env, DISPAND_PAIRING_CODE: "ABCD2345" } }).then(
    () => ({ code: 0, stderr: "" }),
    (err: { code: number; stderr: string }) => ({ code: err.code, stderr: err.stderr }),
  );

test.each([
  "http://dispand.lan",
  "http://127.0.0.1.evil.test",
  "http://localhost@evil.test",
  "http://localhost:1@evil.invalid",
  "http://127.0.0.1:x@evil.invalid",
  "http://[::1]:1@evil.invalid",
  "ftp://dispand.lan",
])(
  "install.sh refuses %s before downloading anything",
  async (server) => {
    const { code, stderr } = await run("--server", server);
    expect(code).toBe(2);
    expect(stderr).toContain("https");
  },
);

test("install.sh downloads over https only", async () => {
  const { readFile } = await import("node:fs/promises");
  const script = await readFile("install/install.sh", "utf8");
  expect(script).toContain("--proto \"$proto\" --tlsv1.2");
  expect(script).toContain("proto='=https'");
});

test.each(["http://127.0.0.1:9", "http://localhost:9", "http://[::1]:9"])(
  "install.sh lets %s through to the download (loopback, for development)",
  async (server) => {
    // Nothing listens on port 9: curl fails to connect (7), after the server check passed.
    const { code, stderr } = await run("--server", server);
    expect(code).toBe(7);
    expect(stderr).not.toContain("must use https");
  },
);
