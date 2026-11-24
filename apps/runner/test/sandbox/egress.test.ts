// What a worker on its own internal network can reach, before any route through the supervisor:
// nothing on the host, no metadata service, no other worker. Real gVisor in CI
// (DISPAND_SANDBOX_RUNTIME=runsc, DISPAND_SANDBOX_IMAGE).
import { type ChildProcessWithoutNullStreams, execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Sandbox } from "../../src/sandbox/worker.ts";

const RUNTIME = process.env.DISPAND_SANDBOX_RUNTIME;
const IMAGE = process.env.DISPAND_SANDBOX_IMAGE ?? "";
const docker = (...args: string[]) => promisify(execFile)("docker", args);

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
  let base: string;
  let listener: Server;
  let port: number;

  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "egress-")));
    for (const net of nets) await docker("network", "create", "--internal", "--label", "dispand.runner.worker=1", net);
    // A host service on every address, as a host's SSH or database would be.
    listener = createServer((s) => s.end("host\n"));
    await new Promise<void>((r) => listener.listen(0, "0.0.0.0", r));
    port = (listener.address() as { port: number }).port;
  });
  afterAll(async () => {
    listener?.close();
    await docker("rm", "-f", `dispand-egress-peer-${id}`).catch(() => undefined);
    for (const net of nets) await docker("network", "rm", net).catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  });

  const output = (child: ChildProcessWithoutNullStreams) =>
    new Promise<string>((resolve) => {
      let out = "";
      child.stdout.on("data", (d: Buffer) => (out += d));
      child.stderr.on("data", (d: Buffer) => (out += d));
      child.on("exit", () => resolve(out));
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
    const sandbox = new Sandbox({ image: IMAGE, runtime: RUNTIME!, stateDir: base, stateSource: base, network: nets[0] });
    await mkdir(join(base, "runs", "probe"), { recursive: true });
    const worker = await sandbox.worker(join(base, "runs", "probe"), join(base, "cli", "probe"));
    const out = await output(worker.probe(["node", "-e", PROBE, ...targets]));
    await worker.remove();
    for (const target of targets) expect(out, out).toContain(`${target} closed`);
  }, 120_000);
});
