// Production entry: `pnpm build`, then `node server.ts`. Serves the built app (see `serve`) with
// its own database, opened from the settings on first use.
import type * as Built from "./src/server.ts";

const { loadServerConfig, serve } = (await import(new URL("./dist/server/server.js", import.meta.url).href)) as typeof Built;

// Fails fast on missing settings, before listening.
await serve(undefined, loadServerConfig());
