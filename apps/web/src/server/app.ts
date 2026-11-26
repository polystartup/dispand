import { readFileSync } from "node:fs";
import {
  closeDb,
  createAuth,
  createDb,
  createEngine,
  createMcpConnector,
  createSecretBox,
  DataEvents,
  ensureAssistants,
  guardedFetch,
  inScope,
  InstalledTools,
  logError,
  ownAddresses,
  platformToolCaller,
  pollCaller,
  PushSender,
  pushVia,
  resealToolHeaders,
  RunnerHub,
  Scheduler,
  startTelemetry,
  stopTelemetry,
  sweepAttachments,
  sweepAudit,
  purgeArchivedPeople,
  syncPlatformSkills,
  SYSTEM,
  type Auth,
  type Db,
  type Engine,
  type PlaceGate,
  type SecretBox,
  type ToolConnector,
} from "@dispand/domain";
import type { BetterAuthRateLimitStorage } from "better-auth";
import { loadServerConfig, type ServerConfig } from "./config.ts";

export type App = {
  db: Db;
  /** Better Auth's tables: `db` itself unless the entry gave another login (`buildApp`'s `authDb`). */
  authDb: Db;
  auth: Auth;
  hub: RunnerHub;
  engine: Engine;
  dataEvents: DataEvents;
  secrets: SecretBox;
  tools: ToolConnector;
  setupCode: string;
  setup: boolean;
  filesDir: string;
  gitFileUrls: boolean;
  traceUrl?: string;
  /** The app's public URL: OAuth tools' callback and client metadata document are there. */
  appUrl: string;
  /** Fires schedules and polls (`engine/scheduler.ts`). */
  scheduler: Scheduler;
  /** Sends Web Push for new Inbox items (`push/sender.ts`). */
  push: PushSender;
};

const SWEEP_EVERY_MS = 3600_000;
/** The hour of the server's clock the purge runs at, once a day. */
const PURGE_HOUR = 3;

/** How long from `now` until the next `PURGE_HOUR`:00 of the server's clock. */
export function untilPurge(now: Date): number {
  const next = new Date(now);
  next.setHours(PURGE_HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/** What an entry may give `buildApp` in place of its defaults. */
export type BuildOptions = {
  /** Better Auth's tables on their own login; by default on `db`. */
  authDb?: Db;
  /** `false` turns off first-run setup: another flow creates the people. */
  setup?: boolean;
  /** Where sign-in throttling counts attempts, for processes that share them; by default Better Auth's memory store. */
  rateLimitStorage?: BetterAuthRateLimitStorage;
  /** Asked before the engine works on a step's place, for processes that share one database; by default nothing is asked. */
  gate?: PlaceGate;
};

const globalForApp = globalThis as { __dispandApp?: Promise<App>; __dispandBuilt?: Promise<App> };

/**
 * The app around an open, migrated database: auth, the runner hub, the engine, the scheduler and
 * the push sender, none of them started. `setup: false` turns off first-run setup (another flow creates the people). A database adapter may give Better Auth's tables their own
 * login (`authDb`); by default they are on `db`. Nothing here migrates, recovers or starts a timer.
 */
export function buildApp(db: Db, config: ServerConfig, options: BuildOptions = {}): App {
  const authDb = options.authDb ?? db;
  const auth = createAuth(authDb, { ...config, rateLimitStorage: options.rateLimitStorage });
  const hub = new RunnerHub(db);
  try {
    const manifest = JSON.parse(readFileSync(config.mode === "production" ? new URL("../../client/runner/build.json", import.meta.url) : "public/runner/build.json", "utf8")) as { buildId: string };
    hub.updates.buildId = manifest.buildId;
  } catch {
    // Development before the runner has been built: no downloadable update yet.
  }
  const secrets = createSecretBox(config.secretKey);
  const dataEvents = new DataEvents();
  // Tool calls never reach the app's own addresses in production; development reaches local fakes (e2e).
  // Their OAuth flows too (discovery, registration, token, refresh), through the same fetch.
  const tools = createMcpConnector({ ...(config.mode === "production" ? { fetch: guardedFetch(ownAddresses()) } : {}), appUrl: config.baseURL });
  // Tool steps call installed tools through the same connector as Settings → Tools. A cloud
  // Job's session gets Dispand's own tools, called in process (the app is read at call time).
  const app = {} as App;
  const engine = createEngine(db, hub, secrets, dataEvents, { connector: tools, tools: platformToolCaller(() => app), filesDir: config.filesDir, gate: options.gate });
  // Filled before anything can call a tool: recovery in `startApp` may already need it.
  return Object.assign(app, {
    db,
    authDb,
    auth,
    hub,
    engine,
    dataEvents,
    secrets,
    tools,
    setupCode: config.setupCode,
    setup: options.setup ?? true,
    filesDir: config.filesDir,
    gitFileUrls: config.gitFileUrls,
    traceUrl: config.traceUrl,
    appUrl: config.baseURL,
    // Polls call HTTP tools through the same connector, and runner tools through their runner.
    scheduler: new Scheduler(db, engine, { polls: pollCaller(new InstalledTools(db, secrets, tools), hub) }),
    // Never pushes to the app's own addresses in production (like tool calls). Push services take
    // only an https or mailto subject: a development app on http names none of its own.
    push: new PushSender(db, engine, secrets, {
      subject: config.baseURL.startsWith("https:") ? config.baseURL : "mailto:dispand@localhost",
      send: pushVia(config.mode === "production" ? guardedFetch(ownAddresses()) : fetch),
    }),
  });
}

/**
 * The app's background work, in this order. `getApp` runs it after `buildApp`. It spans every
 * workspace, so it runs under SYSTEM (timers started here inherit it).
 */
export function startApp(app: App): Promise<void> {
  return inScope(SYSTEM, () => startBackground(app));
}

async function startBackground(app: App): Promise<void> {
  const { db, secrets, engine, filesDir } = app;
  // Every owner's platform skill holds this build's files, and each Assistant gets what this
  // version adds to it, before anything starts one of its Jobs.
  await syncPlatformSkills(db);
  await ensureAssistants(db);
  // Headers sealed before they were bound to their tool's origin, sealed again before any tool call.
  await resealToolHeaders(db, secrets);
  // Settle overdue chats before recovery or a runner reconnect can restart their sessions.
  await engine.settleIdleChats();
  // Before any runner can connect (the upgrade handler waits for this app); cloud sessions go on.
  await engine.recover();
  // Fires what fell due while the app was down (once per schedule, for the latest time), then every 15 s.
  // Runs fired now start their sessions when their runner says hello (the engine's reconcile).
  app.scheduler.start();
  // Removes files no cell uses any more, and Audit rows past their retention: on boot, then hourly. The timer never keeps the process alive.
  const sweep = () => {
    void sweepAttachments(db, filesDir, new Date()).catch((err: unknown) => logError("files.sweep failed", err));
    void sweepAudit(db, new Date()).catch((err: unknown) => logError("audit.sweep failed", err));
  };
  sweep();
  setInterval(sweep, SWEEP_EVERY_MS).unref();
  // Deletes for good the people archived longer than their organization's retention: once a day,
  // at a fixed hour of the server's clock. The timers never keep the process alive.
  // Each run sets the next from the clock again, so the hour holds across a daylight saving change.
  const purge = () => {
    void purgeArchivedPeople(app, new Date()).catch((err: unknown) => logError("people.purge failed", err));
    setTimeout(purge, untilPurge(new Date())).unref();
  };
  setTimeout(purge, untilPurge(new Date())).unref();
  // Pushes what waited while the app was down, then each new Inbox item.
  app.push.start();
}

async function start(): Promise<App> {
  const config = loadServerConfig();
  // First: what starts below is traced. Logs go to the output; OTLP only where OTEL_EXPORTER_OTLP_* says.
  startTelemetry();
  // Built once per process: a retry after a failed start reruns only `startApp`, on the same engine,
  // so a cloud session the failed start's recovery took up never gets a second driver.
  const app = await (globalForApp.__dispandBuilt ??= createDb(config.databaseUrl)
    .then((db) => buildApp(db, config))
    .catch((error: unknown) => {
      delete globalForApp.__dispandBuilt;
      throw error;
    }));
  await startApp(app);
  return app;
}

/**
 * The app the routes and the runner hub use: the one `setApp` supplied, else this server's own,
 * opened, migrated and built once per process, then started. A failed start is retried on the next
 * call, on the same built app.
 */
export function getApp(): Promise<App> {
  return (globalForApp.__dispandApp ??= start().catch((error: unknown) => {
    delete globalForApp.__dispandApp;
    throw error;
  }));
}

/**
 * Supplies the app `getApp` gives, for an entry with its own database and startup (it builds the
 * app with `buildApp` and starts it with `startApp` or its own steps): call it before taking requests.
 */
export function setApp(app: App | Promise<App>): void {
  globalForApp.__dispandApp = Promise.resolve(app);
}

/** Closes the runners' WebSockets on shutdown, if the app was started; they would keep the process alive. */
export async function closeHub(): Promise<void> {
  const app = await globalForApp.__dispandApp?.catch(() => undefined);
  await app?.hub.close();
}

/** Closes the database if the app was started, so a stopped server exits at once. */
export async function closeApp(): Promise<void> {
  const app = await globalForApp.__dispandApp?.catch(() => undefined);
  if (!app) return;
  await app.push.stop();
  await app.scheduler.stop();
  await app.engine.stop();
  await closeDb(app.db);
  // What is still buffered goes before the process ends.
  await stopTelemetry();
}
