import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { SimpleCsrfProtectionLinkPlugin } from "@orpc/client/plugins";
import type { RouterClient } from "@orpc/server";
import type { Router } from "@dispand/domain";

/** Typed client of the oRPC API. Browser only: procedures are called from event handlers. */
export const api: RouterClient<Router> = createORPCClient(
  new RPCLink({
    url: () => `${window.location.origin}/api/rpc`,
    plugins: [new SimpleCsrfProtectionLinkPlugin()],
  }),
);

/** Query options and mutation options for the same API, for TanStack Query. */
export const orpc = createTanstackQueryUtils(api);
