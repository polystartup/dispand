import { findRunnerByToken, pluginForRunner, type Db } from "@dispand/domain";

/**
 * `GET /runner/plugins/<tool id>` with `Authorization: Bearer <runner token>`: the plugin's name,
 * its stdio server's launch entry and its files, for a plugin runner tool on that runner only
 * (`pluginForRunner`). 401 without a live runner's token; 404 for any other tool. The runner
 * recomputes their digest and starts nothing its own record doesn't allow.
 */
export async function handlePlugin(request: Request, db: Db, toolId: string): Promise<Response> {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const runner = token && token.length <= 256 ? await findRunnerByToken(db, token) : null;
  if (!runner) return Response.json({ error: "Unknown runner" }, { status: 401 });
  const plugin = toolId.length <= 200 ? await pluginForRunner(db, runner.id, toolId) : null;
  if (!plugin) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(plugin, { headers: { "cache-control": "no-store" } });
}
