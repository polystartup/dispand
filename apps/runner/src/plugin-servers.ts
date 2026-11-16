import { randomUUID } from "node:crypto";
import { constants, realpathSync, statSync } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isSafeRelativePath } from "@dispand/runner-protocol";
import { inside, realOf } from "./boundary.ts";
import { PLUGIN_NAME, type RunnerConfig } from "./config.ts";
import { canonicalEntry, contentDigest, type PluginEntry } from "./plugin-digest.ts";
import { unlock } from "./skills.ts";

/**
 * A plugin's stdio server, run only when this machine's own record (`allowedPlugins`) holds the
 * digest the runner computes over the files it was given and the exact launch entry. Whatever
 * the server sends is checked here; nothing it labels is taken on trust.
 */

/** What the runner starts: every path real and inside the plugin root or its data folder. */
export type Launch = { command: string; args: string[]; env: Record<string, string>; cwd: string };

/** Why a plugin's server doesn't start: a whole sentence, naming only the plugin and digests. */
export class PluginRefused extends Error {
  override name = "PluginRefused";
}

/** As a skill package's caps (`skills.ts`). */
const MAX_FILES = 500;
const MAX_BYTES = 16 * 1024 * 1024;

function refuse(reason: string): never {
  console.error(`dispand-runner: ${reason}`);
  throw new PluginRefused(reason);
}

/** Refuses (`PluginRefused`) a name or file set this runner never materializes: `allow-plugin` checks it too, so no record is written for one. */
export function checkPluginFiles(name: string, files: { path: string; content: Buffer }[]): void {
  if (name.length > 64 || !PLUGIN_NAME.test(name)) refuse(`The plugin name ${JSON.stringify(name)} can't be used on this runner.`);
  if (files.length > MAX_FILES || files.reduce((n, f) => n + f.content.length, 0) > MAX_BYTES) refuse(`The plugin ${name} is too large for this runner.`);
  const paths = new Set<string>();
  for (const file of files) {
    if (!isSafeRelativePath(file.path) || paths.has(file.path)) refuse(`The plugin ${name} holds an unsafe or repeated path.`);
    paths.add(file.path);
  }
}

/**
 * Writes `files` read-only under `<stateDir>/plugins/<name>/<hex digest>/`, outside every root and
 * the machine's config, and returns that folder. The folder is named by the digest of what is
 * written, into a temporary sibling renamed into place, so an existing one is complete and reused.
 * shortcut: folders of older digests stay on disk; remove them when a plugin's record changes, if disk use matters.
 */
export async function materializePlugin(stateDir: string, name: string, files: { path: string; content: Buffer }[]): Promise<string> {
  checkPluginFiles(name, files);
  const parent = join(stateDir, "plugins", name);
  // The hex part only: a `:` in the root would split PATH-like values a server builds from it.
  const dir = join(parent, contentDigest(files).slice("sha256:".length));
  if (await stat(dir).then(() => true, () => false)) return dir;
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const tmp = join(parent, `.tmp-${randomUUID()}`);
  const folders: string[] = [];
  // Each level is made here, never through a link.
  const folder = async (path: string) => {
    await mkdir(path, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") throw err;
    });
    if (!(await lstat(path)).isDirectory()) refuse(`The plugin ${name}'s folders collide with its files.`);
    folders.push(path);
  };
  try {
    await folder(tmp);
    for (const file of files) {
      const segments = file.path.split("/");
      let at = tmp;
      for (const segment of segments.slice(0, -1)) await folder((at = join(at, segment)));
      const path = join(at, segments.at(-1)!);
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600).catch(() => refuse(`The plugin ${name} couldn't be written on this runner.`));
      try {
        await handle.writeFile(file.content);
      } finally {
        await handle.close();
      }
      // Readable and executable, never writable: the files carry no mode, and a `./` command must run.
      await chmod(path, 0o555);
    }
    for (const path of folders.reverse()) await chmod(path, 0o555);
    await rename(tmp, dir).catch(async (err: NodeJS.ErrnoException) => {
      // Another launch put the same digest in place first.
      if (err.code !== "EEXIST" && err.code !== "ENOTEMPTY") throw err;
    });
  } finally {
    await unlock(tmp);
    await rm(tmp, { recursive: true, force: true });
  }
  return dir;
}

/**
 * How to start the plugin `name`'s stdio server, or `PluginRefused`. First, with nothing written:
 * the record of that name must exist, the digest of `files` equal its digest, and `entry`
 * canonicalize as its entry does. Then the files are materialized, a `./` command must be a file
 * whose real path is inside the plugin root (any other command is one bare name), `cwd` (default
 * the root) must stay inside the root or `<stateDir>/plugin-data/<name>/` (created here, kept
 * across digests). `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are expanded once, only in `args`, `env`
 * values and `cwd`, and both variables are set last over the entry's `env`.
 */
export async function pluginLaunch(config: Pick<RunnerConfig, "allowedPlugins">, stateDir: string, name: string, files: { path: string; content: Buffer }[], entry: PluginEntry): Promise<Launch> {
  const record = config.allowedPlugins?.find((r) => r.name === name);
  if (!record) refuse(`No record on this runner allows the plugin ${JSON.stringify(name)}: run dispand-runner allow-plugin on that machine.`);
  const digest = contentDigest(files);
  if (digest !== record.digest) refuse(`The files of the plugin ${name} have the digest ${digest}, not ${record.digest} that this runner allowed.`);
  if (canonicalEntry(entry) !== canonicalEntry(record.entry)) refuse(`The launch entry of the plugin ${name} isn't the one this runner allowed.`);

  const root = realpathSync(await materializePlugin(stateDir, name, files));
  const dataDir = join(stateDir, "plugin-data", name);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const data = realpathSync(dataDir);
  const expand = (value: string) => value.replace(/\$\{PLUGIN_(ROOT|DATA)\}/g, (_, which: string) => (which === "ROOT" ? root : data));

  let command = entry.command;
  if (command.startsWith("./")) {
    let real: string | undefined;
    try {
      real = realpathSync(join(root, command.slice(2)));
    } catch {
      // Not there: refused below.
    }
    if (!real || !inside(real, root) || real === root || !statSync(real).isFile()) refuse(`The command of the plugin ${name} isn't a file inside the plugin.`);
    command = real;
  } else if (command.includes("/") || command.includes("\\") || command === "." || command === "..") {
    refuse(`The command of the plugin ${name} is neither one name nor a ./ path inside the plugin.`);
  }
  const cwd = realOf(resolve(root, expand(entry.cwd ?? "./")));
  if (!inside(cwd, root) && !inside(cwd, data)) refuse(`The working directory of the plugin ${name} isn't inside the plugin or its data folder.`);
  const env = Object.fromEntries(Object.entries(entry.env ?? {}).map(([key, value]) => [key, expand(value)]));
  return { command, args: (entry.args ?? []).map(expand), env: { ...env, PLUGIN_ROOT: root, PLUGIN_DATA: data }, cwd };
}
