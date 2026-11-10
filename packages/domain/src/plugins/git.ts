import { spawn } from "node:child_process";
import { lstat, mkdtemp, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Why a Git fetch failed, in words for the owner: never git's own output or a local path. */
export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

export type FetchGitOptions = {
  /** A branch or tag; the remote's default branch when absent. */
  ref?: string;
  /** A commit to check out; it wins over `ref`. */
  sha?: string;
  timeoutMs?: number;
  /** Bytes the clone (checkout and `.git`) may take on disk. */
  maxBytes?: number;
  /** Lets `file://` URLs through: tests and development fixtures only. */
  allowFile?: boolean;
};

/** A checkout; `links` are the repository's symbolic links (paths from its root), left out of `dir`. */
export type Checkout = { dir: string; sha: string; links: string[]; cleanup(): Promise<void> };

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const REF = /^(?!-)[A-Za-z0-9._/-]{1,200}$/;
const SIZE_POLL_MS = 300;
const MAX_STDOUT = 16 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * The URL `fetchGit` accepts: `https://` (with a host and no credentials in it), or `file://`
 * only when `allowFile` is set. Throws `GitError` otherwise.
 */
export function checkGitUrl(url: string, allowFile = false): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GitError("Use an https:// Git URL");
  }
  if (allowFile && parsed.protocol === "file:") return parsed;
  if (parsed.protocol !== "https:" || parsed.hostname === "") throw new GitError("Use an https:// Git URL");
  if (parsed.username !== "" || parsed.password !== "") throw new GitError("A Git URL can't hold credentials");
  return parsed;
}

/** Bytes under `dir` (files as they are, links not followed); stops counting past `limit`. */
async function sizeOf(dir: string, limit: number): Promise<number> {
  let total = 0;
  const pending = [dir];
  while (pending.length > 0 && total <= limit) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue; // git renames and removes temp files while it works
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else {
        try {
          total += (await lstat(path)).size;
        } catch {
          // gone meanwhile
        }
      }
    }
  }
  return total;
}

/** What went wrong, from git's stderr, in a few words that hold nothing local. */
function reason(stderr: string): string {
  if (/redirect/i.test(stderr)) return "the server redirected the request";
  if (/could not resolve host|failed to connect|connection refused|connection timed out|network is unreachable/i.test(stderr)) {
    return "couldn't reach the server";
  }
  if (/not found|could not read username|authentication failed|terminal prompts disabled|does not appear to be a git repository/i.test(stderr)) {
    return "the repository wasn't found (or is private)";
  }
  if (/couldn't find remote ref|not our ref|unadvertised object|remote branch .* not found/i.test(stderr)) {
    return "that branch or commit isn't there";
  }
  return "git failed";
}

/**
 * Shallow-clones a Git repository into a fresh temp folder, at `sha` or at the tip of `ref` (else
 * the default branch). Only https (redirects not followed), no prompts, no hooks, no submodules,
 * no system or user git config. Links are checked out as plain files (`core.symlinks=false`, so the
 * checkout holds no link at all), which are then removed and listed in `links`: no file of the
 * checkout is a link's target text, and nothing is ever written through one. Fails
 * past `timeoutMs` (60 s) or `maxBytes` on disk (200 MiB), removing what it wrote.
 */
export async function fetchGit(url: string, opts: FetchGitOptions = {}): Promise<Checkout> {
  const parsed = checkGitUrl(url, opts.allowFile);
  if (opts.sha !== undefined && !SHA.test(opts.sha)) throw new GitError("A commit is 40 hexadecimal characters");
  if (opts.ref !== undefined && !REF.test(opts.ref)) throw new GitError("That isn't a branch or tag name");
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const maxBytes = opts.maxBytes ?? 200 * 1024 * 1024;
  const deadline = Date.now() + timeoutMs;
  const where = `Couldn't fetch ${parsed.href}`;

  const root = await mkdtemp(join(tmpdir(), "dispand-git-"));
  const dir = join(root, "repo");
  const cleanup = () => rm(root, { recursive: true, force: true });
  const config = [
    "protocol.allow=never",
    "protocol.https.allow=always",
    ...(opts.allowFile ? ["protocol.file.allow=always"] : []),
    "http.followRedirects=false",
    "core.symlinks=false",
    "core.hooksPath=/dev/null",
    "core.fsmonitor=false",
    "submodule.recurse=false",
    "fetch.recurseSubmodules=false",
    "credential.helper=",
  ].flatMap((c) => ["-c", c]);
  // Nothing from the server's own environment or git config reaches git.
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: root,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    LC_ALL: "C",
  };

  const git = (args: string[], cwd = root): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      // Its own process group: a limit kills git and every helper it started (remote-https,
      // index-pack), which could otherwise keep downloading and hold the pipes open.
      const child = spawn("git", [...config, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let stderr = "";
      let settled = false;
      const killGroup = () => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      };
      const finish = (error: GitError | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        killGroup();
        child.stdout.destroy();
        child.stderr.destroy();
        if (error) reject(error);
        else resolve(Buffer.concat(stdout));
      };
      child.stdout.on("data", (d: Buffer) => {
        stdoutBytes += d.length;
        // Only `ls-files` says much: past this, the repository has too many files to list whole.
        if (stdoutBytes > MAX_STDOUT) finish(new GitError(`${where}: it has too many files`));
        else stdout.push(d);
      });
      child.stderr.setEncoding("utf8").on("data", (d: string) => {
        if (stderr.length < 16 * 1024) stderr += d;
      });
      const timer = setTimeout(() => finish(new GitError(`${where}: it took longer than ${Math.round(timeoutMs / 1000)} s`)), Math.max(0, deadline - Date.now()));
      let measuring = false;
      const poll = setInterval(() => {
        if (measuring) return;
        measuring = true;
        void sizeOf(root, maxBytes).then((size) => {
          measuring = false;
          if (size > maxBytes) finish(new GitError(`${where}: it is larger than ${Math.round(maxBytes / 1024 / 1024)} MiB`));
        });
      }, SIZE_POLL_MS);
      child.on("error", () => finish(new GitError(`${where}: git isn't installed on the server`)));
      // `exit`, then the pipes' end, bounded by the deadline: a helper still holding them open
      // can't delay the outcome past it.
      const ended = (stream: NodeJS.ReadableStream & { readableEnded: boolean }) =>
        stream.readableEnded ? Promise.resolve() : new Promise<void>((done) => stream.once("end", done).once("close", done));
      child.on("exit", (code) => {
        // Git is done: whatever it left running is of no use.
        killGroup();
        void Promise.all([ended(child.stdout), ended(child.stderr)]).then(() => finish(code === 0 ? null : new GitError(`${where}: ${reason(stderr)}`)));
      });
    });

  try {
    const remote = parsed.href;
    if (opts.sha) {
      await git(["init", "-q", "--template=", dir]);
      await git(["fetch", "-q", "--depth", "1", "--no-tags", "--", remote, opts.sha], dir);
      await git(["checkout", "-q", "--detach", "FETCH_HEAD"], dir);
    } else {
      await git(["clone", "-q", "--template=", "--depth", "1", "--no-tags", ...(opts.ref ? ["--branch", opts.ref] : []), "--", remote, dir]);
    }
    const sha = (await git(["rev-parse", "HEAD"], dir)).toString("utf8").trim();
    // Paths are read byte for byte, and every one must be UTF-8 before anything else reads the
    // checkout: one that isn't could name two files at once, and the size walk (which reads names
    // as text) couldn't see it, so the whole fetch is refused.
    const links: string[] = [];
    const index = await git(["ls-files", "-s", "-z"], dir);
    let start = 0;
    while (start < index.length) {
      const end = index.indexOf(0, start);
      const record = index.subarray(start, end === -1 ? index.length : end);
      start = end === -1 ? index.length : end + 1;
      let path: string;
      try {
        path = utf8.decode(record.subarray(record.indexOf(9) + 1));
      } catch {
        throw new GitError(`${where}: a file name in it isn't UTF-8`);
      }
      if (record.subarray(0, 7).equals(Buffer.from("120000 "))) links.push(path);
    }
    if ((await sizeOf(root, maxBytes)) > maxBytes) throw new GitError(`${where}: it is larger than ${Math.round(maxBytes / 1024 / 1024)} MiB`);
    // Links came out as plain files holding their target: remove them (the checkout holds no
    // link, so nothing is followed) and list them.
    for (const path of links) await unlink(join(dir, path));
    return { dir, sha, links, cleanup };
  } catch (error) {
    await cleanup();
    throw error instanceof GitError ? error : new GitError(`${where}: git failed`);
  }
}
