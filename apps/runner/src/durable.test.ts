import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { writeAll, writeDurable } from "./durable.ts";

test("writeDurable fsyncs the file and its directory, and replaces it by rename", async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-"));
  try {
    const synced: string[] = [];
    const opened = new Map<number, string>();
    const spy: typeof fs = {
      ...fs,
      openSync: ((path: fs.PathLike, ...rest: [never]) => {
        const fd = fs.openSync(path, ...rest);
        opened.set(fd, String(path));
        return fd;
      }) as typeof fs.openSync,
      fsyncSync: (fd: number) => {
        synced.push(opened.get(fd)!);
        fs.fsyncSync(fd);
      },
    };
    const path = join(dir, "state.json");
    writeDurable(path, '{"seq":1}', 0o600, spy);
    writeDurable(path, '{"seq":2}', 0o600, spy);
    expect(await readFile(path, "utf8")).toBe('{"seq":2}');
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe("600");
    expect(synced).toEqual([`${path}.tmp`, dir, `${path}.tmp`, dir]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeAll loops over short writes and throws on a write that makes no progress", () => {
  const written: string[] = [];
  // Writes at most 3 bytes per call.
  const short = (_fd: number, buf: Buffer, offset: number, length: number) => {
    const n = Math.min(3, length);
    written.push(buf.subarray(offset, offset + n).toString());
    return n;
  };
  writeAll(short, 0, "hello world");
  expect(written.join("")).toBe("hello world");
  expect(written.length).toBe(4);
  expect(() => writeAll(() => 0, 0, "x")).toThrow(/short write/);
});
