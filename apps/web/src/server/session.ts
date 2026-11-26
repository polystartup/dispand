import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { safe } from "./safe.ts";

// The logic lives in auth-state.ts (server only), loaded inside the handler so the client bundle never sees it.
export const getAuthState = createServerFn({ method: "GET" }).handler(
  safe(async () => (await import("./auth-state.ts")).authState()),
);

// The tab's workspace, when named: a server function's request carries no workspace headers.
// Ids as the page sends them in its calls' headers: visible ASCII, never a line break.
const id = z.string().regex(/^[\x21-\x7e]+$/);
const place = z.object({ organizationId: id, workspaceId: id }).nullable();

export const getFirstLaunch = createServerFn({ method: "GET" })
  .validator(place)
  .handler(safe(async ({ data }) => (await import("./auth-state.ts")).firstLaunch(data)));
