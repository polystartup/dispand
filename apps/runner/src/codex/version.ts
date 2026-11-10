// Which Codex the runner works with, and what it reports about the machine's one.
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { ID } from "@dispand/runner-protocol";
import { protocolString } from "../sanitize.ts";
import { atLeast } from "../sessions.ts";
import { CodexRpc } from "./rpc.ts";

/** The Codex `src/codex/protocol` was generated from. */
export const CODEX_TESTED = "0.166.0";
/** The oldest Codex sessions may run on. */
export const MIN_CODEX = "0.166.0";

/** Why sessions can't run on Codex `version` (undefined if none is found), or undefined when they can. */
export function codexRequired(version: string | undefined): string | undefined {
  if (atLeast(version, MIN_CODEX)) return undefined;
  return `Codex ≥ ${MIN_CODEX} required (found ${version ?? "none"}): update codex on this machine`;
}

/** How long `codexStatus` waits for Codex: the runner connects only once it knows. */
const STATUS_TIMEOUT_MS = 15_000;

/**
 * The machine's Codex version and whether it can run turns: signed in, or configured for a
 * provider that needs no OpenAI auth. Undefined when it doesn't run, or its app-server fails or
 * doesn't answer within `timeoutMs` (the app-server is then killed). The account itself (its
 * email included) never leaves this function.
 */
export async function codexStatus(
  codexPath: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = STATUS_TIMEOUT_MS,
): Promise<{ version: string; signedIn: boolean } | undefined> {
  let version: string | undefined;
  try {
    const { stdout } = await promisify(execFile)(codexPath, ["--version"], { env, timeout: timeoutMs });
    version = protocolString(stdout.trim().split(/\s+/).at(-1) ?? "", ID);
  } catch {
    return undefined;
  }
  if (!version) return undefined;
  let rpc: CodexRpc | undefined;
  try {
    rpc = await CodexRpc.spawn(codexPath, env, tmpdir(), AbortSignal.timeout(timeoutMs));
    const { account, requiresOpenaiAuth } = await rpc.request("account/read", { refreshToken: false });
    return { version, signedIn: account !== null || !requiresOpenaiAuth };
  } catch {
    return undefined;
  } finally {
    await rpc?.close();
  }
}
