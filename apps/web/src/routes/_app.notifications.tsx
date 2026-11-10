import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Empty } from "../components/settings/parts.tsx";
import { PageHeader } from "../components/Placeholder.tsx";
import { notificationPermission } from "../components/shell/NotificationsBell.tsx";
import { QuestionForm } from "../components/questions/QuestionForm.tsx";
import { api, orpc } from "../lib/api.ts";

export const Route = createFileRoute("/_app/notifications")({ component: Notifications });

type Item = Awaited<ReturnType<typeof api.questions.list>>[number];

function Notifications() {
  const questions = useQuery(orpc.questions.list.queryOptions({ input: { status: "pending" } }));
  return (
    <>
      <PageHeader title="Notifications" subtitle="Questions from your agents that wait for you." />
      {questions.error && !questions.data && <p role="alert" className="text-[14px] text-danger">Could not load the questions.</p>}
      {questions.data?.length === 0 && (
        <Empty title="Nothing waits for you" text="When an agent needs a decision, it shows up here.">
          <span />
        </Empty>
      )}
      <ul className="flex flex-col gap-4">
        {questions.data?.map((q) => (
          <li key={q.id}>
            <Card q={q} />
          </li>
        ))}
      </ul>
      <BrowserOptIn />
    </>
  );
}

function Card({ q }: { q: Item }) {
  const queryClient = useQueryClient();
  const [conflict, setConflict] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.questions.key() });
  const answer = useMutation(
    orpc.questions.answer.mutationOptions({
      onError: (error) => {
        if ((error as { code?: string }).code !== "CONFLICT") return;
        // Answered elsewhere (the chat, another tab): say so before the card goes.
        setConflict(true);
        setTimeout(refresh, 2500);
      },
      onSuccess: refresh,
    }),
  );
  // A workflow run's question names its workflow, a Job's its agent.
  const from = (q.workflow ?? q.agent)?.name ?? "Run";
  return (
    <article aria-label={`Question from ${from}`} className="rounded-2xl bg-surface p-5 shadow-card">
      <p className="mb-4 text-[13px] text-muted">
        {from} <span aria-hidden>·</span> run {q.run.id.slice(-6)} <span aria-hidden>·</span> {q.step.name}
        {q.placement === "chat" && (
          <>
            {" "}
            <span aria-hidden>·</span> <span className="rounded-full bg-hover px-2 py-0.5 text-[12px]">Asked in a chat</span>
          </>
        )}
      </p>
      {conflict ? (
        <p role="status" className="text-[14px] text-muted">
          This question was already answered elsewhere.
        </p>
      ) : (
        <QuestionForm
          question={q}
          busy={answer.isPending}
          error={answer.error?.message ?? null}
          onAnswer={(a) => answer.mutate({ questionId: q.id, answer: a })}
        />
      )}
    </article>
  );
}

/** Opt-in: the browser asks only when the owner clicks, and nothing here is needed for the app. */
function BrowserOptIn() {
  // Read after hydration: the server can't know the browser's permission.
  const [permission, setPermission] = useState<ReturnType<typeof notificationPermission> | null>(null);
  useEffect(() => setPermission(notificationPermission()), []);
  if (permission === null) return null;
  if (permission === "unsupported") {
    return <p className="mt-8 text-[13px] text-faint">Browser notifications need HTTPS or localhost. The bell still counts what waits.</p>;
  }
  return (
    <div className="mt-8 flex items-center justify-between gap-4 rounded-2xl bg-surface px-5 py-4 shadow-card">
      <div>
        <p className="text-[15px] font-medium">Browser notifications</p>
        <p className="text-[13px] text-muted">
          {permission === "granted" ? "On: this browser tells you when an agent asks." : permission === "denied" ? "Blocked in this browser's settings." : "Get told when an agent asks, even in another tab."}
        </p>
      </div>
      {permission === "default" && (
        <Button
          variant="outline"
          onClick={() => {
            try {
              void Notification.requestPermission().then(setPermission, () => {});
            } catch {
              // Not available here: leave it off.
            }
          }}
        >
          Turn on
        </Button>
      )}
    </div>
  );
}
