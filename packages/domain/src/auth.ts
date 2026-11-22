import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { z } from "zod";
import type { Db, Tx } from "./db/client.ts";
import * as schema from "./db/schema.ts";

export type AuthOptions = {
  /** Public URL of the app. */
  baseURL: string;
  secret: string;
  /** Throttle sign-in attempts (Better Auth only does by default when NODE_ENV is production). */
  rateLimit: boolean;
};

/**
 * Better Auth with email + password. Sign-up is disabled: the owner is created only
 * through the `auth.setup` procedure. Every option whose Better Auth default depends on
 * NODE_ENV is set here, so nothing about auth changes with the runtime environment.
 */
export function createAuth(db: Db, opts: AuthOptions) {
  return betterAuth({
    baseURL: opts.baseURL,
    secret: opts.secret,
    database: drizzleAdapter(db, { provider: "pg", schema }),
    // The page language the user chose; null (unset) follows the browser's. Better Auth doesn't
    // check an enum's values on its own: the validator does.
    user: { additionalFields: { language: { type: ["en", "fr"], required: false, input: true, validator: { input: z.enum(["en", "fr"]).nullable() } } } },
    emailAndPassword: { enabled: true, disableSignUp: true },
    rateLimit: { enabled: opts.rateLimit },
    trustedOrigins: [opts.baseURL],
    advanced: {
      useSecureCookies: opts.baseURL.startsWith("https://"),
      disableOriginCheck: false,
      // The reverse proxy in front of the app sets X-Real-IP to the peer it saw; read nothing
      // else for the rate-limit identity.
      ipAddress: { ipAddressHeaders: ["x-real-ip"] },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * Creates an identity in Better Auth's tables on `authDb`, then the domain rows on `db`. On the
 * same database (self-hosted) both run in one transaction. A database adapter may serve Better
 * Auth's tables through another login: the identity then commits first, in its own transaction,
 * and a failure after it leaves an identity with no membership, which grants nothing.
 */
export async function withIdentity<T>(
  { db, authDb }: { db: Db; authDb: Db },
  identity: (authTx: Tx) => Promise<void>,
  domain: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (authDb === db) {
    return db.transaction(async (tx) => {
      await identity(tx);
      return domain(tx);
    });
  }
  await authDb.transaction(identity);
  return db.transaction(domain);
}
