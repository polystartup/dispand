import { parseList } from "@dispand/domain/workflows/loop";
import { nodesOf, type LoopStep, type WorkflowDef } from "@dispand/domain/workflows/model";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useFormat } from "../../lib/format.ts";
import { useStored } from "../../lib/message.ts";
import type { RunSnapshot } from "../../lib/run-state.ts";
import { ChatTranscript } from "../chat/Thread.tsx";
import { ConsentPrompt } from "../questions/ConsentPrompt.tsx";
import { Status } from "../workflow/Runs.tsx";

type Step = RunSnapshot["steps"][number];

/**
 * One run's steps as they went: each step's prompt, outputs, error, transcript and questions, to
 * debug it. A loop's body steps are grouped under it by iteration, the latest one open. Names are
 * the run's version's (`def`): the workflow may have changed since.
 */
export function RunSteps({ state, def, agentNames, peopleNames = new Map() }: { state: RunSnapshot; def: WorkflowDef | undefined; agentNames: Map<string, string>; /** Members by id: whom an escalation went to. */ peopleNames?: Map<string, string> }) {
  const { t } = useTranslation("runs");
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
    return <StepCard step={step} name={node?.name ?? step.nodeId} agent={node?.agentId ? (agentNames.get(node.agentId) ?? t("deletedAgent")) : null} state={state} peopleNames={peopleNames} />;
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
  const { t } = useTranslation("runs");
  const iterations = [...new Set(body.map((s) => s.iteration))].sort((a, b) => a - b);
  const latest = iterations.at(-1);
  const total = iterationCount(loop, step, state);
  return (
    <ol className="ml-4 mt-3 flex flex-col gap-3 border-l-2 border-line pl-4" aria-label={t("iterations")}>
      {iterations.map((i) => (
        <li key={i}>
          <details open={i === latest}>
            <summary className="cursor-pointer text-[13px] font-medium">{total === null ? t("iteration", { i }) : t("iterationOf", { i, total })}</summary>
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

function StepCard({ step, name, agent, state, peopleNames }: { step: Step; name: string; agent: string | null; state: RunSnapshot; peopleNames: Map<string, string> }) {
  const { t } = useTranslation("runs");
  const format = useFormat();
  const stored = useStored();
  const when = format.dateTimeSeconds;
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
          {step.queuedAt && <span>· {t("since", { when: when(step.queuedAt) })}</span>}
          {step.startedAt && (
            <span>
              · {when(step.startedAt)} · {step.finishedAt ? format.duration(step.startedAt, step.finishedAt) : t("stillGoing")}
            </span>
          )}
        </span>
      </header>
      {step.credential && (
        <p className="mt-1 text-[13px] text-muted">
          {t(`credential.${step.credential}`)}
          {step.paused && <span role="status" className="ml-2 text-fg">{t(`paused.${step.paused}`)}</span>}
        </p>
      )}
      {step.error && <p className="mt-2 whitespace-pre-wrap text-[14px] text-danger">{stored(step.error)}</p>}
      <div className="mt-3 flex flex-col gap-2">
        {step.outputs && (
          <Fold title={t("outputs")} open>
            <Json value={step.outputs} />
          </Fold>
        )}
        {step.prompt !== null && (
          <Fold title={t("prompt")}>
            <pre className="whitespace-pre-wrap break-words text-[13px]">{step.prompt}</pre>
          </Fold>
        )}
        {transcript.length > 0 && (
          <Fold title={t("transcript", { count: transcript.length })}>
            <ChatTranscript messages={transcript} />
          </Fold>
        )}
        {asked.length > 0 && (
          <Fold title={t("questions", { count: asked.length })} open={asked.some((q) => q.yoursToConsent || q.recovery)}>
            <ol className="flex flex-col gap-3">
              {asked.map((q) => (
                <li key={q.id} className="flex flex-col gap-1">
                  <Status status={q.status} />
                  {/* An escalation: whom it is addressed to now, and on which hop. */}
                  {q.escalation && <span className="text-[13px] text-muted">{q.escalation.hop === 0 ? t("askedStarter", { name: peopleNames.get(q.escalation.addresseeId) ?? t("formerMember") }) : t("escalatedTo", { name: peopleNames.get(q.escalation.addresseeId) ?? t("formerMember"), hop: q.escalation.hop })}</span>}
                  <Json value={q.payload} />
                  {q.answer && (
                    <>
                      <span className="text-[13px] font-medium text-muted">{t("answer")}</span>
                      <Json value={q.answer} />
                    </>
                  )}
                  <ConsentPrompt question={q} />
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
