import { pingDb, type Db } from "@dispand/domain";

/**
 * The readiness probe (`GET /api/health`): 200 once the app started (database opened, migrations
 * applied) and the database answers, 503 otherwise. It says nothing more, failure or not.
 */
export async function handleHealth(getApp: () => Promise<{ db: Db }>): Promise<Response> {
  const headers = { "content-type": "text/plain", "cache-control": "no-store" };
  try {
    await pingDb((await getApp()).db);
    return new Response("ok", { status: 200, headers });
  } catch {
    return new Response("unavailable", { status: 503, headers });
  }
}
