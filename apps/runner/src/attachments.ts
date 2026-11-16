import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
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
 * Writes each file at its path under `runDir`. Every path is checked again (`SessionFile`, so
 * `isAttachmentPath`) before anything is written; `.dispand` must be a real folder, and the folders
 * below it are made here or must be real folders, so none is a link. Files are created with `wx`
 * and `O_NOFOLLOW`, then made 0444; one already there (the same message sent again) is kept.
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
  for (const { file, bytes } of files) {
    const [id, name] = file.path.slice(ATTACHMENTS_DIR.length + 1).split("/") as [string, string];
    await folder(join(runDir, ATTACHMENTS_DIR, id));
    const path = join(runDir, ATTACHMENTS_DIR, id, name);
    let handle;
    try {
      handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    await chmod(path, 0o444);
  }
}

/**
 * Fetches and writes a message's files: undefined once they are all in place, else the line the
 * runner adds to the message so the agent knows (in English, with the reason only).
 */
export async function copyAttachments(runDir: string, files: SessionFile[], from: { server: string; token: string } | undefined): Promise<string | undefined> {
  try {
    if (!from) throw new AttachmentsRefused("this runner has no way to fetch files from Dispand");
    const fetched = [];
    for (const file of files) fetched.push({ file, bytes: await fetchAttachment(from.server, from.token, file.attachmentId) });
    await writeAttachments(runDir, fetched);
    return undefined;
  } catch (err) {
    const reason = err instanceof AttachmentsRefused ? err.message : `error ${(err as NodeJS.ErrnoException).code ?? "writing them"}`;
    return `(The runner couldn't copy the attached files into your working folder: ${reason}. Tell the person.)`;
  }
}
