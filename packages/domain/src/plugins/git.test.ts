import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { lstat, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { fetchGit } from "./git.ts";
import { fixtureRepo } from "./test-support.ts";

test("fetchGit refuses http://, ssh, credentials and file:// unless allowed", async () => {
  for (const url of ["http://example.com/x.git", "ssh://git@example.com/x.git", "git@example.com:x.git", "git://example.com/x.git", "https://user:pw@example.com/x.git", "file:///tmp/x", "ext::sh -c id"]) {
    await expect(fetchGit(url), url).rejects.toMatchObject({ name: "GitError" });
  }
  await expect(fetchGit("https://example.com/x.git", { ref: "--upload-pack=id" })).rejects.toThrow("branch or tag");
  await expect(fetchGit("https://example.com/x.git", { sha: "HEAD" })).rejects.toThrow("40 hexadecimal");
});

test("fetchGit clones the default branch, or the commit asked for, and cleans up", async () => {
  const repo = fixtureRepo({ "a.txt": "one" });
  const second = repo.commit({ "a.txt": "two" });
  const head = await fetchGit(repo.url, { allowFile: true });
  expect(head.sha).toBe(second);
  expect(await readFile(`${head.dir}/a.txt`, "utf8")).toBe("two");
  await head.cleanup();
  await expect(stat(head.dir)).rejects.toMatchObject({ code: "ENOENT" });

  const pinned = await fetchGit(repo.url, { sha: repo.sha, allowFile: true });
  expect(pinned.sha).toBe(repo.sha);
  expect(await readFile(`${pinned.dir}/a.txt`, "utf8")).toBe("one");
  await pinned.cleanup();
  repo.remove();
});

test("links in the repository are left out of the checkout and listed, never followed", async () => {
  const repo = fixtureRepo({ "skills/x/SKILL.md": "x", "skills/x/host": { link: "/etc/hostname" }, "skills/x/dir": { link: ".." } });
  const checkout = await fetchGit(repo.url, { allowFile: true });
  expect(checkout.links.sort()).toEqual(["skills/x/dir", "skills/x/host"]);
  await expect(lstat(`${checkout.dir}/skills/x/host`)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(`${checkout.dir}/skills/x/dir`)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(`${checkout.dir}/skills/x/SKILL.md`, "utf8")).toBe("x");
  await checkout.cleanup();
  repo.remove();
});

test("fetchGit fails past its size cap and leaves nothing behind", async () => {
  const repo = fixtureRepo({ "big.bin": "x".repeat(300_000) });
  await expect(fetchGit(repo.url, { allowFile: true, maxBytes: 100_000 })).rejects.toThrow(/larger than/);
  await expect(fetchGit(`${repo.url}-missing`, { allowFile: true })).rejects.toThrow(/Couldn't fetch .*: /);
  repo.remove();
});

// macOS refuses file names that aren't UTF-8, so the fixture can only be made on Linux (what the server runs).
test.skipIf(process.platform === "darwin")("a file name that isn't UTF-8 refuses the fetch before its size is read", async () => {
  const repo = fixtureRepo({ "a.txt": "a" });
  // Latin-1 "é.bin": the size walk reads names as text and couldn't see this file.
  writeFileSync(Buffer.concat([Buffer.from(`${repo.dir}/`), Buffer.from([0xe9]), Buffer.from(".bin")]), "x".repeat(300_000));
  repo.commit({});
  await expect(fetchGit(repo.url, { allowFile: true })).rejects.toThrow(/isn't UTF-8/);
  repo.remove();
});

test("a limit kills git and every helper it started, and settles at once", async () => {
  // A stand-in for git that leaves a helper downloading, holding its pipes.
  const bin = mkdtempSync(join(tmpdir(), "dispand-fake-git-"));
  onTestFinished(() => rmSync(bin, { recursive: true, force: true }));
  const pidFile = join(bin, "helper.pid");
  writeFileSync(join(bin, "git"), `#!/bin/sh\nsleep 30 &\necho $! > ${pidFile}\nexec sleep 30\n`);
  chmodSync(join(bin, "git"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const started = Date.now();
    await expect(fetchGit("https://example.invalid/x.git", { timeoutMs: 500 })).rejects.toThrow(/longer than/);
    expect(Date.now() - started).toBeLessThan(5000);
  } finally {
    process.env.PATH = path;
  }
  const helper = Number(readFileSync(pidFile, "utf8"));
  await new Promise((r) => setTimeout(r, 200));
  expect(() => process.kill(helper, 0)).toThrow();
});
