import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { orpc } from "../../lib/api.ts";
import { Status } from "../workflow/Runs.tsx";

/** What a consult's state reads as. */
const stateText = { waiting: "waiting", answered: "answered", failed: "no answer", ended: "ended" } as const;

/**
 * A Job's consults (design 6.13): the one that made it, with the asking Job to go to, and those it
 * asked, each with the agent consulted, the consulted Job to go to once there is one, and the
 * question and the answer, or the reason there is none. Nothing here answers a consult: no one does
 * but the consulted Job.
 */
export function RunConsults({ runId, live }: { runId: string; live: boolean }) {
  const consults = useQuery({
    ...orpc.jobs.consults.queryOptions({ input: { runId } }),
    // A Job still going may ask, or be answered, at any time.
    refetchInterval: live ? 5000 : false,
  });
  const { asked, answering } = consults.data ?? { asked: [], answering: null };
  if (!answering && asked.length === 0) return null;

  return (
    <section aria-label="Consults" className="mb-6 flex flex-col gap-3">
      {answering && (
        <div className="rounded-2xl bg-surface px-5 py-4 shadow-card">
          <h2 className="text-[16px] font-medium">
            Consulted by {answering.agent}
            {" · "}
            <Link to="/settings/workflows/runs/$runId" params={{ runId: answering.runId }} className="text-[14px] font-normal text-accent hover:underline">
              Open its Job
            </Link>
          </h2>
          <p className="mt-2 whitespace-pre-wrap break-words text-[14px]">{answering.question}</p>
        </div>
      )}
      {asked.map((c) => (
        <div key={c.questionId} className="rounded-2xl bg-surface px-5 py-4 shadow-card">
          <h2 className="flex flex-wrap items-baseline gap-x-2 text-[16px] font-medium">
            Consulted {c.agent}
            <Status status={stateText[c.state]} />
            {c.runId && (
              <Link to="/settings/workflows/runs/$runId" params={{ runId: c.runId }} className="text-[14px] font-normal text-accent hover:underline">
                Open its Job
              </Link>
            )}
          </h2>
          <p className="mt-2 whitespace-pre-wrap break-words text-[14px]">{c.question}</p>
          {c.answer !== null && (
            <>
              <span className="mt-3 block text-[13px] font-medium text-muted">{c.state === "answered" ? "Answer" : "Why there is none"}</span>
              <p className="whitespace-pre-wrap break-words text-[14px]">{c.answer || "(empty)"}</p>
            </>
          )}
        </div>
      ))}
    </section>
  );
}
