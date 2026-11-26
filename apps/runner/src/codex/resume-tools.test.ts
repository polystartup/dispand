import { expect, test } from "vitest";
import type { ThreadResumeParams } from "./protocol/v2/ThreadResumeParams.ts";

// Typecheck fails here, with this sentence, once the generated protocol's `thread/resume` takes dynamic tools.
type ResumeTools = "dynamicTools" extends keyof ThreadResumeParams
  ? "Codex now accepts dynamic tools on resume: pass them in session.ts and remove the #244 stopgap (engine.skillCodexTools)"
  : "none";

test("Codex's thread/resume takes no dynamic tools yet (#244)", () => {
  const resumeTools: ResumeTools = "none";
  expect(resumeTools).toBe("none");
});
