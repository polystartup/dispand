import { createRouter } from "@tanstack/react-router";
import { routeStates } from "./components/shell/RouteStates.tsx";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({ routeTree, scrollRestoration: true, ...routeStates });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
