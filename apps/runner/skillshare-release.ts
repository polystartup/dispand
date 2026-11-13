// The runner ships these exact upstream releases; changing the pin runs the same contract tests.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SKILLSHARE_VERSION = "0.30.6";
export const SKILLSHARE_RELEASES = {
  x64: { archive: "skillshare_0.30.6_linux_amd64.tar.gz", sha256: "d8ddea82f0a2679e68c2dfdcecb3353ee02a1ae12d4b209b8e0a7839b72607e9" },
  arm64: { archive: "skillshare_0.30.6_linux_arm64.tar.gz", sha256: "5ff78b6550c133806fc150c8f5494c4519da39c4151ddf13248456b8749a59a3" },
} as const;
export type SkillshareArch = keyof typeof SKILLSHARE_RELEASES;

export function verifySkillshare(arch: SkillshareArch, archive: Uint8Array): void {
  if (createHash("sha256").update(archive).digest("hex") !== SKILLSHARE_RELEASES[arch].sha256) {
    throw new Error(`Skillshare ${SKILLSHARE_VERSION} ${arch}: release checksum mismatch`);
  }
}

/** Cache only verified archives; extract the executable and its MIT license into the runner. */
export async function bundleSkillshare(dest: string, arch: SkillshareArch): Promise<string> {
  const release = SKILLSHARE_RELEASES[arch];
  const cache = new URL(`./node_modules/.cache/skillshare/${release.archive}`, import.meta.url);
  let archive: Buffer | undefined;
  try { archive = readFileSync(cache); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!archive) {
    const response = await fetch(`https://github.com/runkids/skillshare/releases/download/v${SKILLSHARE_VERSION}/${release.archive}`, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Skillshare release download failed (${response.status})`);
    archive = Buffer.from(await response.arrayBuffer());
    verifySkillshare(arch, archive);
    mkdirSync(new URL(".", cache), { recursive: true });
    writeFileSync(cache, archive);
  }
  verifySkillshare(arch, archive);
  mkdirSync(dest, { recursive: true });
  execFileSync("tar", ["-xzf", "-", "-C", dest, "skillshare", "LICENSE"], { input: archive });
  const binary = join(dest, "skillshare");
  chmodSync(binary, 0o755);
  return binary;
}
