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

test("busy disables the buttons, the error and the restart note show", () => {
  setup({ kind: "confirm-outputs", values: {} }, { busy: true, error: "Already answered", orphaned: true });
  expect(screen.getByRole("button", { name: "Go ahead" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("alert").textContent).toBe("Already answered");
  expect(screen.getByText(/agent was restarted/)).toBeTruthy();
});
