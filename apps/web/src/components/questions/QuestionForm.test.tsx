// @vitest-environment jsdom
import type { Answer, QuestionPayload } from "@dispand/runner-protocol";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { QuestionForm } from "./QuestionForm.tsx";

afterEach(cleanup);

function setup(payload: QuestionPayload, extra: { orphaned?: boolean; busy?: boolean; error?: string } = {}) {
  const onAnswer = vi.fn<(a: Answer) => void>();
  render(<QuestionForm question={{ payload, orphaned: extra.orphaned }} onAnswer={onAnswer} busy={extra.busy} error={extra.error} />);
  return { onAnswer, user: userEvent.setup() };
}

const choice: QuestionPayload = {
  kind: "choice",
  questions: [
    { question: "Which tone?", header: "Tone", options: [{ label: "Formal", description: "Like a letter" }, { label: "Casual" }], multiSelect: false },
  ],
};

test("choice renders options with descriptions and returns the label", async () => {
  const { onAnswer, user } = setup(choice);
  expect(screen.getByText("Like a letter")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Send answer" }).hasAttribute("disabled")).toBe(true);
  await user.click(screen.getByRole("radio", { name: /Formal/ }));
  await user.click(screen.getByRole("button", { name: "Send answer" }));
  expect(onAnswer).toHaveBeenCalledWith({ kind: "choice", answers: { "Which tone?": "Formal" } });
});

test("choice: free text is the Other answer, multi-select returns a list", async () => {
  const first = setup(choice);
  await first.user.type(screen.getByLabelText("Other: Which tone?"), "Playful");
  await first.user.click(screen.getByRole("button", { name: "Send answer" }));
  expect(first.onAnswer).toHaveBeenCalledWith({ kind: "choice", answers: { "Which tone?": "Playful" } });
  cleanup();

  const multi: QuestionPayload = {
    kind: "choice",
    questions: [{ question: "Extras?", header: "E", options: [{ label: "Intro" }, { label: "Outro" }], multiSelect: true }],
  };
  const second = setup(multi);
  await second.user.click(screen.getByRole("checkbox", { name: /Intro/ }));
  await second.user.click(screen.getByRole("checkbox", { name: /Outro/ }));
  await second.user.click(screen.getByRole("button", { name: "Send answer" }));
  expect(second.onAnswer).toHaveBeenCalledWith({ kind: "choice", answers: { "Extras?": ["Intro", "Outro"] } });
});

test("permission shows the tool and offers Always allow only when it can", async () => {
  const { onAnswer, user } = setup({ kind: "permission", toolName: "Bash", input: { command: "ls" }, canAlwaysAllow: true });
  expect(screen.getByText("Bash")).toBeTruthy();
  await user.type(screen.getByLabelText("Message to the agent"), "Careful");
  await user.click(screen.getByRole("button", { name: "Always allow" }));
  expect(onAnswer).toHaveBeenCalledWith({ kind: "permission", decision: "allow-always", message: "Careful" });
  cleanup();
  setup({ kind: "permission", toolName: "Bash", input: "ls", canAlwaysAllow: false });
  expect(screen.queryByRole("button", { name: "Always allow" })).toBeNull();
});

test("confirm-outputs: Go ahead confirms, Not yet returns confirmed false with feedback", async () => {
  const { onAnswer, user } = setup({ kind: "confirm-outputs", values: { idea: "notes" } });
  expect(screen.getByText("idea")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Go ahead" }));
  expect(onAnswer).toHaveBeenLastCalledWith({ kind: "confirm-outputs", confirmed: true });
  await user.type(screen.getByLabelText("Feedback"), "Add the audience");
  await user.click(screen.getByRole("button", { name: "Not yet" }));
  expect(onAnswer).toHaveBeenLastCalledWith({ kind: "confirm-outputs", confirmed: false, feedback: "Add the audience" });
});

test("confirm-outputs with nothing to hand back asks to end the chat, with no empty list", async () => {
  const { onAnswer, user } = setup({ kind: "confirm-outputs", values: {} });
  expect(screen.getByText("The agent says it is done and has nothing to hand back. End this chat?")).toBeTruthy();
  expect(screen.queryByText(/Go ahead with these/)).toBeNull();
  expect(screen.queryByRole("term")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Go ahead" }));
  expect(onAnswer).toHaveBeenLastCalledWith({ kind: "confirm-outputs", confirmed: true });
});

test("busy disables the buttons, the error and the restart note show", () => {
  setup({ kind: "confirm-outputs", values: {} }, { busy: true, error: "Already answered", orphaned: true });
  expect(screen.getByRole("button", { name: "Go ahead" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("alert").textContent).toBe("Already answered");
  expect(screen.getByText(/agent was restarted/)).toBeTruthy();
});

test("a checkpoint names its root, Jobs and agents, and answers go on, don't ask again or stop", async () => {
  const payload: QuestionPayload = { kind: "permission", toolName: "checkpoint", input: { root: "A schedule", jobs: 100, agents: ["Clerk", "Auditor"], since: "2026-11-11T09:00:00.000Z" }, canAlwaysAllow: true };
  const onAnswer = vi.fn<(a: Answer) => void>();
  render(<QuestionForm question={{ payload, rootId: "root_1" }} onAnswer={onAnswer} />);
  expect(screen.getByText(/A schedule has led to/).textContent).toContain("100 Jobs");
  expect(screen.getByText("Agents: Clerk, Auditor")).toBeTruthy();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Go on" }));
  await user.click(screen.getByRole("button", { name: "Don't ask again for this goal" }));
  await user.click(screen.getByRole("button", { name: "Stop this work" }));
  expect(onAnswer.mock.calls.map(([a]) => a)).toEqual([
    { kind: "permission", decision: "allow" },
    { kind: "permission", decision: "allow-always" },
    { kind: "permission", decision: "deny" },
  ]);
  cleanup();
  // The same tool name from an agent's own prompt is an ordinary permission: only the row's root makes a checkpoint.
  render(<QuestionForm question={{ payload }} onAnswer={onAnswer} />);
  expect(screen.queryByRole("button", { name: "Go on" })).toBeNull();
  expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
});

test("a consult's Approval names the agent consulted, shows the question whole and what a consult can do, and answers allow, don't ask again or deny", async () => {
  const question = `Which plan?\n${"Context. ".repeat(500)}The end.`;
  const payload: QuestionPayload = { kind: "permission", toolName: "consult", input: { agent: "Architect", question }, canAlwaysAllow: true };
  const onAnswer = vi.fn<(a: Answer) => void>();
  render(<QuestionForm question={{ payload, consultId: "q_consult" }} onAnswer={onAnswer} />);
  expect(screen.getByText(/wants to consult/).textContent).toContain("Architect");
  expect(screen.getByLabelText("Question").textContent).toBe(question);
  expect(screen.getByText(/can steer this agent/)).toBeTruthy();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Allow" }));
  await user.click(screen.getByRole("button", { name: "Don't ask again" }));
  await user.click(screen.getByRole("button", { name: "Deny" }));
  expect(onAnswer.mock.calls.map(([a]) => a)).toEqual([
    { kind: "permission", decision: "allow" },
    { kind: "permission", decision: "allow-always" },
    { kind: "permission", decision: "deny" },
  ]);
  cleanup();
  // The same tool name from an agent's own prompt is an ordinary permission: only the row's consult makes it one.
  render(<QuestionForm question={{ payload }} onAnswer={onAnswer} />);
  expect(screen.queryByText(/wants to consult/)).toBeNull();
});


test.each(["allow", "deny"] as const)("a scoped %s sends the selected owner choice, and Just this call sends none", async (decision) => {
  const onAnswer = vi.fn();
  render(<QuestionForm question={{ payload: { kind: "permission", toolName: "mcp__mail__draft", input: {}, canAlwaysAllow: true }, remember: { scopes: ["run", "always"], label: "Mail: draft" } }} onAnswer={onAnswer} />);
  const user = userEvent.setup();
  expect(screen.queryByRole("button", { name: "Always allow" })).toBeNull();
  await user.click(screen.getByLabelText("Remember this for this run only"));
  await user.click(screen.getByRole("button", { name: decision === "allow" ? "Allow" : "Deny" }));
  expect(onAnswer).toHaveBeenLastCalledWith({ kind: "permission", decision, remember: "run" });
  await user.click(screen.getByLabelText("Remember this for this and all future runs"));
  await user.click(screen.getByRole("button", { name: decision === "allow" ? "Allow" : "Deny" }));
  expect(onAnswer).toHaveBeenLastCalledWith({ kind: "permission", decision, remember: "always" });
  await user.click(screen.getByLabelText("Just this call"));
  await user.click(screen.getByRole("button", { name: decision === "allow" ? "Allow" : "Deny" }));
  expect(onAnswer).toHaveBeenLastCalledWith({ kind: "permission", decision });
});

test("a run-only offer has no future-run option", () => {
  render(<QuestionForm question={{ payload: { kind: "permission", toolName: "mcp__mail__draft", input: {}, canAlwaysAllow: false }, remember: { scopes: ["run"], label: "Mail: draft" } }} onAnswer={() => {}} />);
  expect(screen.getByLabelText("Remember this for this run only")).toBeTruthy();
  expect(screen.queryByLabelText("Remember this for this and all future runs")).toBeNull();
});
