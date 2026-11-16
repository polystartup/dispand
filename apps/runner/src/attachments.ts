import { spawn } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ATTACHMENTS_DIR, MAX_FILE_BYTES, RUNNER_ATTACHMENTS_PATH, SessionFile } from "@dispand/runner-protocol";
import { PLANS_ROOT } from "./workdir.ts";

/**
 * A chat message's files, copied into the session's run folder before its text reaches the CLI:
 * each at `.dispand/attachments/<id>/file<.ext>`, a path Dispand made and both sides check
 * (`isAttachmentPath`), so never one a CLI reads as configuration or instructions. Kept with the
 * run folder: a later turn, or a resume, may read them again.
 */

const FETCH_TIMEOUT_MS = 60_000;

/** Why a message's files couldn't be copied: the text still goes, saying so. */
export class AttachmentsRefused extends Error {
  override name = "AttachmentsRefused";
}

/**
 * Fetches one file from `GET <server>/runner/attachments/<id>` with the runner's token: redirects
 * refused, the body capped at `MAX_FILE_BYTES` as it streams.
 */
export async function fetchAttachment(server: string, token: string, attachmentId: string): Promise<Buffer> {
  let res: Response;
  try {
    res = await fetch(new URL(`${RUNNER_ATTACHMENTS_PATH}/${encodeURIComponent(attachmentId)}`, server), { headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    throw new AttachmentsRefused("Dispand couldn't be reached");
  }
  if (res.status !== 200 || !res.body) {
    await res.body?.cancel();
    throw new AttachmentsRefused(`Dispand refused a file (${res.status})`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.byteLength;
    if (size > MAX_FILE_BYTES) {
      await res.body.cancel().catch(() => undefined);
      throw new AttachmentsRefused("a file is larger than 10 MiB");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Creates each file in the folder its process is in: that process `chdir`s into the folder, checks
 * that its real working folder (`getcwd`, which a link can't fake) is the one expected, then
 * creates the file by its bare name with `O_EXCL|O_NOFOLLOW` and makes it 0444 through its
 * descriptor. Once there, a folder swapped for a link changes nothing: the name is resolved from
 * the folder it is in. A child process, since `chdir` is the whole process's. One already there
 * (the same message sent again) is kept. Exits 3 when a folder isn't the one expected.
 */
const ANCHORED_WRITE = `
const fs = require("node:fs");
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c)).on("end", () => {
  for (const f of JSON.parse(Buffer.concat(chunks).toString("utf8"))) {
    process.chdir(f.dir);
    if (process.cwd() !== f.dir) process.exit(3);
    let fd;
    try {
      fd = fs.openSync(f.name, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    } catch (err) {
      if (err.code === "EEXIST") continue;
      throw err;
    }
    fs.writeFileSync(fd, Buffer.from(f.base64, "base64"));
    fs.fchmodSync(fd, 0o444);
    fs.closeSync(fd);
  }
});`;

/**
 * Writes each file at its path under `runDir` (a real path, as `resolveWorkdir` gives it). Every
 * path is checked again (`SessionFile`, so `isAttachmentPath`) before anything is written;
 * `.dispand` must be a real folder, and the folders below it are made here or must be real
 * folders. The files themselves are created anchored to their folder (`ANCHORED_WRITE`): a live
 * session can't swap a folder for a link between the checks and the write.
 */
export async function writeAttachments(runDir: string, files: { file: SessionFile; bytes: Uint8Array }[]): Promise<void> {
  for (const { file } of files) {
    if (!SessionFile.safeParse(file).success) throw new AttachmentsRefused("a file has a path a session may not get");
  }
  const folder = async (path: string) => {
    await mkdir(path, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") throw err;
    });
    if (!(await lstat(path)).isDirectory()) throw new AttachmentsRefused(`${path} must be a real directory`);
  };
  const root = await lstat(join(runDir, PLANS_ROOT)).catch(() => null);
  if (!root?.isDirectory()) throw new AttachmentsRefused(`${join(runDir, PLANS_ROOT)} must be a real directory`);
  await folder(join(runDir, ATTACHMENTS_DIR));
  const writes = [];
  for (const { file, bytes } of files) {
    const [id, name] = file.path.slice(ATTACHMENTS_DIR.length + 1).split("/") as [string, string];
    const dir = join(runDir, ATTACHMENTS_DIR, id);
    await folder(dir);
    writes.push({ dir, name, base64: Buffer.from(bytes).toString("base64") });
  }
  await writeAnchored(writes);
}

/** Runs `ANCHORED_WRITE` on these files: each `dir` must be the real path of the folder it names. */
export async function writeAnchored(writes: { dir: string; name: string; base64: string }[]): Promise<void> {
  // No environment: the child needs none, and gets no `NODE_OPTIONS` or secret of the runner's.
  const child = spawn(process.execPath, ["-e", ANCHORED_WRITE], { stdio: ["pipe", "ignore", "ignore"], env: {} });
  const code = new Promise<number | null>((resolve, reject) => child.on("error", reject).on("close", resolve));
  child.stdin.end(JSON.stringify(writes));
  const exit = await code;
  if (exit === 3) throw new AttachmentsRefused("an attachments folder was moved while its files were written");
  if (exit !== 0) throw new AttachmentsRefused("the files couldn't be written");
}

/**
 * Fetches and writes a message's files: undefined once they are all in place, else the line the
 * runner adds to the message so the agent knows (in English, with the reason only).
 */
export async function copyAttachments(runDir: string, files: SessionFile[], from: { server: string; token: string } | undefined): Promise<string | undefined> {
  try {
    if (!from) throw new AttachmentsRefused("this runner has no way to fetch files from Dispand");
    if (files.some((f) => !SessionFile.safeParse(f).success)) throw new AttachmentsRefused("a file has a path a session may not get");
    // One file at a time: at most one file's bytes in memory.
    for (const file of files) await writeAttachments(runDir, [{ file, bytes: await fetchAttachment(from.server, from.token, file.attachmentId) }]);
    return undefined;
  } catch (err) {
    const reason = err instanceof AttachmentsRefused ? err.message : `error ${(err as NodeJS.ErrnoException).code ?? "writing them"}`;
    return `(The runner couldn't copy the attached files into your working folder: ${reason}. Tell the person.)`;
  }
}
