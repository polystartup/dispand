// Compiled, never run (`check.sh`): the packed declarations accept a server that supplies its own
// databases and skips first-run setup, and refuse a wrong argument.
import type { Db } from "@dispand/domain";
import { buildApp, closeApp, loadServerConfig, serve, setApp, startApp, type App, type ServerConfig } from "@dispand/web";

export async function typesOnly(db: Db, authDb: Db): Promise<void> {
  const config: ServerConfig = loadServerConfig();
  const app: App = await buildApp(db, config, { authDb, setup: false });
  await startApp(app);
  await setApp(app);
  const server = await serve(app, config);
  await server.close();
  await closeApp();

  // @ts-expect-error `setup` is a boolean
  await buildApp(db, config, { setup: "no" });
  // @ts-expect-error the first argument is a `Db`
  await buildApp("db", config);
}
