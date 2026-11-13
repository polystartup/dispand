import { expect, test } from "vitest";
import { resumePrompt } from "./engine.ts";

test("a restarted chat with no instructions carries only what it missed, and nothing when it missed nothing", () => {
  const unsent = [{ id: "msg_1", text: "Hi" }] as Parameters<typeof resumePrompt>[2];
  expect(resumePrompt("", [], unsent, []).prompt).toBe("The owner wrote: Hi");
  expect(resumePrompt("", [], [], []).prompt).toBe("");
});

test("a resumed native slash invocation stays at the start and later messages remain separate", () => {
  const unsent = [{ id: "m1", text: "/office:tidy these rows" }, { id: "m2", text: "Then summarize" }] as Parameters<typeof resumePrompt>[2];
  expect(resumePrompt(null, [], unsent, [])).toMatchObject({ prompt: "/office:tidy these rows", messages: [unsent[0]], laterMessages: [unsent[1]] });
});
