import { fileURLToPath } from "node:url";
import {
  closeDb,
  createAuth,
  createDb,
  createMcpConnector,
  createSecretBox,
  ensureAssistants,
  getDataEvents,
  getEngine,
  getHub,
  guardedFetch,
  getScheduler,
  InstalledTools,
  logError,
  ownAddresses,
  platformToolCaller,
  pollCaller,
  startTelemetry,
  stopTelemetry,
  sweepAttachments,
  sweepAudit,
  syncPlatformSkills,
  type Auth,
  type DataEvents,
  type Db,
  type Engine,
  type RunnerHub,
  type SecretBox,
  type ToolConnector,
} from "@dispand/domain";
import { loadServerConfig } from "./config.ts";

type App = {
  db: Db;
  auth: Auth;
  hub: RunnerHub;
  engine: Engine;
  dataEvents: DataEvents;
  secrets: SecretBox;
  tools: ToolConnector;
  setupCode: string;
  filesDir: string;
  gitFileUrls: boolean;
  traceUrl?: string;
  /** The app's public URL: OAuth tools' callback and client metadata document are there. */
  appUrl: string;
};

const SWEEP_EVERY_MS = 3600_000;

const globalForApp = globalThis as { __dispandApp?: Promise<App> };

async function start(): Promise<App> {
  const config = loadServerConfig();
  // First: what starts below is traced. Logs go to the output; OTLP only where OTEL_EXPORTER_OTLP_* says.
  startTelemetry();
  // The production build copies the migrations next to the server bundle (see vite.config.ts).
  const migrations = config.mode === "production" ? fileURLToPath(new URL("../drizzle", import.meta.url)) : undefined;
  const db = await createDb(config.databaseUrl, migrations);
  const auth = createAuth(db, config);
  const hub = getHub(db);
  const secrets = createSecretBox(config.secretKey);
  const dataEvents = getDataEvents();
  // Tool calls never reach the app's own addresses in production; development reaches local fakes (e2e).
  // Their OAuth flows too (discovery, registration, token, refresh), through the same fetch.
  const tools = createMcpConnector({ ...(config.mode === "production" ? { fetch: guardedFetch(ownAddresses()) } : {}), appUrl: config.baseURL });
  // Tool steps call installed tools through the same connector as Settings → Tools. A cloud
  // Job's session gets Dispand's own tools, called in process (the app is read at call time).
  const app = {} as App;
  const engine = getEngine(db, hub, secrets, dataEvents, { connector: tools, tools: platformToolCaller(() => app), filesDir: config.filesDir });
  // Filled before anything can call a tool: recovery below may already need it.
  Object.assign(app, { db, auth, hub, engine, dataEvents, secrets, tools, setupCode: config.setupCode, filesDir: config.filesDir, gitFileUrls: config.gitFileUrls, traceUrl: config.traceUrl, appUrl: config.baseURL });
  // Every owner's platform skill holds this build's files, and each Assistant gets what this
  // version adds to it, before anything starts one of its Jobs.
  await syncPlatformSkills(db);
  await ensureAssistants(db);
  // Before any runner can connect (the upgrade handler waits for this app); cloud sessions go on.
  await engine.recover();
  // Fires what fell due while the app was down (once per schedule, for the latest time), then every 15 s.
  // Runs fired now start their sessions when their runner says hello (the engine's reconcile).
  // Polls call HTTP tools through the same connector, and runner tools through their runner.
  getScheduler(db, engine, pollCaller(new InstalledTools(db, secrets, tools), hub)).start();
  // Removes files no cell uses any more, and Audit rows past their retention: on boot, then hourly. The timer never keeps the process alive.
  const sweep = () => {
    void sweepAttachments(db, config.filesDir, new Date()).catch((err: unknown) => logError("files.sweep failed", err));
    void sweepAudit(db, new Date()).catch((err: unknown) => logError("audit.sweep failed", err));
  };
  sweep();
  setInterval(sweep, SWEEP_EVERY_MS).unref();
  return app;
}

/** The database and auth, opened once per server process. A failed start is retried on the next call. */
export function getApp(): Promise<App> {
  return (globalForApp.__dispandApp ??= start().catch((error: unknown) => {
    delete globalForApp.__dispandApp;
    throw error;
  }));
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
  await getScheduler(app.db, app.engine).stop();
  await app.engine.stop();
  await closeDb(app.db);
  // What is still buffered goes before the process ends.
  await stopTelemetry();
}
