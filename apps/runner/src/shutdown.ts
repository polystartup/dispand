import type { Connection } from "./connection.ts";
import type { Sessions } from "./sessions.ts";

/**
 * Stops the runner cleanly (SIGTERM, SIGINT), within `timeoutMs`: no new session starts, every
 * live CLI is aborted without an error event (Dispand resumes sessions that aren't live
 * after the runner reconnects), and the connection is closed, which writes the pending text
 * delta to the backlog and syncs it. Resume mappings and run folders stay.
 */
export async function shutdown(sessions: Sessions, conn: Connection, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([sessions.shutdown(), new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
  } finally {
    clearTimeout(timer);
    conn.close();
  }
}
