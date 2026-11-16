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

test("a message with files is never folded into a resumed session's prompt: it and those after it follow as messages", () => {
  const unsent = [{ id: "m1", text: "Hi" }, { id: "m2", text: "/office:read this", files: [{ id: "att_1", name: "a.pdf" }] }, { id: "m3", text: "Thanks" }] as Parameters<typeof resumePrompt>[2];
  expect(resumePrompt("", [], unsent, [])).toMatchObject({ prompt: "The owner wrote: Hi", messages: [unsent[0]], laterMessages: [unsent[1], unsent[2]] });
  expect(resumePrompt(null, [], unsent.slice(1), [])).toMatchObject({ messages: [], laterMessages: unsent.slice(1) });
});
