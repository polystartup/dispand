// What a worker on its own internal network can reach, before any route through the supervisor:
// nothing on the host, no metadata service, no other worker. Real gVisor in CI
// (DISPAND_SANDBOX_RUNTIME=runsc, DISPAND_SANDBOX_IMAGE).
import { type ChildProcessWithoutNullStreams, execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { selfContainer } from "../../src/sandbox/egress.ts";
import { Sandbox, type Worker } from "../../src/sandbox/worker.ts";
import { sandboxState, type SandboxState } from "./state.ts";

const RUNTIME = process.env.DISPAND_SANDBOX_RUNTIME;
const IMAGE = process.env.DISPAND_SANDBOX_IMAGE ?? "";
const docker = (...args: string[]) => promisify(execFile)("docker", args);

const output = (child: ChildProcessWithoutNullStreams) =>
  new Promise<string>((done) => {
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.stderr.on("data", (d: Buffer) => (out += d));
    child.on("exit", () => done(out));
  });

/** Tries each `host:port` from inside a worker; prints `<target> open|closed`. */
const PROBE = `
const net = require("node:net");
const targets = process.argv.slice(1);
let left = targets.length;
for (const target of targets) {
  const i = target.lastIndexOf(":");
  const socket = net.connect({ host: target.slice(0, i).replace(/^\\[|\\]$/g, ""), port: Number(target.slice(i + 1)), timeout: 3000 });
  const done = (state) => { socket.destroy(); console.log(target + " " + state); if (--left === 0) process.exit(0); };
  socket.once("connect", () => done("open"));
  socket.once("timeout", () => done("closed"));
  socket.once("error", () => done("closed"));
}`;

describe.skipIf(!RUNTIME)(`a worker's own network on ${RUNTIME}`, () => {
  const id = process.pid;
  const nets = [`dispand-egress-a-${id}`, `dispand-egress-b-${id}`];
  let state: SandboxState;
  let listener: Server;
  let port: number;

  beforeAll(async () => {
    state = await sandboxState();
    // No address of the host on it: `inhibit_ipv4` leaves the bridge without a gateway address.
    for (const net of nets) await docker("network", "create", "--internal", "-o", "com.docker.network.bridge.inhibit_ipv4=true", "--label", "dispand.runner.worker=1", net);
    // A host service on every address, as a host's SSH or database would be.
    listener = createServer((s) => s.end("host\n"));
    await new Promise<void>((r) => listener.listen(0, "0.0.0.0", r));
    port = (listener.address() as { port: number }).port;
  });
  afterAll(async () => {
    listener?.close();
    await docker("rm", "-f", `dispand-egress-peer-${id}`).catch(() => undefined);
    for (const net of nets) await docker("network", "rm", net).catch(() => undefined);
    await state.done();
  });

  test("reaches no host address, no metadata service and no other worker", async () => {
    const gateway = (await docker("network", "inspect", "-f", "{{(index .IPAM.Config 0).Gateway}}", nets[0]!)).stdout.trim();
    // Another worker, on a network of its own, listening.
    await docker("run", "-d", "--name", `dispand-egress-peer-${id}`, "--runtime", RUNTIME!, "--network", nets[1]!, IMAGE, "node", "-e", "require('node:net').createServer((s) => s.end('peer')).listen(8080)");
    const peer = (await docker("inspect", "-f", `{{(index .NetworkSettings.Networks "${nets[1]}").IPAddress}}`, `dispand-egress-peer-${id}`)).stdout.trim();
    const hostAddresses = Object.values(networkInterfaces()).flat().filter((a) => a && !a.internal && a.family === "IPv4").map((a) => a!.address);
    const targets = [
      `${gateway}:${port}`,
      ...hostAddresses.map((a) => `${a}:${port}`),
      "169.254.169.254:80",
      "168.63.129.16:80",
      `${peer}:8080`,
    ];
    const sandbox = new Sandbox({ owner: `test-${process.pid}`, image: IMAGE, runtime: RUNTIME!, stateDir: state.stateDir, stateSource: state.stateSource, network: nets[0] });
    await sandbox.sweep();
    await mkdir(join(state.base, "runs", "probe"), { recursive: true });
    const worker = await sandbox.worker(join(state.base, "runs", "probe"), join(state.base, "cli", "probe"));
    const out = await output(worker.probe(["node", "-e", PROBE, ...targets]));
    await worker.remove();
    for (const target of targets) expect(out, out).toContain(`${target} closed`);
  }, 120_000);
});

/**
 * From inside a worker: each target through its proxy (`connect <target> <status line>`) and
 * directly (`direct <target> open|closed`), then the model forwarder's answers (`model {...}`).
 */
const ROUTE_PROBE = `
const net = require("node:net");
const { connect: through, direct } = JSON.parse(process.argv[1]);
const proxy = new URL(process.env.HTTPS_PROXY);
const once = (target, viaProxy) => new Promise((done) => {
  const i = target.lastIndexOf(":");
  const socket = viaProxy
    ? net.connect({ host: proxy.hostname, port: Number(proxy.port), timeout: 15000 })
    : net.connect({ host: target.slice(0, i).replace(/^\\[|\\]$/g, ""), port: Number(target.slice(i + 1)), timeout: 3000 });
  let answer = "";
  const end = (state) => { socket.destroy(); console.log((viaProxy ? "connect " : "direct ") + target + " " + state); done(); };
  socket.once("connect", () => viaProxy ? socket.write("CONNECT " + target + " HTTP/1.1\\r\\nHost: " + target + "\\r\\n\\r\\n") : end("open"));
  socket.on("data", (d) => { answer += d; if (answer.includes("\\r\\n")) end(answer.split("\\r\\n")[0]); });
  socket.once("timeout", () => end("closed"));
  socket.once("error", () => end("closed"));
});
(async () => {
  for (const t of through) await once(t, true);
  for (const t of direct) await once(t, false);
  const base = process.env.ANTHROPIC_BASE_URL;
  const post = (path, headers = {}, method = "POST") => fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, ...(method === "POST" ? { body: "{}" } : {}) })
    .then(async (r) => ({ status: r.status, body: r.status === 200 ? await r.json() : null }), () => ({ status: 0 }));
  const model = {
    messages: await post("/v1/messages", { "x-api-key": "worker-own", authorization: "Bearer worker-own" }),
    files: (await post("/v1/files")).status,
    get: (await post("/v1/messages", {}, "GET")).status,
    redirect: (await post("/v1/messages", { "x-test-redirect": "1" })).status,
    openai: await fetch(proxy.origin + "/openai/v1/responses", { method: "POST", body: "{}" }).then((r) => r.status, () => 0),
  };
  console.log("model " + JSON.stringify(model));
})();`;

// The supervisor's own route, so in the supervisor image only (DISPAND_SANDBOX_STATE, CI's runner-sandbox job).
describe.skipIf(!RUNTIME || !process.env.DISPAND_SANDBOX_STATE)(`a worker's route through the supervisor on ${RUNTIME}`, () => {
  const id = process.pid;
  const doubleName = `dispand-egress-double-${id}`;
  const KEY = "sk-runner-own-key-0123456789";
  let state: SandboxState;
  let sandbox: Sandbox;
  let double: string;
  let loopback: Server;
  const workers: Worker[] = [];

  beforeAll(async () => {
    state = await sandboxState();
    // The provider stand-in, on the supervisor's own bridge.
    await docker("run", "-d", "--name", doubleName, "--read-only", "-v", `${resolve("test/sandbox/egress-double.mjs")}:/double.mjs:ro`, IMAGE, "node", "/double.mjs");
    double = (await docker("inspect", "-f", "{{.NetworkSettings.Networks.bridge.IPAddress}}", doubleName)).stdout.trim();
    // A service of the supervisor's own, on its loopback.
    loopback = createServer((s) => s.end("supervisor\n"));
    await new Promise<void>((r) => loopback.listen(0, "127.0.0.1", r));
    sandbox = new Sandbox({
      image: IMAGE, runtime: RUNTIME!, stateDir: state.stateDir, stateSource: state.stateSource,
      keys: { anthropic: KEY },
      origins: { anthropic: `http://${double}:8080` },
    });
    await sandbox.sweep();
  }, 120_000);
  afterAll(async () => {
    for (const w of workers) await w.remove().catch(() => undefined);
    loopback?.close();
    await docker("rm", "-f", doubleName).catch(() => undefined);
    await state.done();
  });

  const start = async (key: string) => {
    await mkdir(join(state.base, "runs", key), { recursive: true });
    const worker = await sandbox.worker(join(state.base, "runs", key), join(state.base, "cli", key));
    workers.push(worker);
    return worker;
  };

  test("reaches no metadata, host, supervisor or other worker address, by any form or name; a public host, and the model forwarder", async () => {
    // Another worker, listening on its own route's network.
    const peer = await start("peer");
    const peerChild = peer.probe(["node", "-e", "require('node:net').createServer((s) => s.end('peer')).listen(8080, () => console.log(Object.values(require('node:os').networkInterfaces()).flat().find((a) => !a.internal && a.family === 'IPv4').address))"]);
    const peerAddress = await new Promise<string>((done) => peerChild.stdout.once("data", (d: Buffer) => done(d.toString().trim())));
    const self = await selfContainer();
    const gateway = (await docker("inspect", "-f", "{{.NetworkSettings.Networks.bridge.Gateway}}", self)).stdout.trim();
    const port = (loopback.address() as { port: number }).port;
    const hostPort = process.env.DISPAND_TEST_HOST_PORT ?? "22";
    const hosts = (process.env.DISPAND_HOST_ADDRESSES ?? "").split(/[\s,]+/).filter(Boolean);
    const refusedTargets = [
      "169.254.169.254:80", "168.63.129.16:80", "100.100.100.200:80", "[::ffff:169.254.169.254]:80", "[::ffff:a9fe:a9fe]:80",
      "[fd00:ec2::254]:80", "[fd20:ce::254]:80", "metadata.test:80",
      `${gateway}:${hostPort}`, ...hosts.map((h) => `${h}:${hostPort}`), `127.0.0.1:${port}`, `localhost:${port}`,
      `${peerAddress}:8080`, `${double}:8080`,
    ];
    const worker = await start("route");
    const out = await output(worker.probe(["node", "-e", ROUTE_PROBE, JSON.stringify({ connect: [...refusedTargets, "example.com:443"], direct: [`${peerAddress}:8080`, `${double}:8080`, `${gateway}:${hostPort}`, ...hosts.map((h) => `${h}:${hostPort}`)] })]));
    for (const target of refusedTargets) expect(out, out).toContain(`connect ${target} HTTP/1.1 403`);
    expect(out, out).toContain("connect example.com:443 HTTP/1.1 200");
    expect(out, out).not.toMatch(/direct .* open/);
    const model = JSON.parse(/model (.*)/.exec(out)![1]!) as { messages: { status: number; body: { path: string; headers: Record<string, string> } }; files: number; get: number; redirect: number; openai: number };
    // The runner's key replaces whatever the worker sent; nothing else gets it.
    expect(model.messages.status).toBe(200);
    expect(model.messages.body.path).toBe("/v1/messages");
    expect(model.messages.body.headers["x-api-key"]).toBe(KEY);
    expect(model.messages.body.headers.authorization).toBeUndefined();
    expect(model).toMatchObject({ files: 403, get: 403, redirect: 502, openai: 403 });
    peerChild.kill();
  }, 180_000);

  test("its end closes the route, a stream already open through it included", async () => {
    const worker = await start("hold");
    const child = worker.probe(["node", "-e", "fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', headers: { 'x-test-hold': '1' }, body: '{}' }).then(async (r) => { for await (const _ of r.body) {} })"]);
    const held = () => fetch(`http://${double}:8080/held`).then((r) => r.text());
    await vi.waitFor(async () => expect(await held()).toBe("open"), { timeout: 60_000, interval: 500 });
    await worker.remove();
    await vi.waitFor(async () => expect(await held()).toBe("closed"), { timeout: 30_000, interval: 500 });
    child.kill();
  }, 120_000);
});
