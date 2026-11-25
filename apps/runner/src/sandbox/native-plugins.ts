// A conversation's native plugins in the container image: the files of each plugin its agent was
// granted, fetched from Dispand by the digest its start names, checked against that digest, and
// kept read-only under `<state>/native-plugins/<digest>`. A worker mounts only its own set.
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { contentDigest } from "@dispand/runner-protocol/digest";
import { z } from "zod";
import { checkFiles, PluginRefused, writeReadOnly } from "../plugin-servers.ts";
import { readCapped, unlock } from "../skills.ts";

type Files = { path: string; content: Buffer }[];
export type NativePluginRef = { pluginId: string; digest: string };
/** Fetches one plugin's files at `digest`; throws `PluginRefused` in the runner's words. */
export type FetchNative = (pluginId: string, digest: string) => Promise<Files>;

const Body = z.object({ files: z.array(z.object({ path: z.string().max(255), base64: z.base64() })).max(500) });

/** `GET <server>/runner/native-plugins/<id>?digest=` with the runner's token. Redirects refused, body capped. */
export function fetchNativePlugin(server: string, token: string): FetchNative {
  return async (pluginId, digest) => {
    let res: Response;
    try {
      res = await fetch(`${server}/runner/native-plugins/${encodeURIComponent(pluginId)}?digest=${encodeURIComponent(digest)}`, { headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      throw new PluginRefused(`can't reach ${server}: ${(err as Error).message}`);
    }
    if (res.status !== 200) {
      await res.body?.cancel();
      throw new PluginRefused(`Dispand refused the native plugin ${pluginId} (HTTP ${res.status})`);
    }
    try {
      return Body.parse(JSON.parse(await readCapped(res, 24 * 1024 * 1024))).files.map((f) => ({ path: f.path, content: Buffer.from(f.base64, "base64") }));
    } catch {
      throw new PluginRefused(`the native plugin ${pluginId} isn't readable or is too large`);
    }
  };
}

const storeOf = (stateDir: string) => join(stateDir, "native-plugins");

/**
 * The folders of a conversation's native plugins, one per plugin, each its digest's folder of the
 * store: kept from an earlier start, or fetched, checked (caps, paths, the digest the start named)
 * and written read-only first. Throws `PluginRefused` before anything is written for a plugin
 * that fails.
 */
export async function nativePluginFolders(stateDir: string, plugins: NativePluginRef[], fetchFiles: FetchNative): Promise<{ pluginId: string; dir: string }[]> {
  const out: { pluginId: string; dir: string }[] = [];
  for (const { pluginId, digest } of plugins) {
    const dir = join(storeOf(stateDir), digest.slice("sha256:".length));
    // Only ever written whole, after its digest was checked: an existing folder is that revision.
    if (await stat(dir).then(() => true, () => false)) {
      out.push({ pluginId, dir });
      continue;
    }
    const what = `The native plugin ${pluginId}`;
    const files = await fetchFiles(pluginId, digest);
    checkFiles(what, files);
    if (contentDigest(files) !== digest) throw new PluginRefused(`${what}'s files don't have the digest ${digest} its start named`);
    out.push({ pluginId, dir: await writeReadOnly(storeOf(stateDir), dir, files, what) });
  }
  return out;
}

/** Removes the whole store, at start: no conversation runs yet, and each start fetches its set again. */
export async function sweepNativePlugins(stateDir: string): Promise<void> {
  await unlock(storeOf(stateDir));
  await rm(storeOf(stateDir), { recursive: true, force: true });
}
