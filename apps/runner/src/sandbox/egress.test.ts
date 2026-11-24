import { expect, test } from "vitest";
import { blockList, checkDestination, modelForwarder, openEgress, refused } from "./egress.ts";

test("metadata, loopback and link-local are refused in every address form, a public address isn't", () => {
  const list = blockList(["198.51.100.7"]);
  for (const address of [
    "169.254.169.254", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "0:0:0:0:0:ffff:a9fe:a9fe",
    "168.63.129.16", "100.100.100.200", "fd00:ec2::254", "fd20:ce::254", "127.0.0.1", "::1", "0.0.0.0", "fe80::1",
    "198.51.100.7",
  ]) expect(refused(list, address), address).toBe(true);
  for (const address of ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"]) expect(refused(list, address), address).toBe(false);
});

test("no route opens when the host's own addresses can't be read", async () => {
  await expect(openEgress({ network: "n", owner: "t", keys: {}, hostAddresses: () => Promise.reject(new Error("no answer")) })).rejects.toThrow("can't be read");
});

test("a malformed DISPAND_HOST_ADDRESSES entry, or a Docker whose network isn't the machine's without one, refuses every check", async () => {
  const { hostAddressesFrom } = await import("./egress.ts");
  // Malformed: refused before the helper is ever started.
  await expect(hostAddressesFrom({ image: "w", owner: async () => "t", fixed: ["not-an-address"], docker: "/nonexistent/docker" })()).rejects.toThrow("isn't an address");
  // A docker client that can't start: the check is refused, the supervisor keeps running.
  await expect(hostAddressesFrom({ image: "w", owner: async () => "t", fixed: [], docker: "/nonexistent/docker" })()).rejects.toThrow();
  // Rootless Docker without the machine's addresses: refused.
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "rootless-"));
  try {
    const docker = join(dir, "docker");
    await writeFile(docker, '#!/bin/sh\n[ "$1" = info ] && echo \'["name=seccomp,profile=builtin","name=rootless"] Ubuntu\' && exit 0\nexit 1\n', { mode: 0o755 });
    await expect(hostAddressesFrom({ image: "w", owner: async () => "t", fixed: [], docker })()).rejects.toThrow("isn't the machine's");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the host's addresses are read at each check: one gained after a first check is refused at the next", async () => {
  // As a host that gets a new address while the supervisor runs: the first answer, then the second.
  const answers = [["198.51.100.7"], ["198.51.100.7", "203.0.113.9"]];
  const hosts = async () => answers.shift() ?? [];
  const url = new URL("http://203.0.113.9:9/mcp");
  await expect(checkDestination(url, hosts)).resolves.toBeUndefined();
  await expect(checkDestination(url, hosts)).rejects.toThrow("refused");
  // And when they can't be read at all, nothing passes.
  await expect(checkDestination(new URL("http://93.184.215.14/"), () => Promise.reject(new Error("no answer")))).rejects.toThrow();
});

test("a malformed request target gets a 400, and the forwarder keeps serving", async () => {
  const { createServer } = await import("node:http");
  const { connect } = await import("node:net");
  const server = createServer(modelForwarder({ anthropic: "k" }, new Set()));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const raw = (line: string) => new Promise<string>((done) => {
    const s = connect(port, "127.0.0.1", () => s.write(`${line}\r\nHost: x\r\nContent-Length: 0\r\n\r\n`));
    let out = "";
    s.on("data", (d) => (out += d)).on("end", () => done(out.split("\r\n")[0]!)).on("error", () => done(out));
  });
  try {
    expect(await raw("POST http://[bad/anthropic/v1/messages HTTP/1.1")).toBe("HTTP/1.1 400 Bad Request");
    expect(await raw("POST /anthropic/v1/files HTTP/1.1")).toBe("HTTP/1.1 403 Forbidden");
  } finally {
    server.close();
  }
});
