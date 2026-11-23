// An entry built on the packed packages, as another server would build one: its own pool and
// database, then the app and `serve`. Run by `check.sh` from a project outside the repository.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { currentScope, migrateDb, openDb } from "@dispand/domain";
import { buildApp, closeApp, loadServerConfig, serve, startApp } from "@dispand/web";
import pg from "pg";

const config = loadServerConfig();
const db = await openDb(new pg.Pool({ connectionString: config.databaseUrl }));
await migrateDb(db);
const app = await buildApp(db, config);
await startApp(app);
const server = await serve(app, config);

const base = config.baseURL;
const expect = (ok: boolean, what: string) => {
  if (!ok) throw new Error(`package check failed: ${what}`);
  console.log(`ok - ${what}`);
};
const rpc = (path: string, input: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/rpc/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": "orpc", ...headers }, body: JSON.stringify({ json: input }) });

// The web bundle imports the domain package this entry imports: one module, so one scope.
const webDomain = createRequire(createRequire(import.meta.url).resolve("@dispand/web")).resolve("@dispand/domain");
expect((await import(pathToFileURL(webDomain).href)).currentScope === currentScope, "currentScope is the same function in both imports");

expect((await (await rpc("auth/status", {})).json()).json.needsSetup === true, "auth.status before setup");
const owner = { name: "Ada", email: "ada@example.com", password: "correct horse battery", setupCode: process.env.DISPAND_SETUP_CODE };
expect((await rpc("auth/setup", owner)).ok, "auth.setup");
const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: base },
  body: JSON.stringify({ email: owner.email, password: owner.password }),
});
expect(signIn.ok, "signs in");
const cookie = signIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
expect((await (await rpc("auth/status", {}, { cookie })).json()).json.needsSetup === false, "auth.status after setup");
expect((await rpc("auth/me", {}, { cookie })).ok, "auth.me with the session");

const home = await fetch(`${base}/`, { headers: { cookie } });
expect(home.ok && (await home.text()).includes("<html"), "serves /");
const asset = (await (await fetch(`${base}/`)).text()).match(/\/assets\/[^"]+\.js/)?.[0];
expect(!!asset && (await fetch(`${base}${asset}`)).ok, "serves the client files");
const big = await fetch(`${base}/api/rpc/auth/status`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(2 * 1024 * 1024) });
expect(big.status === 413, "refuses a body over its path's cap");

await server.close(true);
await closeApp();
process.exit(0);
