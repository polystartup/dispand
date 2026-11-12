import { parseList } from "@dispand/domain/workflows/loop";
import { nodesOf, type LoopStep, type WorkflowDef } from "@dispand/domain/workflows/model";
import type { ReactNode } from "react";
import type { RunSnapshot } from "../../lib/run-state.ts";
import { duration, Status, when } from "../workflow/Runs.tsx";

type Step = RunSnapshot["steps"][number];

/**
 * One run's steps as they went: each step's prompt, outputs, error, transcript and questions, to
 * debug it. A loop's body steps are grouped under it by iteration, the latest one open. Names are
 * the run's version's (`def`): the workflow may have changed since.
 */
export function RunSteps({ state, def, agentNames }: { state: RunSnapshot; def: WorkflowDef | undefined; agentNames: Map<string, string> }) {
  const nodes = def ? nodesOf(def) : [];
  const order = new Map(nodes.map((n, i) => [n.id, i]));
  // In the order they ran (the definition's order isn't the graph's), steps not started yet last.
  // A button trigger completes without starting a session: its finish stands for its start.
  const at = (s: Step) => (s.startedAt ?? s.finishedAt)?.getTime() ?? Infinity;
  const steps = [...state.steps].sort(
    (a, b) => at(a) - at(b) || a.iteration - b.iteration || (order.get(a.nodeId) ?? Infinity) - (order.get(b.nodeId) ?? Infinity),
  );
  const loopOf = (s: Step) => (s.iteration > 0 ? nodes.find((n) => n.id === s.nodeId)?.loopId : undefined);
  const card = (step: Step) => {
    const node = nodes.find((n) => n.id === step.nodeId);
    return <StepCard step={step} name={node?.name ?? step.nodeId} agent={node?.agentId ? (agentNames.get(node.agentId) ?? "Deleted agent") : null} state={state} />;
  };

  return (
    <ol className="flex flex-col gap-4">
      {steps
        .filter((s) => loopOf(s) === undefined)
        .map((step) => {
          const loop = def?.steps.find((s): s is LoopStep => s.id === step.nodeId && s.type === "loop");
          return (
            <li key={step.id}>
              {card(step)}
              {loop && <Iterations loop={loop} step={step} body={steps.filter((s) => loopOf(s) === loop.id)} state={state} card={card} />}
            </li>
          );
        })}
    </ol>
  );
}

/** How many iterations a loop has: what it counted once done, else its list's length (unknown until the list is). */
function iterationCount(loop: LoopStep, step: Step, state: RunSnapshot): number | null {
  const counted = Number(step.outputs?.count);
  if (step.outputs?.count !== undefined && Number.isInteger(counted)) return counted;
  if (!loop.list) return null;
  const value = state.steps.find((s) => s.nodeId === loop.list!.nodeId && s.iteration === 0)?.outputs?.[loop.list.name];
  const list = value === undefined ? null : parseList(value);
  return list && "items" in list ? list.items.length : null;
}

/** A loop's body steps by iteration; only the latest is open. */
function Iterations({ loop, step, body, state, card }: { loop: LoopStep; step: Step; body: Step[]; state: RunSnapshot; card: (step: Step) => ReactNode }) {
  const iterations = [...new Set(body.map((s) => s.iteration))].sort((a, b) => a - b);
  const latest = iterations.at(-1);
  const total = iterationCount(loop, step, state);
  return (
    <ol className="ml-4 mt-3 flex flex-col gap-3 border-l-2 border-line pl-4" aria-label="Iterations">
      {iterations.map((i) => (
        <li key={i}>
          <details open={i === latest}>
            <summary className="cursor-pointer text-[13px] font-medium">{total === null ? `Iteration ${i}` : `Iteration ${i} of ${total}`}</summary>
            <ol className="mt-3 flex flex-col gap-4">
              {body
                .filter((s) => s.iteration === i)
                .map((s) => (
                  <li key={s.id}>{card(s)}</li>
                ))}
            </ol>
          </details>
        </li>
      ))}
    </ol>
  );
}

function StepCard({ step, name, agent, state }: { step: Step; name: string; agent: string | null; state: RunSnapshot }) {
  const transcript = state.messages.filter((m) => m.stepRunId === step.id);
  // A consult shows once, in the page's Consults section.
  const asked = state.questions.filter((q) => q.stepRunId === step.id && q.payload.kind !== "consult");
  return (
    <section aria-label={name} className="rounded-2xl bg-surface px-5 py-4 shadow-card">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-[16px] font-medium">
          {name}
          {agent && <span className="ml-2 text-[13px] font-normal text-muted">{agent}</span>}
        </h2>
        <span className="flex items-center gap-2 text-[13px] text-muted">
          <Status status={step.queuedAt ? "queued" : step.status} />
          {step.queuedAt && <span>· since {when.format(step.queuedAt)}</span>}
          {step.startedAt && (
            <span>
              · {when.format(step.startedAt)} · {step.finishedAt ? duration(step.startedAt, step.finishedAt) : "still going"}
            </span>
          )}
        </span>
      </header>
      {step.error && <p className="mt-2 whitespace-pre-wrap text-[14px] text-danger">{step.error}</p>}
      <div className="mt-3 flex flex-col gap-2">
        {step.outputs && (
          <Fold title="Outputs" open>
            <Json value={step.outputs} />
          </Fold>
        )}
        {step.prompt !== null && (
          <Fold title="Prompt">
            <pre className="whitespace-pre-wrap break-words text-[13px]">{step.prompt}</pre>
          </Fold>
        )}
        {transcript.length > 0 && (
          <Fold title={`Transcript (${transcript.length})`}>
            <ol className="flex flex-col gap-2">
              {transcript.map((m) => (
                <li key={m.id} className="text-[13px]">
                  <span className="mr-2 font-medium capitalize text-muted">{m.role}</span>
                  <span className="whitespace-pre-wrap break-words">{m.text}</span>
                </li>
              ))}
            </ol>
          </Fold>
        )}
        {asked.length > 0 && (
          <Fold title={`Questions (${asked.length})`}>
            <ol className="flex flex-col gap-3">
              {asked.map((q) => (
                <li key={q.id} className="flex flex-col gap-1">
                  <Status status={q.status} />
                  <Json value={q.payload} />
                  {q.answer && (
                    <>
                      <span className="text-[13px] font-medium text-muted">Answer</span>
                      <Json value={q.answer} />
                    </>
                  )}
                </li>
              ))}
            </ol>
          </Fold>
        )}
      </div>
    </section>
  );
}

function Fold({ title, open, children }: { title: string; open?: boolean; children: ReactNode }) {
  return (
    <details open={open} className="rounded-xl bg-hover px-4 py-2">
      <summary className="cursor-pointer text-[13px] font-medium">{title}</summary>
      <div className="mt-2 pb-1">{children}</div>
    </details>
  );
}

function Json({ value }: { value: unknown }) {
  return <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[13px]">{JSON.stringify(value, null, 2)}</pre>;
}
