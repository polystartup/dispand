// Pure: what an agent's Jobs may do, for the schema, the procedures and the web app.

/** `data` works on rows, `configure` changes tables and fields. */
export const BUNDLES = ["data", "configure"] as const;
export type Bundle = (typeof BUNDLES)[number];

/** The tables a Job may work on: all of the owner's, or these. */
export type TableScope = "all" | string[];
