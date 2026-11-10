// @vitest-environment jsdom
import { addStep, defaultWorkflowDef, type WorkflowDef } from "@dispand/domain/workflows/model";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { RunSnapshot } from "../../lib/run-state.ts";
import { RunSteps } from "./RunSteps.tsx";

afterEach(cleanup);

/** Chat "Brief" → For each (Summarize) → Wrap up. */
function workflow(): WorkflowDef {
  let def = defaultWorkflowDef("n_brief");
  def = { ...def, trigger: { type: "manual", field: { id: "n_brief", key: "brief", type: "chat", label: "Brief", agentId: "", prompt: "" } } };
  def = addStep(def, { after: "n_brief" }, "n_each", "loop");
  def = addStep(def, { loop: "n_each" }, "n_sum", "agent");
  def = addStep(def, { after: "n_each" }, "n_wrap", "agent");
  const names: Record<string, string> = { n_each: "Each", n_sum: "Summarize", n_wrap: "Wrap up" };
  def = { ...def, steps: def.steps.map((s) => ({ ...s, name: names[s.id] ?? s.name })) };
  return {
    ...def,
    steps: def.steps.map((s) => (s.id === "n_each" && s.type === "loop" ? { ...s, list: { type: "output", nodeId: "n_brief", name: "items" } } : s)),
  };
}

let seconds = 0;
type Step = RunSnapshot["steps"][number];
function row(id: string, nodeId: string, iteration: number, over: Partial<Step> = {}): Step {
  seconds += 1;
  return {
    id,
    runId: "run_1",
    nodeId,
    iteration,
    status: "succeeded",
    outputs: null,
    error: null,
    startedAt: new Date(2026, 10, 7, 9, 0, seconds),
    finishedAt: new Date(2026, 10, 7, 9, 0, seconds),
    interactive: false,
    prompt: null,
    ...over,
  };
}

function snapshot(steps: Step[]): RunSnapshot {
  return { run: {}, steps, messages: [], questions: [] } as unknown as RunSnapshot;
}

function show(steps: Step[]) {
  render(<RunSteps state={snapshot(steps)} def={workflow()} agentNames={new Map()} />);
}

test("RunSteps groups body steps by iteration", () => {
  seconds = 0;
  show([
    row("s0", "n_brief", 0, { outputs: { items: '["a","b","c"]' } }),
    row("s1", "n_each", 0, { status: "running" }),
    row("s2", "n_sum", 1, { outputs: { summary: "A" } }),
    row("s3", "n_sum", 2, { outputs: { summary: "B" } }),
    row("s4", "n_sum", 3, { status: "running", startedAt: new Date(2026, 10, 7, 9, 1, 0), finishedAt: null }),
  ]);
  const summaries = screen.getAllByText(/^Iteration \d/);
  expect(summaries.map((s) => s.textContent)).toEqual(["Iteration 1 of 3", "Iteration 2 of 3", "Iteration 3 of 3"]);
  // Only the latest is open; the body steps are inside their iteration, not in the top-level list.
  expect(summaries.map((s) => (s.closest("details") as HTMLDetailsElement).open)).toEqual([false, false, true]);
  const iteration = summaries[0]!.closest("details")!;
  expect(within(iteration).getByRole("region", { name: "Summarize" })).toBeTruthy();
  expect(screen.getAllByRole("region", { name: "Summarize" })).toHaveLength(3);
  expect(screen.getAllByRole("region", { name: "Each" })).toHaveLength(1);
});

test("a finished loop counts its iterations, and what follows it stays at the top level", () => {
  seconds = 0;
  show([
    row("s0", "n_brief", 0),
    row("s1", "n_each", 0, { outputs: { count: "2", results: "[]" } }),
    row("s2", "n_sum", 1),
    row("s3", "n_sum", 2),
    row("s4", "n_wrap", 0),
  ]);
  expect(screen.getAllByText(/^Iteration \d/).map((s) => s.textContent)).toEqual(["Iteration 1 of 2", "Iteration 2 of 2"]);
  const wrap = screen.getByRole("region", { name: "Wrap up" });
  expect(wrap.closest("details")).toBeNull();
});

test("without the list's value the iterations are numbered without a total", () => {
  seconds = 0;
  show([row("s1", "n_each", 0, { status: "running" }), row("s2", "n_sum", 1, { status: "running", finishedAt: null })]);
  expect(screen.getAllByText(/^Iteration \d/).map((s) => s.textContent)).toEqual(["Iteration 1"]);
});
