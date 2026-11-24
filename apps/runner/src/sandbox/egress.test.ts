import { expect, test } from "vitest";
import { blockList, modelForwarder, openEgress, refused } from "./egress.ts";

test("metadata, loopback and link-local are refused in every address form, a public address isn't", () => {
  const list = blockList(["198.51.100.7"]);
  for (const address of [
    "169.254.169.254", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "0:0:0:0:0:ffff:a9fe:a9fe",
    "168.63.129.16", "100.100.100.200", "fd00:ec2::254", "fd20:ce::254", "127.0.0.1", "::1", "0.0.0.0", "fe80::1",
    "198.51.100.7",
  ]) expect(refused(list, address), address).toBe(true);
  for (const address of ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"]) expect(refused(list, address), address).toBe(false);
});

test("no route opens without the host's own addresses, nor with one that isn't an address", async () => {
  await expect(openEgress({ network: "n", owner: "t", keys: {} })).rejects.toThrow("DISPAND_HOST_ADDRESSES");
  await expect(openEgress({ network: "n", owner: "t", keys: {}, hostAddresses: ["not-an-address"] })).rejects.toThrow("DISPAND_HOST_ADDRESSES");
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
