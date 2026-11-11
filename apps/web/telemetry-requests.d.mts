/** Whether an incoming request (`url`: its path and query) makes no span. */
export function ignoredIncoming(url: string | undefined): boolean;
/** Whether an outgoing request (to `host`:`port`) makes no span: telemetry's own exports. */
export function ignoredOutgoing(host: string | undefined, port: string | number | undefined, env?: Record<string, string | undefined>): boolean;
