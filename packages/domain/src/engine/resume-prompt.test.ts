import { expect, test } from "vitest";
import { resumePrompt } from "./engine.ts";

test("a restarted chat with no instructions carries only what it missed, and nothing when it missed nothing", () => {
  const unsent = [{ id: "msg_1", text: "Hi" }] as Parameters<typeof resumePrompt>[2];
  expect(resumePrompt("", [], unsent, []).prompt).toBe("The owner wrote: Hi");
  expect(resumePrompt("", [], [], []).prompt).toBe("");
});
