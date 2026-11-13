import type { Answer, QuestionPayload } from "@dispand/runner-protocol";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CONSULT_LINE, ProposalItems, type ProposalView } from "./ProposalItems.tsx";

/** For a call of one of an agent's tools: the tool and the action it is for, in full (the name it is asked under is cut short). */
export type About = { tool: string; action: string; description: string };

export type QuestionFormProps = {
  /**
   * `proposalId`: the Approval is for a proposal; `proposal`: that proposal as its owner reads it (the Inbox loads it).
   * `rootId`: a checkpoint's Approval; `consultId`: a consult's.
   */
  question: {
    payload: QuestionPayload;
    orphaned?: boolean;
    remember?: { scopes: ("run" | "always")[]; label: string };
    about?: About | null;
    proposalId?: string | null;
    proposal?: ProposalView | null;
    rootId?: string | null;
    consultId?: string | null;
  };
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
      {payload.kind === "permission" && question.rootId && <Checkpoint payload={payload} onAnswer={onAnswer} busy={busy} />}
      {payload.kind === "permission" && question.consultId && <Consult payload={payload} onAnswer={onAnswer} busy={busy} />}
      {payload.kind === "permission" && !question.rootId && !question.consultId && (
        <Permission payload={payload} offer={question.remember} about={question.about ?? null} proposalId={question.proposalId ?? null} proposal={question.proposal ?? null} onAnswer={onAnswer} busy={busy} />
      )}
      {payload.kind === "confirm-outputs" && <Confirm payload={payload} onAnswer={onAnswer} busy={busy} />}
      {error && (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** What a consult's Approval says (`engine/consults.ts`): the agent consulted, by name, and the question whole. */
export function consultInput(payload: QuestionPayload): { agent: string; question: string } {
  const input = (payload.kind === "permission" ? payload.input : null) as { agent?: unknown; question?: unknown } | null;
  return { agent: typeof input?.agent === "string" ? input.agent : "an agent", question: typeof input?.question === "string" ? input.question : "" };
}

/** A consult of an agent whose entry asks before use: no Job of it is made until the owner says yes. */
function Consult({ payload, onAnswer, busy }: Part<Extract<QuestionPayload, { kind: "permission" }>>) {
  const c = consultInput(payload);
  const send = (decision: "allow" | "allow-always" | "deny") => onAnswer({ kind: "permission", decision });
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[15px]">
        The agent wants to consult <span className="font-medium">{c.agent}</span>. A Job of {c.agent} answers this question:
      </p>
      <p aria-label="Question" className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-hover p-3 text-[14px]">
        {c.question}
      </p>
      <p className="text-[13px] text-muted">{CONSULT_LINE}</p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => send("allow")}>
          Allow
        </Button>
        {payload.canAlwaysAllow && (
          <Button variant="outline" disabled={busy} onClick={() => send("allow-always")}>
            Don't ask again
          </Button>
        )}
        <Button variant="outline" disabled={busy} onClick={() => send("deny")}>
          Deny
        </Button>
      </div>
    </div>
  );
}

/** What a checkpoint's Approval says (`engine/roots.ts`): the root cause, its Jobs, the agents involved and since when. */
export type CheckpointInput = { root: string; jobs: number; agents: string[]; since: string };

export function checkpointInput(payload: QuestionPayload): CheckpointInput {
  const input = (payload.kind === "permission" ? payload.input : null) as Partial<CheckpointInput> | null;
  return {
    root: typeof input?.root === "string" ? input.root : "Work of your agents",
    jobs: typeof input?.jobs === "number" ? input.jobs : 0,
    agents: Array.isArray(input?.agents) ? input.agents.filter((a): a is string => typeof a === "string") : [],
    since: typeof input?.since === "string" ? input.since : "",
  };
}

const since = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** A checkpoint (design 6.1): the work from one root cause made this many Jobs; go on, go on for good, or stop it. */
function Checkpoint({ payload, onAnswer, busy }: Part<Extract<QuestionPayload, { kind: "permission" }>>) {
  const c = checkpointInput(payload);
  const send = (decision: "allow" | "allow-always" | "deny") => onAnswer({ kind: "permission", decision });
  const date = c.since ? new Date(c.since) : null;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[15px]">
        {c.root} has led to <span className="font-medium">{c.jobs} Jobs</span>
        {date && !Number.isNaN(date.getTime()) ? ` since ${since.format(date)}` : ""}. It is paused until you say whether it goes on.
      </p>
      {c.agents.length > 0 && <p className="text-[13px] text-muted">Agents: {c.agents.join(", ")}</p>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => send("allow")}>
          Go on
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => send("allow-always")}>
          Don't ask again for this goal
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => send("deny")}>
          Stop this work
        </Button>
      </div>
    </div>
  );
}

/** The words of an approval an agent asked for with `request_approval`; null for any other question. */
export function approvalWords(payload: QuestionPayload): string | null {
  if (payload.kind !== "permission" || payload.toolName !== "request_approval") return null;
  const message = (payload.input as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : null;
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

function Permission({
  payload,
  offer,
  about,
  proposalId,
  proposal,
  onAnswer,
  busy,
}: Part<Extract<QuestionPayload, { kind: "permission" }>> & { about: About | null; proposalId: string | null; proposal: ProposalView | null; offer?: { scopes: ("run" | "always")[]; label: string } }) {
  const [scope, setScope] = useState<"run" | "always" | "">("");
  const radio = useId();
  const [message, setMessage] = useState("");
  const send = (decision: "allow" | "allow-always" | "deny") => onAnswer({ kind: "permission", decision, ...(message.trim() ? { message: message.trim() } : {}), ...(scope && offer?.scopes.includes(scope) ? { remember: scope } : {}) });
  const input = readable(payload.input);
  // An approval the agent asked for in its own words (`request_approval`): the words, not a tool call.
  const asked = approvalWords(payload);
  // For a proposal, a yes approves its listed writes: never answered where they aren't shown.
  if (proposalId && !proposal) {
    return (
      <div className="flex flex-col gap-2 text-[15px]">
        {asked !== null && <p className="whitespace-pre-wrap break-words">{asked}</p>}
        <p className="rounded-lg bg-hover px-3 py-2 text-[13px] text-muted">
          This asks you to approve a proposal: changes to what agents may do.{" "}
          <a href="/inbox" className="text-accent underline">
            Read and answer it in the Inbox
          </a>
          .
        </p>
      </div>
    );
  }
  // The agent named a proposal, but none is attached to this request (not its own, already asked, or no such one).
  const unattached = asked !== null && !proposalId && (payload.input as { proposal?: unknown } | null)?.proposal !== undefined;
  return (
    <div className="flex flex-col gap-3">
      {proposal && (
        <>
          <p className="text-[15px]">The agent asks you to approve these changes. Approving lets it make exactly these, once each.</p>
          <ProposalItems proposal={proposal} />
          <p className="text-[13px] text-muted">The agent says:</p>
        </>
      )}
      {unattached && (
        <p role="alert" className="rounded-lg bg-hover px-3 py-2 text-[13px] text-danger">
          This request names a proposal that isn't attached to it. Approving approves these words only: no listed change.
        </p>
      )}
      {asked !== null ? (
        <p className="whitespace-pre-wrap break-words text-[15px]">{asked}</p>
      ) : (
        <>
          {about ? (
            <div className="text-[15px]">
              <p>
                The agent wants to use <span className="font-medium">{about.tool}</span>: <code className="rounded bg-hover px-1.5 py-0.5 font-mono text-[13px]">{about.action}</code>
              </p>
              {about.description && <p className="mt-1 text-[13px] text-muted">{about.description}</p>}
            </div>
          ) : (
            <p className="text-[15px]">
              The agent wants to use <code className="rounded bg-hover px-1.5 py-0.5 font-mono text-[13px]">{payload.toolName}</code>.
            </p>
          )}
          {input && (
            <pre aria-label="Tool input" className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-hover p-3 font-mono text-[12.5px]">
              {input}
            </pre>
          )}
        </>
      )}
      {offer && asked === null && !proposalId && (
        <fieldset className="space-y-2 text-[13px]" disabled={busy}>
          <legend className="mb-2 font-medium">Remember this decision</legend>
          <p className="break-words text-muted">{offer.label}</p>
          {[["", "Just this call"], ...offer.scopes.map((s) => [s, s === "run" ? "Remember this for this run only" : "Remember this for this and all future runs"])].map(([value, label]) => (
            <label key={value} className="flex items-start gap-2">
              <input type="radio" name={radio} value={value} checked={scope === value} onChange={() => setScope(value as "" | "run" | "always")} className="mt-0.5 accent-[var(--color-accent)]" />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
      )}
      <Textarea aria-label="Message to the agent" placeholder="Optional message to the agent" value={message} onChange={(e) => setMessage(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => send("allow")}>
          {asked !== null ? "Approve" : "Allow"}
        </Button>
        {payload.canAlwaysAllow && !offer && (
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
      {/* A chat that hands nothing back ends with this: there is no list to show, so it asks to end. */}
      <p className="text-[15px]">{entries.length === 0 ? "The agent says it is done and has nothing to hand back. End this chat?" : "The agent has what it needs. Go ahead with these?"}</p>
      {entries.length > 0 && (
        <dl className="divide-y divide-line overflow-hidden rounded-xl bg-hover text-[14px]">
          {entries.map(([k, v]) => (
            <div key={k} className="grid gap-1 px-3 py-2 sm:grid-cols-[10rem_1fr]">
              <dt className="font-medium text-muted">{k}</dt>
              <dd className="whitespace-pre-wrap break-words">{v}</dd>
            </div>
          ))}
        </dl>
      )}
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
