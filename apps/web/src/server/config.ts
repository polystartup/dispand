import { resolve } from "node:path";

/**
 * The only place the server reads `process.env`. The mode comes from the build
 * (`import.meta.env.PROD`), never from a runtime variable: a production bundle always behaves
 * as production, whatever NODE_ENV says. Everything below the config is passed explicitly.
 */
export type ServerConfig = {
  mode: "production" | "development";
  databaseUrl: string;
  /** Public URL of the app. */
  baseURL: string;
  secret: string;
  /** One-time code the first-run `auth.setup` call must present (min 16 characters). */
  setupCode: string;
  /** Throttle sign-in attempts. On in production; off in development so e2e runs are not throttled. */
  rateLimit: boolean;
  /** 32 bytes from `DISPAND_SECRET_KEY` (base64): seals API keys and tool headers at rest. */
  secretKey: Buffer;
  /** Where the production entry (`server.ts`) listens; Vite's dev server has its own. */
  port: number;
  host?: string;
  /** Where attachment files are stored (`DISPAND_FILES_DIR`); `.data/files` in development. */
  filesDir: string;
  /** Development only: `DISPAND_GIT_FILE_URLS=1` lets marketplaces be `file://` Git URLs (e2e fixtures). */
  gitFileUrls: boolean;
  /** Where a trace is opened (`DISPAND_TRACE_URL`, an http(s) URL with `{traceId}`): the Audit page links there. */
  traceUrl?: string;
};

const devDefaults = {
  baseURL: "http://localhost:3000",
  secret: "dev-only-secret-change-me-0123456789",
  setupCode: "dev-setup-code-0123456789",
  secretKey: "ZGV2LW9ubHktc2VjcmV0LWtleS0wMTIzNDU2Nzg5YWI=",
};

export function loadServerConfig(
  env: Record<string, string | undefined> = process.env,
  mode: ServerConfig["mode"] = import.meta.env.PROD ? "production" : "development",
): ServerConfig {
  const production = mode === "production";
  const settings = {
    DATABASE_URL: env.DATABASE_URL,
    BETTER_AUTH_URL: env.BETTER_AUTH_URL ?? (production ? undefined : devDefaults.baseURL),
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET ?? (production ? undefined : devDefaults.secret),
    DISPAND_SETUP_CODE: env.DISPAND_SETUP_CODE ?? (production ? undefined : devDefaults.setupCode),
    DISPAND_SECRET_KEY: env.DISPAND_SECRET_KEY ?? (production ? undefined : devDefaults.secretKey),
    DISPAND_FILES_DIR: env.DISPAND_FILES_DIR ?? (production ? undefined : resolve(".data/files")),
  };
  const missing = Object.entries(settings).filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`Missing settings: ${missing.join(", ")}`);
  if (settings.DISPAND_SETUP_CODE!.length < 16) throw new Error("DISPAND_SETUP_CODE must be at least 16 characters");
  // Strict base64 of exactly 32 bytes, as `openssl rand -base64 32` prints it.
  if (!/^[A-Za-z0-9+/]{43}=$/.test(settings.DISPAND_SECRET_KEY!.trim())) {
    throw new Error("DISPAND_SECRET_KEY must be 32 bytes, base64");
  }
  const traceUrl = env.DISPAND_TRACE_URL?.trim() || undefined;
  if (traceUrl && (!/^https?:\/\//.test(traceUrl) || !traceUrl.includes("{traceId}") || !URL.canParse(traceUrl.replaceAll("{traceId}", "0")))) {
    throw new Error("DISPAND_TRACE_URL must be an http(s) URL with {traceId} in it");
  }
  return {
    mode,
    databaseUrl: settings.DATABASE_URL!,
    baseURL: settings.BETTER_AUTH_URL!,
    secret: settings.BETTER_AUTH_SECRET!,
    setupCode: settings.DISPAND_SETUP_CODE!,
    rateLimit: production,
    secretKey: Buffer.from(settings.DISPAND_SECRET_KEY!.trim(), "base64"),
    port: Number(env.PORT ?? 3000),
    host: env.HOST,
    filesDir: settings.DISPAND_FILES_DIR!,
    gitFileUrls: !production && env.DISPAND_GIT_FILE_URLS === "1",
    ...(traceUrl ? { traceUrl } : {}),
  };
}
