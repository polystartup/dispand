import { getRequestHeaders, setResponseHeader } from "@tanstack/react-start/server";

/** Setup and session state, used by the route guards (on the server and on navigation). */
export async function authState() {
  const { getApp } = await import("./app.ts");
  const app = await getApp();
  const { auth } = app;
  const { router } = await import("@dispand/domain");
  const { call } = await import("@orpc/server");
  const headers = new Headers(getRequestHeaders());
  const { needsSetup } = await call(router.auth.status, undefined, {
    context: { ...app, headers, resHeaders: new Headers() },
  });
  if (needsSetup) return { needsSetup, user: null };
  const { headers: fresh, response: session } = await auth.api.getSession({ headers, returnHeaders: true });
  // A refreshed session cookie has to reach the browser.
  const cookies = fresh.getSetCookie();
  if (cookies.length) setResponseHeader("set-cookie", cookies);
  return { needsSetup, user: session ? { name: session.user.name, email: session.user.email } : null };
  }
