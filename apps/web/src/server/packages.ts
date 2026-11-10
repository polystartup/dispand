import { findRunnerByToken, packageForRunner, type Db } from "@dispand/domain";

/**
 * `GET /runner/packages/<id>` with `Authorization: Bearer <runner token>`: a skill package for a
 * session the runner starts (`packageForRunner` decides which). 401 without a live runner's
 * token; 404 for any package that runner may not have.
 */
export async function handlePackage(request: Request, db: Db, packageId: string): Promise<Response> {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const runner = token && token.length <= 256 ? await findRunnerByToken(db, token) : null;
  if (!runner) return Response.json({ error: "Unknown runner" }, { status: 401 });
  const pkg = packageId.length <= 200 ? await packageForRunner(db, runner.id, packageId) : null;
  if (!pkg) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(pkg, { headers: { "cache-control": "no-store" } });
}
