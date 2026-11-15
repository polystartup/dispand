import { getRequestHeaders, setResponseHeader } from "@tanstack/react-start/server";
import { resolveLanguage } from "../lib/i18n.ts";

/**
 * Setup and session state, used by the route guards (on the server and on navigation), and the
 * page's language: the user's saved one, else the browser's (`Accept-Language`).
 */
export async function authState() {
  const { getApp } = await import("./app.ts");
  const app = await getApp();
  const { auth } = app;
  const { router } = await import("@dispand/domain");
  const { call } = await import("@orpc/server");
  const headers = new Headers(getRequestHeaders());
  const { needsSetup } = await call(router.auth.status, undefined, {
    context: { ...app, headers, resHeaders: new Headers() },
    // Its name, for its span: a call in process has no path of its own.
    path: ["auth", "status"],
  });
  const acceptLanguage = headers.get("accept-language");
  if (needsSetup) return { needsSetup, user: null, language: resolveLanguage(null, acceptLanguage) };
  const { headers: fresh, response: session } = await auth.api.getSession({ headers, returnHeaders: true });
  // A refreshed session cookie has to reach the browser.
  const cookies = fresh.getSetCookie();
  if (cookies.length) setResponseHeader("set-cookie", cookies);
  const language = session?.user.language ?? null;
  return {
    needsSetup,
    user: session ? { name: session.user.name, email: session.user.email, language } : null,
    language: resolveLanguage(language, acceptLanguage),
  };
}

/** First launch, before the owner's Assistant is made: Home's guard sends the owner to its page. */
export async function firstLaunch() {
  const { getApp } = await import("./app.ts");
  const app = await getApp();
  const { router } = await import("@dispand/domain");
  const { call } = await import("@orpc/server");
  const { assistant } = await call(router.onboarding.status, undefined, {
    context: { ...app, headers: new Headers(getRequestHeaders()), resHeaders: new Headers() },
    path: ["onboarding", "status"],
  });
  return assistant === null;
}
