// Pure: what an agent's Jobs may do, for the schema, the procedures and the web app.

/**
 * `data` works on rows, `configure` changes tables and fields, `inbox` is started by and works
 * on other agents' Questions, within its tables (`questions/inbox-scope.ts`).
 */
export const BUNDLES = ["data", "configure", "inbox"] as const;
export type Bundle = (typeof BUNDLES)[number];

/** The tables a Job may work on: all of the owner's, or these. */
export type TableScope = "all" | string[];
