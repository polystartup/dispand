import { pingDb, STALE_TICK_MS, type Db, type Scheduler } from "@dispand/domain";

/**
 * The readiness probe (`GET /api/health`): 200 once the app started (database opened, migrations
 * applied), the database answers and, in a process that runs the scheduler, a tick completed in
 * the last 5 minutes; 503 otherwise. The body says how long ago that tick was, in whole seconds,
 * and nothing of an error.
 */
export async function handleHealth(getApp: () => Promise<{ db: Db; scheduler: Pick<Scheduler, "sinceTick"> }>): Promise<Response> {
  const headers = { "content-type": "text/plain", "cache-control": "no-store" };
  let since: number | undefined;
  try {
    const app = await getApp();
    await pingDb(app.db);
    since = app.scheduler.sinceTick();
  } catch {
    return new Response("unavailable", { status: 503, headers });
  }
  if (since === undefined) return new Response("ok", { status: 200, headers });
  const tick = `last scheduler tick ${Math.floor(since / 1000)} s ago`;
  return since > STALE_TICK_MS ? new Response(`stale: ${tick}`, { status: 503, headers }) : new Response(`ok: ${tick}`, { status: 200, headers });
}
