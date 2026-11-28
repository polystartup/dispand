import { storedText } from "@dispand/domain/messages/index.ts";
import { nodesOf, type WorkflowDef } from "@dispand/domain/workflows/model";
import { ChevronDown } from "lucide-react";
import { Collapsible } from "radix-ui";
import { type ReactNode, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useFormat } from "../../lib/format.ts";
import { useStored } from "../../lib/message.ts";
import { canReopen, type RunSnapshot } from "../../lib/run-state.ts";

type Step = RunSnapshot["steps"][number];

/**
 * Stopped work, inspected where it stopped: its stopped state, what it had completed, what was recorded and
 * when, the ids to find it by and what to do next. Only what the run's snapshot holds, and no recovery action:
 * nothing here runs it again.
 */
export function StoppedWork({ run, def }: { run: RunSnapshot; def: WorkflowDef | undefined }) {
  const { t } = useTranslation(["chat", "common"]);
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  function close() {
    setOpen(false);
    opener.current?.focus({ preventScroll: true });
    // Back into view if the person scrolled away from it, moving no further than that takes.
    opener.current?.scrollIntoView({ block: "nearest" });
  }
  return (
    <Collapsible.Root
      open={open}
      onOpenChange={(next) => (next ? setOpen(true) : close())}
      onKeyDown={(event) => {
        if (open && event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          close();
        }
      }}
      className="mt-2"
    >
      <Collapsible.Trigger asChild>
        <Button ref={opener} type="button" variant="outline" className="group">
          {t("stoppedWork.open")}
          <ChevronDown aria-hidden className="group-data-[state=open]:rotate-180" />
        </Button>
      </Collapsible.Trigger>
      <Collapsible.Content className="mt-2 space-y-4 rounded-[10px] bg-soft p-4 text-[13px] [overflow-wrap:anywhere]">
        <Details run={run} def={def} />
        <Button type="button" variant="ghost" className="hover:bg-surface" onClick={close}>
          {t("common:actions.close")}
        </Button>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

/** The code of a stored failure: its message's key. Words that came from outside have none. */
function codeOf(error: string | null) {
  const stored = error ? storedText(error) : null;
  return stored && "key" in stored ? stored.key : null;
}

function Details({ run, def }: { run: RunSnapshot; def: WorkflowDef | undefined }) {
  const { t } = useTranslation("chat");
  const format = useFormat();
  const stored = useStored();
  const names = new Map(def ? nodesOf(def).map((n) => [n.id, n.name]) : []);
  const name = (step: Step) => names.get(step.nodeId) ?? t("step");
  const failed = run.steps.filter((s) => s.status === "failed");
  // Only what is known to be complete: a reply may have been cut short, and a tool call is recorded as it starts.
  const completed = [
    ...run.steps.filter((s) => s.status === "succeeded").map((s) => ({ key: s.id, text: t("stoppedWork.finished", { name: name(s) }) })),
    ...run.messages.flatMap((m) => (m.result && "artifactId" in m.result ? [{ key: m.id, text: t("stoppedWork.shown", { title: m.result.title }) }] : [])),
  ];
  const stoppedAt = run.run.finishedAt ?? failed.at(-1)?.finishedAt;
  // Each reason once: a step's failure is usually the run's too.
  const reasons = [...new Set([...failed.map((s) => s.error), run.run.error].filter((e) => e !== null))];
  const codes = [...new Set(reasons.map(codeOf).filter((c) => c !== null))];
  const ids: [string, string[]][] = [
    [t(run.run.source === "agent" ? "stoppedWork.jobId" : "stoppedWork.runId"), [run.run.id]],
    [t("stoppedWork.stepId"), failed.map((s) => s.id)],
    [t("stoppedWork.errorCode"), codes],
  ];
  return (
    <>
      <Part title={stoppedAt ? t("stoppedWork.stoppedAt", { when: format.dateTimeSeconds(stoppedAt) }) : t("stoppedWork.stopped")}>
        {reasons.length === 0 ? <p>{t("stoppedWork.noReason")}</p> : reasons.map((reason) => <p key={reason}>{stored(reason)}</p>)}
      </Part>
      <Part title={t("stoppedWork.completed")}>
        {completed.length === 0 ? (
          <p>{t("stoppedWork.nothing")}</p>
        ) : (
          <ul>
            {completed.map((done) => (
              <li key={done.key}>{done.text}</li>
            ))}
          </ul>
        )}
      </Part>
      <Activity run={run} name={name} />
      <Part title={t("stoppedWork.ids")}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {ids
            .filter(([, values]) => values.length > 0)
            .map(([label, values]) => (
              <div key={label} className="contents">
                <dt className="text-muted">{label}</dt>
                <dd className="font-mono">
                  {values.map((value) => (
                    <span key={value} className="block">
                      {value}
                    </span>
                  ))}
                </dd>
              </div>
            ))}
        </dl>
      </Part>
      <Part title={t("stoppedWork.next")}>
        <p>{t(canReopen(run) ? "stoppedWork.sendMessage" : "stoppedWork.startAnew")}</p>
      </Part>
    </>
  );
}

/** What the run recorded, oldest first: its steps' starts and ends, its messages and its questions. */
function Activity({ run, name }: { run: RunSnapshot; name: (step: Step) => string }) {
  const { t } = useTranslation("chat");
  const format = useFormat();
  const message = (m: RunSnapshot["messages"][number]) => {
    if (m.role === "user") return t("stoppedWork.sent");
    if (m.role === "assistant") return t("stoppedWork.replied");
    return m.result && "artifactId" in m.result ? t("stoppedWork.shown", { title: m.result.title }) : t("stoppedWork.called", { name: m.text });
  };
  const events = [
    ...run.steps.flatMap((s) => [
      ...(s.startedAt ? [{ key: `${s.id}:start`, at: s.startedAt, text: t("stoppedWork.started", { name: name(s) }) }] : []),
      ...(s.finishedAt && (s.status === "succeeded" || s.status === "failed")
        ? [{ key: `${s.id}:end`, at: s.finishedAt, text: t(s.status === "failed" ? "stoppedWork.failed" : "stoppedWork.finished", { name: name(s) }) }]
        : []),
    ]),
    ...run.messages.map((m) => ({ key: m.id, at: m.createdAt, text: message(m) })),
    ...run.questions.map((q) => ({
      key: q.id,
      at: q.createdAt,
      text: t(q.payload.kind === "consult" ? "stoppedWork.consulted" : q.status === "answered" ? "stoppedWork.asked" : "stoppedWork.unanswered"),
    })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
  return (
    <Part title={t("stoppedWork.activity")}>
      <ol className="space-y-1">
        {events.map((event) => (
          <li key={event.key} className="flex flex-wrap gap-x-3">
            <time dateTime={event.at.toISOString()} className="text-muted">
              {format.dateTimeSeconds(event.at)}
            </time>
            <span>{event.text}</span>
          </li>
        ))}
      </ol>
    </Part>
  );
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId}>
      <h4 id={titleId} className="mb-1 font-semibold">
        {title}
      </h4>
      {children}
    </section>
  );
}
