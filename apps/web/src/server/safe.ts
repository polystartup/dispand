import { isNotFound, isRedirect } from "@tanstack/react-router";
import { ORPCError } from "@orpc/server";

/**
 * Every `createServerFn` handler goes through this (`safe.test.ts` enforces it). Expected
 * outcomes pass through: redirects, not-found, and API errors with a client-facing status.
 * Anything else is logged here, with its stack, and replaced by a generic error, so
 * internals (SQL, paths, hosts) never reach the HTML or the client.
 */
export function safe<Args extends unknown[], Result>(
  handler: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (isRedirect(error) || isNotFound(error)) throw error;
      if (error instanceof ORPCError && error.status < 500) throw error;
      console.error("Server function failed:", error instanceof Error ? (error.stack ?? error.message) : String(error));
      // No `cause`: it could be serialized to the client along with the error.
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Something went wrong");
    }
  };
}
