import { router, type InitialContext } from "@dispand/domain";
import { RPCHandler } from "@orpc/server/fetch";
import { SimpleCsrfProtectionHandlerPlugin } from "@orpc/server/plugins";

/**
 * Streams (`runs.stream`, `questions.stream`) send an SSE comment after this long without an
 * event, so no reverse proxy's read timeout cuts them. The oRPC client
 * ignores comments.
 */
export const STREAM_HEARTBEAT_MS = 25_000;

export function createRpcHandler(heartbeatMs = STREAM_HEARTBEAT_MS) {
  return new RPCHandler(router, {
    // Browsers cannot add the CSRF header to a cross-origin form or no-cors request.
    plugins: [new SimpleCsrfProtectionHandlerPlugin()],
    eventIteratorKeepAliveEnabled: true,
    eventIteratorKeepAliveInterval: heartbeatMs,
  });
}

const defaultHandler = createRpcHandler();

export async function handleRpc(
  request: Request,
  app: Omit<InitialContext, "headers" | "resHeaders">,
  handler = defaultHandler,
): Promise<Response> {
  const resHeaders = new Headers();
  const { response } = await handler.handle(request, {
    prefix: "/api/rpc",
    context: { ...app, headers: request.headers, resHeaders },
  });
  if (!response) return new Response("Not found", { status: 404 });
  for (const cookie of resHeaders.getSetCookie()) response.headers.append("set-cookie", cookie);
  // Streams reach the browser as they come, even through a proxy that buffers by default.
  if (response.headers.get("content-type")?.startsWith("text/event-stream")) response.headers.set("x-accel-buffering", "no");
  return response;
}
