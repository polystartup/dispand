// The containers of one run: a fresh PostgreSQL and the app's image, both on the host's network
// (no proxy between the harness, the app and the database) and bound to 127.0.0.1.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function docker(...args: string[]): Promise<string> {
  return (await exec("docker", args, { maxBuffer: 64 * 2 ** 20 })).stdout.trim();
}

/** `docker run -d --rm` with `env` passed by name, so its values (secrets) stay off the command line. */
async function run(env: Record<string, string>, ...args: string[]): Promise<void> {
  const named = Object.keys(env).flatMap((key) => ["-e", key]);
  await exec("docker", ["run", "-d", "--rm", ...named, ...args], { env: { ...process.env, ...env } });
}

/** A port free right now on 127.0.0.1. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer().once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** Docker's CPU and memory limits for a container; "0" or empty leaves it unlimited. */
export type Limits = { cpus?: string; cpuset?: string; memory?: string };

const limitArgs = ({ cpus, cpuset, memory }: Limits) => [
  ...(cpus && cpus !== "0" ? ["--cpus", cpus] : []),
  ...(cpuset ? ["--cpuset-cpus", cpuset] : []),
  ...(memory && memory !== "0" ? ["--memory", memory] : []),
];

/** The PostgreSQL image `deploy/compose.yaml` pins, so Dependabot keeps this one current too. */
async function postgresImage(): Promise<string> {
  const compose = await readFile(new URL("../../deploy/compose.yaml", import.meta.url), "utf8");
  const image = /^\s*image:\s*(postgres:\S+)/m.exec(compose)?.[1];
  if (!image) throw new Error("deploy/compose.yaml names no postgres image");
  return image;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Starts PostgreSQL as `deploy/compose.yaml` initializes it, with `pg_stat_statements` loaded and the
 * settings of a small managed database (`shared_buffers`, `max_connections`), and waits until it
 * takes TCP connections (the entrypoint's first, socket-only server doesn't). Returns its URL.
 */
export async function startPostgres(name: string, limits: Limits): Promise<string> {
  const port = await freePort();
  const password = randomBytes(18).toString("base64url");
  const env = {
    POSTGRES_USER: "dispand",
    POSTGRES_PASSWORD: password,
    POSTGRES_DB: "dispand",
    POSTGRES_INITDB_ARGS: "--locale-provider=builtin --locale=C.UTF-8",
  };
  const settings = [`port=${port}`, "listen_addresses=127.0.0.1", "shared_preload_libraries=pg_stat_statements", "shared_buffers=512MB", "max_connections=50"];
  await run(env, "--name", name, "--network", "host", ...limitArgs(limits), await postgresImage(), ...settings.flatMap((setting) => ["-c", setting]));
  for (let i = 0; ; i++) {
    try {
      await docker("exec", name, "pg_isready", "-q", "-h", "127.0.0.1", "-p", String(port), "-U", "dispand");
      return `postgres://dispand:${password}@127.0.0.1:${port}/dispand`;
    } catch (err) {
      if (i >= 120) throw err;
      await sleep(500);
    }
  }
}

export type AppOptions = {
  image: string;
  databaseUrl: string;
  limits: Limits;
  /** A directory the app's user (uid 1000 in the image) can write: the probe's samples and the CPU profile. */
  outDir: string;
  /** Where `probe.ts` is on this machine, mounted read-only and preloaded. */
  probe: string;
  cpuProfile: boolean;
};

/** Starts the app's image with fresh secrets and waits for `/api/health`. Returns its URL and setup code. */
export async function startApp(name: string, options: AppOptions): Promise<{ url: string; setupCode: string }> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const setupCode = randomBytes(18).toString("base64url");
  const nodeOptions = ["--import /bench/probe.ts", ...(options.cpuProfile ? ["--cpu-prof", "--cpu-prof-dir=/bench/out"] : [])].join(" ");
  const env = {
    DATABASE_URL: options.databaseUrl,
    BETTER_AUTH_URL: url,
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
    DISPAND_SETUP_CODE: setupCode,
    DISPAND_SECRET_KEY: randomBytes(32).toString("base64"),
    DISPAND_FILES_DIR: "/tmp/files",
    PORT: String(port),
    HOST: "127.0.0.1",
    DISPAND_BENCH_PROBE: "/bench/out/probe.jsonl",
    NODE_OPTIONS: nodeOptions,
  };
  await run(
    env,
    "--name",
    name,
    "--network",
    "host",
    ...limitArgs(options.limits),
    "-v",
    `${options.probe}:/bench/probe.ts:ro`,
    "-v",
    `${options.outDir}:/bench/out`,
    options.image,
  );
  // The first health check waits for the migrations.
  for (let i = 0; ; i++) {
    const ok = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000) }).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) return { url, setupCode };
    if (i >= 120) throw new Error(`the app did not become healthy; see \`docker logs ${name}\``);
    await sleep(1000);
  }
}

/** The CPU a container has used since it started, in seconds (its cgroup's `cpu.stat`). */
export async function containerCpu(name: string): Promise<number> {
  const stat = await docker("exec", name, "cat", "/sys/fs/cgroup/cpu.stat");
  return Number(/usage_usec (\d+)/.exec(stat)?.[1] ?? 0) / 1e6;
}

/** Stops a container gracefully (the app writes its CPU profile on its way out). */
export async function stop(name: string): Promise<void> {
  await docker("stop", "-t", "30", name).catch(() => undefined);
}
