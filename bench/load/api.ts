// Dispand's API as a signed-in browser calls it: the typed oRPC client (`apps/web/src/lib/api.ts`)
// with a person's session cookie, every call timed by procedure.
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { SimpleCsrfProtectionLinkPlugin } from "@orpc/client/plugins";
import type { RouterClient } from "@orpc/server";
import type { Router } from "@dispand/domain";

export type Api = RouterClient<Router>;

/** Records how long each call took (a stream: until it opened), by procedure path, and whether it failed. */
export type Timing = (procedure: string, ms: number, ok: boolean) => void;

export type Person = { email: string; password: string; ip: string };

/**
 * A client for `base` with `cookie` (empty before sign-in). `ip` goes in `X-Real-IP`, the one
 * client-address header the app reads: each simulated person gets their own, as people behind a
 * reverse proxy do, so the sign-in throttle counts them apart.
 */
export function client(base: string, ip: string, cookie = "", timing?: Timing): Api {
  const link = new RPCLink({
    url: `${base}/api/rpc`,
    headers: { origin: base, "x-real-ip": ip, ...(cookie ? { cookie } : {}) },
    plugins: [new SimpleCsrfProtectionLinkPlugin()],
    interceptors: [
      async ({ next, path }) => {
        const begun = performance.now();
        let ok = false;
        try {
          const out = await next();
          ok = true;
          return out;
        } finally {
          timing?.(path.join("/"), performance.now() - begun, ok);
        }
      },
    ],
  });
  return createORPCClient(link);
}

/** Signs `person` in with Better Auth's email route, as the login page does. Returns the session cookie. */
export async function signIn(base: string, person: Person): Promise<string> {
  const res = await fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base, "x-real-ip": person.ip },
    body: JSON.stringify({ email: person.email, password: person.password }),
  });
  if (!res.ok) throw new Error(`sign-in failed for ${person.email}: HTTP ${res.status}`);
  return res.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

/** The n-th simulated person's address, in the range set aside for benchmarks (198.18.0.0/15). */
export const benchIp = (n: number) => `198.18.${Math.floor(n / 250)}.${(n % 250) + 1}`;
