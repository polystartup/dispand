// Which sessions each runtime runs in a worker: only the modes verified on it (the spec's
// evidence). Under runc, an ordinary Codex chat can't build its own sandbox, and bypass would
// drop its approval prompt: it is refused before its worker starts, never retried in bypass.
import type { ClaudePermissionMode, CodexPermissionMode, SessionStart } from "@dispand/runner-protocol";
import type { z } from "zod";

export type Runtime = "runsc" | "runc";
type Modes<M extends string> = Record<M, { ordinary: boolean; restricted: boolean }>;

/** Typed over every mode of each harness: a new mode doesn't compile until it is listed here. */
export const VERIFIED: Record<Runtime, { "claude-code": Modes<z.infer<typeof ClaudePermissionMode>>; codex: Modes<z.infer<typeof CodexPermissionMode>> }> = {
  runsc: {
    "claude-code": { default: { ordinary: true, restricted: true }, acceptEdits: { ordinary: true, restricted: true }, plan: { ordinary: true, restricted: true }, bypassPermissions: { ordinary: true, restricted: true } },
    codex: { default: { ordinary: true, restricted: true }, bypassPermissions: { ordinary: true, restricted: true } },
  },
  runc: {
    "claude-code": { default: { ordinary: true, restricted: true }, acceptEdits: { ordinary: true, restricted: true }, plan: { ordinary: true, restricted: true }, bypassPermissions: { ordinary: true, restricted: true } },
    codex: { default: { ordinary: false, restricted: true }, bypassPermissions: { ordinary: false, restricted: true } },
  },
};

/** Why this runner won't run that session on its runtime, or nothing when it is verified there. */
export function unverified(runtime: string, start: SessionStart): string | undefined {
  // A runtime outside the table has nothing verified on it.
  const modes = (Object.hasOwn(VERIFIED, runtime) ? VERIFIED[runtime as Runtime][start.harness] : {}) as Partial<Modes<string>>;
  const mode = modes[start.permissionMode];
  if (mode?.[start.restricted ? "restricted" : "ordinary"]) return undefined;
  return `this runner's host has no gVisor: it runs only Claude Code and restricted Jobs there, not this ${start.harness === "codex" ? "Codex" : "Claude Code"} session`;
}
