// What the database did during a step: commits, connections by state and wait, and the statements
// that took the most time (`pg_stat_statements`, reset at each step).
import pg from "pg";

export type Statement = { query: string; calls: number; totalMs: number; meanMs: number };
export type Activity = { active: number; idle: number; waits: Record<string, number> };

export class Postgres {
  private readonly pool: pg.Pool;

  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 2, application_name: "dispand-bench" });
  }

  async init(): Promise<void> {
    await this.pool.query("create extension if not exists pg_stat_statements");
  }

  /** Starts a step: the statement counters from zero. Returns the commit count so far. */
  async begin(): Promise<number> {
    await this.pool.query("select pg_stat_statements_reset()");
    return this.commits();
  }

  async commits(): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>("select xact_commit as n from pg_stat_database where datname = current_database()");
    return Number(rows[0]?.n ?? 0);
  }

  /** The app's connections now (this sampler's own left out). */
  async activity(): Promise<Activity> {
    const { rows } = await this.pool.query<{ state: string | null; wait: string | null; n: number }>(
      `select state, wait_event_type || ':' || wait_event as wait, count(*)::int as n from pg_stat_activity
       where datname = current_database() and backend_type = 'client backend' and application_name <> 'dispand-bench'
       group by 1, 2`,
    );
    const out: Activity = { active: 0, idle: 0, waits: {} };
    for (const row of rows) {
      if (row.state === "active") {
        out.active += row.n;
        if (row.wait) out.waits[row.wait] = (out.waits[row.wait] ?? 0) + row.n;
      } else out.idle += row.n;
    }
    return out;
  }

  /** The statements that took the most time since `begin`. */
  async top(limit = 12): Promise<Statement[]> {
    const { rows } = await this.pool.query<{ query: string; calls: string; total: number; mean: number }>(
      `select query, calls, total_exec_time as total, mean_exec_time as mean from pg_stat_statements
       where dbid = (select oid from pg_database where datname = current_database())
       order by total_exec_time desc limit $1`,
      [limit],
    );
    return rows.map((r) => ({ query: r.query.replace(/\s+/g, " ").slice(0, 300), calls: Number(r.calls), totalMs: r.total, meanMs: r.mean }));
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}
