import type { Answer, QuestionPayload } from "@dispand/runner-protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { type api, orpc } from "../../lib/api.ts";
import { when } from "../workflow/Runs.tsx";
import { ProposalItems } from "./ProposalItems.tsx";
import { type About, approvalWords, checkpointInput, QuestionForm } from "./QuestionForm.tsx";

export type InboxEntry = Awaited<ReturnType<typeof api.questions.list>>[number];

/** What was asked, in a line or two, for an item that is done. */
function askedText(payload: QuestionPayload, about?: About | null, rootId?: string | null): string {
  if (rootId) {
    const c = checkpointInput(payload);
    return `Checkpoint: ${c.root} had led to ${c.jobs} Jobs`;
  }
  if (payload.kind === "choice") return payload.questions.map((q) => q.question).join(" · ");
  const words = approvalWords(payload);
  if (words !== null) return `Asked: ${words}`;
  if (payload.kind === "permission") {
    const input = typeof payload.input === "string" ? payload.input : JSON.stringify(payload.input);
    return `Wanted to use ${about ? `${about.tool}: ${about.action}` : payload.toolName}${input && input !== "{}" ? `: ${input}` : ""}`;
  }
  return "Asked to confirm its values";
}

/** The answer in the owner's words. */
export function answerLine(answer: Answer, payload?: QuestionPayload, rootId?: string | null): string {
  if (rootId && answer.kind === "permission") return { allow: "Went on", "allow-always": "Went on, without asking again", deny: "Stopped" }[answer.decision];
  // An approval asked in words is approved or denied; a tool call is allowed or denied.
  if (payload && approvalWords(payload) !== null && answer.kind === "permission" && answer.decision !== "deny") return "Approved";
  if (answer.kind === "choice") {
    return Object.entries(answer.answers)
      .map(([question, given]) => `“${question}”: ${Array.isArray(given) ? given.join(", ") : given}`)
      .join(" · ");
  }
  if (answer.kind === "permission") {
    if (answer.decision === "deny") return answer.message ? `Denied: ${answer.message}` : "Denied";
    return answer.decision === "allow-always" ? "Allowed, always" : "Allowed";
  }
  return answer.confirmed ? "Confirmed" : answer.feedback ? `Not confirmed: ${answer.feedback}` : "Not confirmed";
}

/** One Question or Approval of the Inbox: answerable while it waits, then shown with its answer, who gave it and when. */
export function InboxItem({ item }: { item: InboxEntry }) {
  const queryClient = useQueryClient();
  const [conflict, setConflict] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.questions.key() });
  const answer = useMutation(
    orpc.questions.answer.mutationOptions({
      onError: (error) => {
        if ((error as { code?: string }).code !== "CONFLICT") return;
        // Answered elsewhere (the chat, another tab): say so before the card moves to Done.
        setConflict(true);
        setTimeout(refresh, 2500);
      },
      onSuccess: refresh,
    }),
  );
  // A workflow run's item names its workflow, a Job's its agent and its trigger.
  const from = (item.workflow ?? item.agent)?.name ?? "Run";
  const tag = item.kind === "approval" ? "Approval" : "Question";
  const open = item.status === "pending";
  return (
    <article aria-label={`${tag} from ${from}`} className="rounded-2xl bg-surface p-5 shadow-card">
      <p className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted">
        <span className="rounded-full bg-hover px-2 py-0.5 text-[12px] font-medium text-fg">{tag}</span>
        <span>{from}</span>
        {item.trigger && (
          <>
            <span aria-hidden>·</span> <span>{item.trigger.name}</span>
          </>
        )}
        {/* A Job's one step is named after its agent: said once. */}
        {item.step.name !== from && (
          <>
            <span aria-hidden>·</span> <span>{item.step.name}</span>
          </>
        )}
        {item.placement === "chat" && (
          <>
            <span aria-hidden>·</span> <span className="rounded-full bg-hover px-2 py-0.5 text-[12px]">Asked in a chat</span>
          </>
        )}
        <span aria-hidden>·</span>
        <Link to="/settings/workflows/runs/$runId" params={{ runId: item.run.id }} className="text-accent hover:underline">
          Open the run
        </Link>
      </p>
      {open && conflict ? (
        <p role="status" className="text-[14px] text-muted">
          This was already answered elsewhere.
        </p>
      ) : open ? (
        <QuestionForm question={item} busy={answer.isPending} error={answer.error?.message ?? null} onAnswer={(a) => answer.mutate({ questionId: item.id, answer: a })} />
      ) : (
        <div className="space-y-2 text-[14px]">
          <p className="whitespace-pre-wrap break-words text-muted">{askedText(item.payload, item.about, item.rootId)}</p>
          {item.proposal && <ProposalItems proposal={item.proposal} />}
          {item.status === "answered" && item.answer ? (
            <>
              <p className="font-medium">{answerLine(item.answer, item.payload, item.rootId)}</p>
              <p className="text-[13px] text-faint">
                {item.answeredBy?.type === "agent" ? (
                  <>
                    Answered by the agent {item.answeredBy.name} ·{" "}
                    <Link to="/settings/workflows/runs/$runId" params={{ runId: item.answeredBy.runId }} className="text-accent hover:underline">
                      Open its Job
                    </Link>
                  </>
                ) : (
                  <>Answered{item.answeredBy?.type === "user" ? " by you" : ""}</>
                )}
                {item.answeredAt ? ` · ${when.format(item.answeredAt)}` : ""}
              </p>
            </>
          ) : (
            <p className="text-[13px] text-faint">{item.orphaned ? "Expired: the agent was restarted and asked again." : "Expired: its run ended before an answer."}</p>
          )}
        </div>
      )}
    </article>
  );
}
