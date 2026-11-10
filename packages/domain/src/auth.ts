import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Db } from "./db/client.ts";
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
