import type { Answer, QuestionPayload } from "@dispand/runner-protocol";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export type QuestionFormProps = {
  question: { payload: QuestionPayload; orphaned?: boolean };
  onAnswer: (answer: Answer) => void;
  /** An answer is being sent: the form can't be submitted again. */
  busy?: boolean;
  error?: string | null;
};

/** Renders what an agent asks and hands back the owner's answer. Presentational: sending is the caller's. */
export function QuestionForm({ question, onAnswer, busy, error }: QuestionFormProps) {
  const { payload } = question;
  return (
    <div className="flex flex-col gap-4">
      {question.orphaned && (
        <p className="rounded-lg bg-hover px-3 py-2 text-[13px] text-muted">
          The agent was restarted since it asked. Your answer will reach it as a message.
        </p>
      )}
      {payload.kind === "choice" && <Choice payload={payload} onAnswer={onAnswer} busy={busy} />}
      {payload.kind === "permission" && <Permission payload={payload} onAnswer={onAnswer} busy={busy} />}
      {payload.kind === "confirm-outputs" && <Confirm payload={payload} onAnswer={onAnswer} busy={busy} />}
      {error && (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

type Part<P extends QuestionPayload> = { payload: P; onAnswer: (answer: Answer) => void; busy?: boolean };

type Pick = { labels: string[]; other: boolean; text: string };

function Choice({ payload, onAnswer, busy }: Part<Extract<QuestionPayload, { kind: "choice" }>>) {
  const id = useId();
  const [picks, setPicks] = useState<Pick[]>(() => payload.questions.map(() => ({ labels: [], other: false, text: "" })));
  const update = (i: number, patch: Partial<Pick>) => setPicks((all) => all.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const given = (i: number) => {
    const p = picks[i]!;
    return [...p.labels, ...(p.other && p.text.trim() ? [p.text.trim()] : [])];
  };
  const ready = payload.questions.every((_, i) => given(i).length > 0);

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        onAnswer({
          kind: "choice",
          answers: Object.fromEntries(payload.questions.map((q, i) => [q.question, q.multiSelect ? given(i) : given(i)[0]!])),
        });
      }}
    >
      {payload.questions.map((q, i) => {
        const p = picks[i]!;
        const name = `${id}-${i}`;
        const type = q.multiSelect ? "checkbox" : "radio";
        const toggle = (label: string) =>
          update(i, q.multiSelect ? { labels: p.labels.includes(label) ? p.labels.filter((l) => l !== label) : [...p.labels, label] } : { labels: [label], other: false });
        return (
          <fieldset key={i} className="flex flex-col gap-2">
            <legend className="mb-1 text-[15px] font-medium">{q.question}</legend>
            {q.options.map((o) => (
              <label key={o.label} className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-hover">
                <input
                  type={type}
                  name={name}
                  checked={p.labels.includes(o.label)}
                  onChange={() => toggle(o.label)}
                  className="mt-1 size-4 accent-[var(--color-accent)]"
                />
                <span>
                  <span className="block text-[14px]">{o.label}</span>
                  {o.description && <span className="block text-[13px] text-muted">{o.description}</span>}
                </span>
              </label>
            ))}
            <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
              <input
                type={type}
                name={name}
                aria-label="Other"
                checked={p.other}
                onChange={() => update(i, q.multiSelect ? { other: !p.other } : { other: true, labels: [] })}
                className="size-4 accent-[var(--color-accent)]"
              />
              <Input
                aria-label={`Other: ${q.question}`}
                placeholder="Other…"
                value={p.text}
                onChange={(e) => update(i, { text: e.target.value, other: true, ...(q.multiSelect ? {} : { labels: [] }) })}
                className="h-8"
              />
            </div>
          </fieldset>
        );
      })}
      <div>
        <Button type="submit" disabled={!ready || busy}>
          Send answer
        </Button>
      </div>
    </form>
  );
}

/** The tool's input in a readable form: a string as is, anything else as indented JSON. */
function readable(input: unknown): string {
  if (typeof input === "string") return input;
  return JSON.stringify(input, null, 2) ?? "";
}

function Permission({ payload, onAnswer, busy }: Part<Extract<QuestionPayload, { kind: "permission" }>>) {
  const [message, setMessage] = useState("");
  const send = (decision: "allow" | "allow-always" | "deny") => onAnswer({ kind: "permission", decision, ...(message.trim() ? { message: message.trim() } : {}) });
  const input = readable(payload.input);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[15px]">
        The agent wants to use <code className="rounded bg-hover px-1.5 py-0.5 font-mono text-[13px]">{payload.toolName}</code>.
      </p>
      {input && (
        <pre aria-label="Tool input" className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-hover p-3 font-mono text-[12.5px]">
          {input}
        </pre>
      )}
      <Textarea aria-label="Message to the agent" placeholder="Optional message to the agent" value={message} onChange={(e) => setMessage(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => send("allow")}>
          Allow
        </Button>
        {payload.canAlwaysAllow && (
          <Button variant="outline" disabled={busy} onClick={() => send("allow-always")}>
            Always allow
          </Button>
        )}
        <Button variant="outline" disabled={busy} onClick={() => send("deny")}>
          Deny
        </Button>
      </div>
    </div>
  );
}

function Confirm({ payload, onAnswer, busy }: Part<Extract<QuestionPayload, { kind: "confirm-outputs" }>>) {
  const [feedback, setFeedback] = useState("");
  const entries = Object.entries(payload.values);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[15px]">The agent has what it needs. Go ahead with these?</p>
      <dl className="divide-y divide-line overflow-hidden rounded-xl bg-hover text-[14px]">
        {entries.map(([k, v]) => (
          <div key={k} className="grid gap-1 px-3 py-2 sm:grid-cols-[10rem_1fr]">
            <dt className="font-medium text-muted">{k}</dt>
            <dd className="whitespace-pre-wrap break-words">{v}</dd>
          </div>
        ))}
      </dl>
      <Textarea aria-label="Feedback" placeholder="What should change? (for “Not yet”)" value={feedback} onChange={(e) => setFeedback(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => onAnswer({ kind: "confirm-outputs", confirmed: true })}>
          Go ahead
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => onAnswer({ kind: "confirm-outputs", confirmed: false, ...(feedback.trim() ? { feedback: feedback.trim() } : {}) })}
        >
          Not yet
        </Button>
      </div>
    </div>
  );
}
