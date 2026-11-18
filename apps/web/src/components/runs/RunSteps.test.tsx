// @vitest-environment jsdom
import { stored } from "@dispand/domain/messages/index.ts";
import { addStep, defaultWorkflowDef, type WorkflowDef } from "@dispand/domain/workflows/model";
import { cleanup, render, screen, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, test, vi } from "vitest";
import { createI18n } from "../../lib/i18n.ts";
import type { RunSnapshot } from "../../lib/run-state.ts";
import "../../test/jsdom-shims.ts";
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
    queuedAt: null,
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

test("a step waiting for a slot of its harness shows as queued", () => {
  seconds = 0;
  show([row("s0", "n_brief", 0, { status: "pending", startedAt: null, finishedAt: null, queuedAt: new Date(2026, 10, 7, 9, 0, 0) })]);
  const card = screen.getByRole("region", { name: /./ });
  expect(within(card).getByText("queued")).toBeTruthy();
  expect(within(card).getByText(/since/)).toBeTruthy();
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

test("a consult is not listed among a step's questions: the Consults section shows it", () => {
  seconds = 0;
  const q = (id: string, payload: unknown) => ({ id, runId: "run_1", stepRunId: "s0", status: "pending", payload, answer: null }) as unknown as RunSnapshot["questions"][number];
  const consult = q("q1", { kind: "consult", agentId: "agent_2", question: "Which plan?" });
  const ask = q("q2", { kind: "choice", questions: [] });
  const withQuestions = (questions: RunSnapshot["questions"]) => (
    <RunSteps state={{ ...snapshot([row("s0", "n_brief", 0)]), questions }} def={workflow()} agentNames={new Map()} />
  );
  const { rerender } = render(withQuestions([consult, ask]));
  expect(screen.getByText("Questions (1)")).toBeTruthy();
  expect(screen.queryByText(/Which plan\?/)).toBeNull();
  rerender(withQuestions([consult]));
  expect(screen.queryByText(/Questions \(/)).toBeNull();
  expect(screen.queryByText(/Which plan\?/)).toBeNull();
});

test("the steps are in French: iterations, status, the running time and the fold titles", () => {
  seconds = 0;
  render(
    <I18nextProvider i18n={createI18n("fr")}>
      <RunSteps
        state={snapshot([row("s0", "n_brief", 0, { outputs: { items: '["a","b"]' } }), row("s1", "n_each", 0, { status: "running", finishedAt: null }), row("s2", "n_sum", 1, { status: "waiting", finishedAt: null })])}
        def={workflow()}
        agentNames={new Map()}
      />
    </I18nextProvider>,
  );
  expect(screen.getByText("Itération 1 sur 2")).toBeTruthy();
  expect(screen.getAllByText("Sorties").length).toBeGreaterThan(0);
  expect(screen.getAllByText(/toujours en cours/).length).toBeGreaterThan(0);
  expect(screen.getByText("en attente d’une réponse")).toBeTruthy();
});

test("a failure stored as a key shows in the page's language, a plain one from before as stored", () => {
  seconds = 0;
  const failed = (id: string, error: string) => row(id, "n_wrap", 0, { status: "failed", error });
  render(
    <I18nextProvider i18n={createI18n("fr")}>
      <RunSteps state={snapshot([failed("s1", stored("tools.fail.timeout", { host: "mcp.example.com" })), failed("s2", "The tool no longer exists")])} def={workflow()} agentNames={new Map()} />
    </I18nextProvider>,
  );
  expect(screen.getByText("mcp.example.com n’a pas répondu à temps.")).toBeTruthy();
  expect(screen.getByText("The tool no longer exists")).toBeTruthy();
});

test("a step's transcript is the chat's thread, read-only: the owner's words with their files, the tools used, the agent's formatted text", async () => {
  seconds = 0;
  const msg = (id: string, role: "user" | "assistant" | "tool", text: string, s: number, files?: { id: string; name: string }[]) =>
    ({ id, runId: "run_1", stepRunId: "s0", role, text, createdAt: new Date(2026, 10, 7, 9, 1, s), ...(files ? { files } : {}) }) as unknown as RunSnapshot["messages"][number];
  const fetch = vi.spyOn(globalThis, "fetch");
  const messages = [
    msg("m1", "user", "Plan my day", 1, [{ id: "att_1", name: "agenda.pdf" }]),
    msg("m2", "tool", "Read agenda.pdf", 2),
    msg("m3", "assistant", "Here is **the plan**.\n\n![tracker](https://evil.example/pixel.png)\n\n[see](https://evil.example/page)", 3),
  ];
  const { container } = render(<RunSteps state={{ ...snapshot([row("s0", "n_brief", 0)]), messages }} def={workflow()} agentNames={new Map()} />);
  const fold = screen.getByText("Transcript (3)").closest("details")!;
  const items = within(fold).getAllByRole("listitem");
  expect(items).toHaveLength(3);
  expect(within(items[0]!).getByText("Plan my day")).toBeTruthy();
  expect(within(items[0]!).getByText("agenda.pdf")).toBeTruthy();
  expect(items[1]!.textContent).toBe("Read agenda.pdf");
  expect((await within(items[2]!).findByText("the plan")).tagName).toBe("STRONG");
  // Agent text loads nothing: the remote image is not an <img>, the link is a button that names where it goes.
  expect(container.querySelector("img")).toBeNull();
  expect(items[2]!.querySelector("a[href]")).toBeNull();
  expect(within(items[0]!).getByRole("link", { name: "Download agenda.pdf" }).getAttribute("href")).toBe("/files/att_1");
  expect(within(items[2]!).getByText("[image not shown: tracker]")).toBeTruthy();
  expect(within(items[2]!).getByRole("button", { name: /see/ }).getAttribute("title")).toBe("https://evil.example/page");
  // Read-only: no composer.
  expect(within(fold).queryByRole("textbox")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
