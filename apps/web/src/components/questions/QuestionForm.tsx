import type { Answer, QuestionPayload } from "@dispand/runner-protocol";
import { useId, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useFormat } from "../../lib/format.ts";
import { ProposalItems, type ProposalView } from "./ProposalItems.tsx";

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
    remember?: { scopes: ("run" | "always")[]; label: string; decisions?: ("allow" | "deny")[] };
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
  const { t } = useTranslation("questions");
  const { payload } = question;
  return (
    <div className="flex flex-col gap-4">
      {question.orphaned && (
        <p className="rounded-lg bg-hover px-3 py-2 text-[13px] text-muted">
          {t("orphaned")}
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
export function consultInput(payload: QuestionPayload): { agent: string | null; question: string } {
  const input = (payload.kind === "permission" ? payload.input : null) as { agent?: unknown; question?: unknown } | null;
  return { agent: typeof input?.agent === "string" ? input.agent : null, question: typeof input?.question === "string" ? input.question : "" };
}

/** A consult of an agent whose entry asks before use: no Job of it is made until the owner says yes. */
function Consult({ payload, onAnswer, busy }: Part<Extract<QuestionPayload, { kind: "permission" }>>) {
  const { t } = useTranslation("questions");
  const c = consultInput(payload);
  const agent = c.agent ?? t("anAgent");
  const send = (decision: "allow" | "allow-always" | "deny") => onAnswer({ kind: "permission", decision });
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[15px]">
        <Trans t={t} i18nKey="consult.wants" values={{ agent }} components={[<span className="font-medium" />]} />
      </p>
      <p aria-label={t("question")} className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-hover p-3 text-[14px]">
        {c.question}
      </p>
      <p className="text-[13px] text-muted">{t("consultLine")}</p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => send("allow")}>
          {t("allow")}
        </Button>
        {payload.canAlwaysAllow && (
          <Button variant="outline" disabled={busy} onClick={() => send("allow-always")}>
            {t("dontAskAgain")}
          </Button>
        )}
        <Button variant="outline" disabled={busy} onClick={() => send("deny")}>
          {t("deny")}
        </Button>
      </div>
    </div>
  );
}

/** What a checkpoint's Approval says (`engine/roots.ts`): the root cause, its Jobs, the agents involved and since when. */
export type CheckpointInput = { root: string | null; jobs: number; agents: string[]; since: string };

export function checkpointInput(payload: QuestionPayload): CheckpointInput {
  const input = (payload.kind === "permission" ? payload.input : null) as Partial<CheckpointInput> | null;
  return {
    root: typeof input?.root === "string" ? input.root : null,
    jobs: typeof input?.jobs === "number" ? input.jobs : 0,
    agents: Array.isArray(input?.agents) ? input.agents.filter((a): a is string => typeof a === "string") : [],
    since: typeof input?.since === "string" ? input.since : "",
  };
}

/** A checkpoint (design 6.1): the work from one root cause made this many Jobs; go on, go on for good, or stop it. */
function Checkpoint({ payload, onAnswer, busy }: Part<Extract<QuestionPayload, { kind: "permission" }>>) {
  const { t } = useTranslation("questions");
  const format = useFormat();
  const c = checkpointInput(payload);
  const root = c.root ?? t("checkpoint.defaultRoot");
  const send = (decision: "allow" | "allow-always" | "deny") => onAnswer({ kind: "permission", decision });
  const date = c.since ? new Date(c.since) : null;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[15px]">
        <Trans
          t={t}
          i18nKey={date && !Number.isNaN(date.getTime()) ? "checkpoint.textSince" : "checkpoint.text"}
          count={c.jobs}
          values={{ root, since: date ? format.dateTime(date) : "" }}
          components={[<span className="font-medium" />]}
        />
      </p>
      {c.agents.length > 0 && <p className="text-[13px] text-muted">{t("checkpoint.agents", { agents: format.list(c.agents) })}</p>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => send("allow")}>
          {t("checkpoint.goOn")}
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => send("allow-always")}>
          {t("checkpoint.dontAsk")}
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => send("deny")}>
          {t("checkpoint.stop")}
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

const inputType = (multi: boolean) => (multi ? "checkbox" : "radio");

type Pick = { labels: string[]; other: boolean; text: string };

function Choice({ payload, onAnswer, busy }: Part<Extract<QuestionPayload, { kind: "choice" }>>) {
  const { t } = useTranslation("questions");
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
        const type = inputType(q.multiSelect);
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
                aria-label={t("other")}
                checked={p.other}
                onChange={() => update(i, q.multiSelect ? { other: !p.other } : { other: true, labels: [] })}
                className="size-4 accent-[var(--color-accent)]"
              />
              <Input
                aria-label={t("otherFor", { question: q.question })}
                placeholder={t("otherPlaceholder")}
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
          {t("sendAnswer")}
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
}: Part<Extract<QuestionPayload, { kind: "permission" }>> & { about: About | null; proposalId: string | null; proposal: ProposalView | null; offer?: { scopes: ("run" | "always")[]; label: string; decisions?: ("allow" | "deny")[] } }) {
  const { t } = useTranslation("questions");
  const [scope, setScope] = useState<"run" | "always" | "">("");
  const radio = useId();
  const [message, setMessage] = useState("");
  const send = (decision: "allow" | "allow-always" | "deny") => onAnswer({ kind: "permission", decision, ...(message.trim() ? { message: message.trim() } : {}), ...(scope && offer?.scopes.includes(scope) && (!offer.decisions || offer.decisions.includes(decision as "allow" | "deny")) ? { remember: scope } : {}) });
  const input = readable(payload.input);
  // An approval the agent asked for in its own words (`request_approval`): the words, not a tool call.
  const asked = approvalWords(payload);
  // For a proposal, a yes approves its listed writes: never answered where they aren't shown.
  if (proposalId && !proposal) {
    return (
      <div className="flex flex-col gap-2 text-[15px]">
        {asked !== null && <p className="whitespace-pre-wrap break-words">{asked}</p>}
        <p className="rounded-lg bg-hover px-3 py-2 text-[13px] text-muted">
          <Trans t={t} i18nKey="proposal.inInbox" components={[<a href="/inbox" className="text-accent underline" />]} />
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
          <p className="text-[15px]">{t("proposal.intro")}</p>
          <ProposalItems proposal={proposal} />
          <p className="text-[13px] text-muted">{t("proposal.says")}</p>
        </>
      )}
      {unattached && (
        <p role="alert" className="rounded-lg bg-hover px-3 py-2 text-[13px] text-danger">
          {t("proposal.unattached")}
        </p>
      )}
      {asked !== null ? (
        <p className="whitespace-pre-wrap break-words text-[15px]">{asked}</p>
      ) : (
        <>
          {about ? (
            <div className="text-[15px]">
              <p>
                <Trans t={t} i18nKey="wantsToUseAction" values={{ tool: about.tool, action: about.action }} components={[<span className="font-medium" />, <code className="rounded bg-hover px-1.5 py-0.5 font-mono text-[13px]" />]} />
              </p>
              {about.description && <p className="mt-1 text-[13px] text-muted">{about.description}</p>}
            </div>
          ) : (
            <p className="text-[15px]">
              <Trans t={t} i18nKey="wantsToUse" values={{ tool: payload.toolName }} components={[<code className="rounded bg-hover px-1.5 py-0.5 font-mono text-[13px]" />]} />
            </p>
          )}
          {input && (
            <pre aria-label={t("toolInput")} className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-hover p-3 font-mono text-[12.5px]">
              {input}
            </pre>
          )}
        </>
      )}
      {offer && asked === null && !proposalId && (
        <fieldset className="space-y-2 text-[13px]" disabled={busy}>
          <legend className="mb-2 font-medium">{offer.decisions?.length === 1 && offer.decisions[0] === "allow" ? t("rememberAllow") : t("rememberDecision")}</legend>
          {offer.decisions?.length === 1 && offer.decisions[0] === "allow" && <p className="text-muted">{t("denyOnlyCall")}</p>}
          <p className="break-words text-muted">{offer.label}</p>
          {[["", t("justThisCall")], ...offer.scopes.map((s) => [s, s === "run" ? t("rememberRun") : t("rememberAlways")])].map(([value, label]) => (
            <label key={value} className="flex items-start gap-2">
              <input type="radio" name={radio} value={value} checked={scope === value} onChange={() => setScope(value as "" | "run" | "always")} className="mt-0.5 accent-[var(--color-accent)]" />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
      )}
      <Textarea aria-label={t("messageLabel")} placeholder={t("messagePlaceholder")} value={message} onChange={(e) => setMessage(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => send("allow")}>
          {asked !== null ? t("approve") : t("allow")}
        </Button>
        {payload.canAlwaysAllow && !offer && (
          <Button variant="outline" disabled={busy} onClick={() => send("allow-always")}>
            {t("alwaysAllow")}
          </Button>
        )}
        <Button variant="outline" disabled={busy} onClick={() => send("deny")}>
          {t("deny")}
        </Button>
      </div>
    </div>
  );
}

function Confirm({ payload, onAnswer, busy }: Part<Extract<QuestionPayload, { kind: "confirm-outputs" }>>) {
  const { t } = useTranslation("questions");
  const [feedback, setFeedback] = useState("");
  const entries = Object.entries(payload.values);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[15px]">{t("confirm.text")}</p>
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
      <Textarea aria-label={t("confirm.feedback")} placeholder={t("confirm.placeholder")} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => onAnswer({ kind: "confirm-outputs", confirmed: true })}>
          {t("confirm.goAhead")}
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => onAnswer({ kind: "confirm-outputs", confirmed: false, ...(feedback.trim() ? { feedback: feedback.trim() } : {}) })}
        >
          {t("confirm.notYet")}
        </Button>
      </div>
    </div>
  );
}
