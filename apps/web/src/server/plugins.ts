import { findRunnerByToken, inScope, nativePluginForRunner, pluginForRunner, type Db } from "@dispand/domain";

/**
 * `GET /runner/plugins/<tool id>` with `Authorization: Bearer <runner token>`: the plugin's name,
 * its stdio server's launch entry and its files, for a plugin runner tool on that runner only
 * (`pluginForRunner`). 401 without a live runner's token; 404 for any other tool. The runner
 * recomputes their digest and starts nothing its own record doesn't allow.
 */
/** The live runner the request's `Authorization: Bearer <runner token>` names, or null. */
async function runnerOf(request: Request, db: Db) {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return token && token.length <= 256 ? await findRunnerByToken(db, token) : null;
}

export async function handlePlugin(request: Request, db: Db, toolId: string): Promise<Response> {
  const runner = await runnerOf(request, db);
  if (!runner) return Response.json({ error: "Unknown runner" }, { status: 401 });
  const plugin = toolId.length <= 200 ? await inScope(runner.scope, () => pluginForRunner(db, runner.id, toolId)) : null;
  if (!plugin) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(plugin, { headers: { "cache-control": "no-store" } });
}

/**
 * `GET /runner/native-plugins/<plugin id>?digest=<digest>` with a runner's token: the plugin's
 * files at that native revision, for a runner one of whose agents holds a grant for it, while it
 * is still the pinned one (`nativePluginForRunner`). 401 without a live runner's token; 404
 * otherwise. The runner recomputes the digest and keeps nothing that doesn't match.
 */
export async function handleNativePlugin(request: Request, db: Db, pluginId: string): Promise<Response> {
  const runner = await runnerOf(request, db);
  if (!runner) return Response.json({ error: "Unknown runner" }, { status: 401 });
  const digest = new URL(request.url).searchParams.get("digest") ?? "";
  const ok = /^[A-Za-z0-9_-]{1,64}$/.test(pluginId) && /^sha256:[0-9a-f]{64}$/.test(digest);
  const plugin = ok ? await inScope(runner.scope, () => nativePluginForRunner(db, runner.id, pluginId, digest)) : null;
  if (!plugin) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(plugin, { headers: { "cache-control": "no-store" } });
}
