import { expect, test } from "vitest";
import { earlierConversation, resumePrompt } from "./answers.ts";

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

test("a fresh chat session's context keeps the newest turns that fit and skips tool rows", () => {
  const rows = [
    { role: "user", text: "old ".repeat(50) },
    { role: "assistant", text: "Old answer" },
    { role: "tool", text: "ran a tool" },
    { role: "user", text: "Continue" },
  ] as const;
  const all = earlierConversation([...rows], 10_000);
  expect(all).toContain("You answered: Old answer");
  expect(all).toContain("The owner wrote: Continue");
  expect(all).not.toContain("ran a tool");
  const tight = earlierConversation([...rows], 200);
  expect(tight.length).toBeLessThanOrEqual(200);
  expect(tight).toContain("Continue");
  expect(tight).not.toContain("old old");
  expect(earlierConversation([], 10_000)).toBe("");
  expect(earlierConversation([...rows], 10)).toBe("");
});
