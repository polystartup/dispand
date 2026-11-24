// How `dispand-runner enroll` reaches the running supervisor, which alone holds the connection to
// Dispand (a second one would replace it): a unix socket in the supervisor-only folder (0700),
// one JSON line each way.
import { chmod, mkdir, rm } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { join } from "node:path";
import { subscriptionsDir } from "./supervisor.ts";

export type Ask = { harness: string; challenge: string };
export type Answer = { ok: boolean; message: string };

export function controlSocket(configDir: string): string {
  return join(subscriptionsDir(configDir), "control.sock");
}

/** Serves enrollment asks on `path`; only the runner's own user can open its folder. */
export async function serveControl(path: string, handle: (ask: Ask) => Promise<Answer>): Promise<Server> {
  const dir = join(path, "..");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  // A socket a previous run left.
  await rm(path, { force: true });
  const server = createServer((socket) => {
    let line = "";
    socket.setEncoding("utf8").on("error", () => {});
    const read = (data: string) => {
      line += data;
      if (line.length > 4096) return void socket.destroy();
      const end = line.indexOf("\n");
      if (end < 0) return;
      socket.off("data", read);
      let ask: Ask;
      try {
        const raw = JSON.parse(line.slice(0, end)) as Partial<Ask>;
        ask = { harness: String(raw.harness), challenge: String(raw.challenge) };
      } catch {
        return void socket.destroy();
      }
      void handle(ask).then((answer) => socket.end(`${JSON.stringify(answer)}\n`), () => socket.destroy());
    };
    socket.on("data", read);
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(path, resolve));
  await chmod(path, 0o600);
  return server;
}

/** Sends one ask to the running supervisor and returns its answer. */
export function askControl(path: string, ask: Ask): Promise<Answer> {
  return new Promise((resolve, reject) => {
    let reply = "";
    const socket = createConnection(path);
    socket.setEncoding("utf8")
      .on("data", (data: string) => (reply += data))
      .on("end", () => {
        try {
          resolve(JSON.parse(reply) as Answer);
        } catch {
          reject(new Error("the runner gave no answer"));
        }
      })
      .on("error", reject);
    socket.write(`${JSON.stringify(ask)}\n`);
  });
}
