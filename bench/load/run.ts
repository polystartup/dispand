// `pnpm bench:load`: starts a fresh PostgreSQL and the app's image, sets up an install, then ramps
// streaming chats step by step while runners, people, schedules and polls keep going, and records
// what each step cost the app's process and the database. README.md says how to read it.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { containerCpu, docker, startApp, startPostgres, stop } from "./docker.ts";
import { Load } from "./load.ts";
import { type Activity, Postgres, type Statement } from "./postgres.ts";
import { type Sample, sampler } from "./probe.ts";
import { Recorder, summarize, type Summary } from "./stats.ts";

const { values: args } = parseArgs({
  options: {
    image: { type: "string", default: "dispand/app:local" },
    chats: { type: "string", default: "5,10,20,40,80" },
    users: { type: "string", default: "20" },
    runners: { type: "string", default: "20" },
    schedules: { type: "string", default: "10" },
    polls: { type: "string", default: "5" },
    rate: { type: "string", default: "30" },
    chars: { type: "string", default: "10" },
    "turn-chars": { type: "string", default: "3500" },
    think: { type: "string", default: "2" },
    "read-every": { type: "string", default: "10" },
    warmup: { type: "string", default: "15" },
    step: { type: "string", default: "60" },
    "app-cpus": { type: "string", default: "0" },
    "app-cpuset": { type: "string", default: "" },
    "pg-cpus": { type: "string", default: "1" },
    "pg-cpuset": { type: "string", default: "" },
    "pg-memory": { type: "string", default: "2g" },
    "max-p99": { type: "string", default: "10000" },
    "cpu-prof": { type: "boolean", default: false },
    out: { type: "string" },
    keep: { type: "boolean", default: false },
  },
});
const num = (name: keyof typeof args) => Number(args[name]);

const here = fileURLToPath(new URL(".", import.meta.url));
const outDir = args.out ?? join(here, "results", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(outDir, { recursive: true });
const id = `dispand-bench-${process.pid}`;
const steps = args.chats.split(",").map(Number);

type Step = {
  chats: number;
  seconds: number;
  rates: Record<string, number>;
  latency: Record<string, Summary>;
  app: Record<string, Summary>;
  appContainerCpu: number;
  harness: Record<string, Summary>;
  postgres: { cpu: number; commitsPerSecond: number; active: Summary; idle: Summary; waits: Record<string, number>; top: Statement[] };
  backlog: Summary;
  host: { load1Start: number; load1End: number; busyCores: number };
};

/** Cores busy on the whole machine since `from` (`/proc/stat`), to see other work on it. */
const hostBusy = () => {
  const [, ...fields] = readFileSync("/proc/stat", "utf8").split("\n")[0]!.trim().split(/\s+/).map(Number);
  const idle = fields[3]! + fields[4]!;
  return { total: fields.reduce((a, b) => a + b, 0), idle };
};

const series = (samples: Sample[]) =>
  Object.fromEntries((["cpu", "elu", "lagP99", "lagMax", "rssMb"] as const).map((key) => [key, summarize(samples.map((s) => s[key]))]));

const rec = new Recorder();
const harnessSamples: Sample[] = [];
sampler((sample) => harnessSamples.push(sample));

const pgName = `${id}-pg`;
const appName = `${id}-app`;
const results: { args: typeof args; image: string; steps: Step[] } = { args, image: "", steps: [] };
let load: Load | undefined;
let db: Postgres | undefined;
const cleanUp = async () => {
  load?.close();
  await db?.close().catch(() => undefined);
  if (!args.keep) await Promise.all([stop(appName), stop(pgName)]);
};
process.once("SIGINT", () => void cleanUp().then(() => process.exit(130)));

try {
  results.image = await docker("image", "inspect", "--format", '{{index .Config.Labels "org.opencontainers.image.revision"}} {{.Id}}', args.image).catch(() => {
    throw new Error(`no image ${args.image}: build it with \`pnpm build:image\`, or pass --image`);
  });
  console.log(`image ${args.image} (${results.image}); results in ${outDir}`);
  const databaseUrl = await startPostgres(pgName, { cpus: args["pg-cpus"], cpuset: args["pg-cpuset"], memory: args["pg-memory"] });
  db = new Postgres(databaseUrl);
  await db.init();
  const { url, setupCode } = await startApp(appName, {
    image: args.image,
    // The app reaches the database on the same host network.
    databaseUrl,
    limits: { cpus: args["app-cpus"], cpuset: args["app-cpuset"] },
    outDir,
    probe: join(here, "probe.ts"),
    cpuProfile: args["cpu-prof"],
  });
  console.log(`app at ${url}; setting up`);
  load = new Load(
    url,
    {
      users: num("users"),
      runners: num("runners"),
      schedules: num("schedules"),
      polls: num("polls"),
      pace: { rate: num("rate"), chars: num("chars"), turnChars: num("turn-chars") },
      think: num("think"),
      readEvery: num("read-every"),
    },
    rec,
  );
  await load.setUp(setupCode);

  console.log("chats  turns/s  deltas/s  updates/s  deliver p50/p95/p99 ms  rpc p50/p95/p99 ms  app cpu/elu/lag99  pg cpu  pg active  backlog  harness elu");
  for (const chats of steps) {
    await load.chatsUpTo(chats);
    await new Promise((resolve) => setTimeout(resolve, num("warmup") * 1000));

    rec.take();
    load.counts.clear();
    harnessSamples.length = 0;
    const started = Date.now();
    const busy0 = hostBusy();
    const load1Start = loadavg()[0]!;
    const [pgCpu0, appCpu0, commits0] = await Promise.all([containerCpu(pgName), containerCpu(appName), db.begin()]);
    const activity: Activity[] = [];
    const backlog: number[] = [];
    const ticker = setInterval(() => {
      backlog.push(load!.backlog());
      void db!.activity().then(
        (a) => activity.push(a),
        () => undefined,
      );
    }, 1000);
    await new Promise((resolve) => setTimeout(resolve, num("step") * 1000));
    clearInterval(ticker);
    const seconds = (Date.now() - started) / 1000;
    const [pgCpu1, appCpu1, commits1, top] = await Promise.all([containerCpu(pgName), containerCpu(appName), db.commits(), db.top()]);
    const busy1 = hostBusy();
    const probe = readFileSync(join(outDir, "probe.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Sample)
      .filter((s) => s.t >= started && s.t <= started + seconds * 1000);
    const waits: Record<string, number> = {};
    for (const a of activity) for (const [wait, n] of Object.entries(a.waits)) waits[wait] = (waits[wait] ?? 0) + n / activity.length;

    const step: Step = {
      chats,
      seconds,
      rates: Object.fromEntries([...load.counts].map(([name, n]) => [name, n / seconds])),
      latency: rec.take(),
      app: series(probe),
      appContainerCpu: (appCpu1 - appCpu0) / seconds,
      harness: series(harnessSamples),
      postgres: {
        cpu: (pgCpu1 - pgCpu0) / seconds,
        commitsPerSecond: (commits1 - commits0) / seconds,
        active: summarize(activity.map((a) => a.active)),
        idle: summarize(activity.map((a) => a.idle)),
        waits,
        top,
      },
      backlog: summarize(backlog),
      host: {
        load1Start,
        load1End: loadavg()[0]!,
        busyCores:
          ((busy1.total - busy0.total - (busy1.idle - busy0.idle)) / (busy1.total - busy0.total)) *
          (readFileSync("/proc/cpuinfo", "utf8").match(/^processor/gm)?.length ?? 1),
      },
    };
    results.steps.push(step);
    writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));

    const d = step.latency.delivery;
    const r = step.latency.rpc;
    const f = (n = 0, digits = 0) => n.toFixed(digits);
    console.log(
      [
        f(chats).padStart(5),
        f(step.rates.turns, 2).padStart(7),
        f(step.rates.deltas).padStart(8),
        f(step.rates["events message"]).padStart(9),
        `${f(d?.p50)}/${f(d?.p95)}/${f(d?.p99)}`.padStart(22),
        `${f(r?.p50)}/${f(r?.p95)}/${f(r?.p99)}`.padStart(18),
        `${f(step.app.cpu?.mean, 2)}/${f(step.app.elu?.mean, 2)}/${f(step.app.lagP99?.p95)}`.padStart(18),
        f(step.postgres.cpu, 2).padStart(6),
        f(step.postgres.active.mean, 1).padStart(9),
        f(step.backlog.max).padStart(8),
        f(step.harness.elu?.max, 2).padStart(11),
      ].join("  "),
    );
    if ((d?.p99 ?? 0) > num("max-p99")) {
      console.log(`delivery p99 above ${args["max-p99"]} ms: the ramp stops here`);
      break;
    }
  }
} finally {
  await cleanUp();
}
console.log(`results: ${join(outDir, "results.json")}${args["cpu-prof"] ? `; CPU profile in ${outDir} (pnpm bench:load:profile <file>)` : ""}`);
