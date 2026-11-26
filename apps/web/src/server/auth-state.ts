import { getRequestHeaders, setResponseHeader } from "@tanstack/react-start/server";
import { resolveLanguage } from "../lib/i18n.ts";
import { organizationRefusalOf } from "../lib/organization-refusal.ts";

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
  const { needsSetup, enrollsAccounts } = await call(router.auth.status, undefined, {
    context: { ...app, headers, resHeaders: new Headers() },
    // Its name, for its span: a call in process has no path of its own.
    path: ["auth", "status"],
  });
  const acceptLanguage = headers.get("accept-language");
  if (needsSetup) return { needsSetup, enrollsAccounts, user: null, workspaces: [], language: resolveLanguage(null, acceptLanguage) };
  const { headers: fresh, response: session } = await auth.api.getSession({ headers, returnHeaders: true });
  // A refreshed session cookie has to reach the browser.
  const cookies = fresh.getSetCookie();
  if (cookies.length) setResponseHeader("set-cookie", cookies);
  const language = session?.user.language ?? null;
  // Read on every navigation, so a workspace the person joined or left shows up on the next one.
  const workspaces = session
    ? await call(router.workspace.mine, undefined, { context: { ...app, headers, resHeaders: new Headers() }, path: ["workspace", "mine"] })
    : [];
  return {
    needsSetup,
    enrollsAccounts,
    user: session ? { name: session.user.name, email: session.user.email, language } : null,
    workspaces,
    language: resolveLanguage(language, acceptLanguage),
  };
}

/** The request's headers naming `place`, as the page's calls do; none names the person's only workspace. */
function placed(headers: Headers, place: { organizationId: string; workspaceId: string } | null) {
  if (place) {
    headers.set("dispand-organization", place.organizationId);
    headers.set("dispand-workspace", place.workspaceId);
  }
  return headers;
}

/** First launch, before the owner's Assistant is made: Home's guard sends the owner to its page. */
export async function firstLaunch(place: { organizationId: string; workspaceId: string } | null = null) {
  const { getApp } = await import("./app.ts");
  const app = await getApp();
  const { router } = await import("@dispand/domain");
  const { call } = await import("@orpc/server");
  try {
    const { assistant } = await call(router.onboarding.status, undefined, {
      context: { ...app, headers: placed(new Headers(getRequestHeaders()), place), resHeaders: new Headers() },
      path: ["onboarding", "status"],
    });
    return assistant === null;
  } catch (error) {
    // A refused organization isn't a first launch: Home renders, and its first calls show the refusal's page.
    if (organizationRefusalOf(error)) return false;
    throw error;
  }
}
