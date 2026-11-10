import * as nodeFs from "node:fs";
import { dirname } from "node:path";

type Writer = (fd: number, buf: Buffer, offset: number, length: number) => number;

/** Writes all of `text` to `fd`, however short each write is; throws on a write that makes no progress. */
export function writeAll(write: Writer, fd: number, text: string): void {
  const buf = Buffer.from(text);
  for (let off = 0; off < buf.length; ) {
    const n = write(fd, buf, off, buf.length - off);
    if (!(n > 0)) throw new Error(`short write: ${off} of ${buf.length} bytes`);
    off += n;
  }
}

/**
 * Replaces `path` with `text` so a crash leaves either the old file or the new one, on disk:
 * written to a temp file and fsynced, renamed over `path`, then the directory fsynced so the
 * rename itself is durable. `fs` is replaceable for tests.
 */
export function writeDurable(path: string, text: string, mode = 0o600, fs: typeof nodeFs = nodeFs): void {
  const tmp = `${path}.tmp`;
  const fd = fs.openSync(tmp, "w", mode);
  try {
    // `mode` only applies when the file is created: a leftover temp file keeps its own.
    fs.fchmodSync(fd, mode);
    // Never synced or renamed half-written.
    writeAll((f, b, o, l) => fs.writeSync(f, b, o, l), fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, path);
  const dir = fs.openSync(dirname(path), "r");
  try {
    fs.fsyncSync(dir);
  } finally {
    fs.closeSync(dir);
  }
}

/** Moves `from` to `to` (same filesystem) and fsyncs both directories, so the move is durable. */
export function moveDurable(from: string, to: string, fs: typeof nodeFs = nodeFs): void {
  fs.renameSync(from, to);
  for (const dir of new Set([dirname(from), dirname(to)])) {
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
}
