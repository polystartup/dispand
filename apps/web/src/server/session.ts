import { createServerFn } from "@tanstack/react-start";
import { safe } from "./safe.ts";

// The logic lives in auth-state.ts (server only), loaded inside the handler so the client bundle never sees it.
export const getAuthState = createServerFn({ method: "GET" }).handler(
  safe(async () => (await import("./auth-state.ts")).authState()),
);

export const getFirstLaunch = createServerFn({ method: "GET" }).handler(
  safe(async () => (await import("./auth-state.ts")).firstLaunch()),
);
