// The self-test's network probe, run here as a worker runs it: what it counts as "no host".
import { execFile } from "node:child_process";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ROUTE_CHECK_SCRIPT } from "./worker.ts";

const run = promisify(execFile);
const servers: Server[] = [];
const listen = async (onConnection: (socket: Socket) => void) => {
  const server = createServer(onConnection);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};
afterAll(() => Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve)))));

let route = 0;
let open = 0;
let closed = 0;
beforeAll(async () => {
  // The worker's route: answers, and refuses CONNECT to metadata.
  route = await listen((socket) => socket.once("data", () => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n")));
  open = await listen((socket) => socket.destroy());
  // A port nothing listens on.
  const gone = createServer();
  await new Promise<void>((resolve) => gone.listen(0, "127.0.0.1", resolve));
  closed = (gone.address() as AddressInfo).port;
  await new Promise((resolve) => gone.close(resolve));
});

const passes = async (proxyPort: number, ...targets: string[]) => {
  const { stdout } = await run(process.execPath, ["-e", ROUTE_CHECK_SCRIPT, ...targets], {
    env: { PATH: process.env.PATH, HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` },
  });
  return [...stdout.matchAll(/^pass:(\S+)$/gm)].map((m) => m[1]);
};

// Documentation's own address (TEST-NET-1): never routed, so it stays silent, as a host behind a blocked route.
const SILENT = "192.0.2.1:22";

test("a host that answers fails no-host, whether it connects or refuses", async () => {
  expect(await passes(route, `127.0.0.1:${open}`)).not.toContain("no-host");
  // A refusal is the host answering: only a closed port, the network open.
  expect(await passes(route, `127.0.0.1:${closed}`)).not.toContain("no-host");
}, 30_000);

test("a silent host passes no-host, once the route answers and a closed port of it refuses", async () => {
  expect(await passes(route, SILENT)).toEqual(expect.arrayContaining(["metadata-refused-by-the-route", "no-host"]));
}, 30_000);

test("without its positive control, no-host fails: a silent host proves nothing when nothing answers", async () => {
  expect(await passes(closed, SILENT)).not.toContain("no-host");
}, 30_000);
