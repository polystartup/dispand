import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { api, orpc } from "../../lib/api.ts";
import { useFormat } from "../../lib/format.ts";
import { cliLabels, type Runner } from "./HarnessSheet.tsx";

export type Enrollment = Awaited<ReturnType<typeof api.runners.subscriptions>>[number];

/** Every live enrollment of the workspace: which runner and CLI, and whether it is the caller's. Never whose it is otherwise, never its identity. */
export function useSubscriptions() {
  return useQuery(orpc.runners.subscriptions.queryOptions({ refetchInterval: 3000 }));
}

// shortcut: only Codex's login is reported by the runner today; add "claude-code" here when it is.
const ENROLLABLE = ["codex"] as const;
type Harness = (typeof ENROLLABLE)[number];

/** The person's own subscription on this runner, per CLI: enroll, see when it needs signing in, revoke. */
export function Subscriptions({ runner }: { runner: Runner }) {
  const { t } = useTranslation("harnesses");
  const subscriptions = useSubscriptions();
  const harnesses = ENROLLABLE.filter((h) => runner.clis[h]);
  if (!harnesses.length) return null;
  return (
    <section aria-label={t("subscription.title")} className="space-y-4 border-t border-line pt-4">
      <h3 className="text-[14px] font-medium">{t("subscription.title")}</h3>
      {subscriptions.isError && <p role="alert" className="text-[13px] text-danger">{t("subscription.loadFailed")}</p>}
      {subscriptions.data && harnesses.map((h) => <CliSubscription key={h} runner={runner} harness={h} enrollment={subscriptions.data.find((e) => e.runnerId === runner.id && e.harness === h)} />)}
    </section>
  );
}

type Challenge = { challenge: string; expiresAt: Date };

function CliSubscription({ runner, harness, enrollment }: { runner: Runner; harness: Harness; enrollment: Enrollment | undefined }) {
  const { t } = useTranslation("harnesses");
  const cli = cliLabels[harness];
  const queryClient = useQueryClient();
  // The one-time challenge lives in this component's state only, never in a query or mutation cache.
  const [pending, setPending] = useState<Challenge | null>(null);
  const [starting, setStarting] = useState(false);
  const [expired, setExpired] = useState(false);
  const [revoked, setRevoked] = useState(false);
  const [error, setError] = useState<"start" | "revoke" | null>(null);
  const enrolled = enrollment?.mine === true;
  const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.runners.subscriptions.key() });
  const revoke = useMutation(orpc.runners.endSubscription.mutationOptions({ onSuccess: refresh }));

  // Enrolled (confirmed on the runner): the challenge has done its job and goes.
  useEffect(() => {
    if (enrolled) setPending(null);
  }, [enrolled]);
  // It goes at its expiry too.
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => {
      setPending(null);
      setExpired(true);
    }, Math.max(0, pending.expiresAt.getTime() - Date.now()));
    return () => clearTimeout(timer);
  }, [pending]);

  async function start() {
    setError(null);
    setExpired(false);
    setRevoked(false);
    setStarting(true);
    try {
      setPending(await api.runners.startEnrollment({ runnerId: runner.id }));
    } catch {
      setError("start");
    } finally {
      setStarting(false);
    }
  }

  async function end() {
    setError(null);
    try {
      await revoke.mutateAsync({ enrollmentId: enrollment!.id });
      setRevoked(true);
    } catch {
      setError("revoke");
    }
  }

  return (
    <div className="space-y-3 text-[14px]" aria-label={cli}>
      <p className="font-medium">{cli}</p>
      {enrolled ? (
        <>
          <p role="status">{t("subscription.enrolled")}</p>
          {enrollment.signInNeeded && <SignIn text={t("subscription.signInNeeded")} command={`dispand-runner sign-in ${harness}`} />}
          <Button type="button" variant="outline" disabled={revoke.isPending} onClick={() => void end()}>{t("subscription.revoke")}</Button>
        </>
      ) : pending ? (
        <Waiting harness={harness} cli={cli} pending={pending} onHide={() => setPending(null)} />
      ) : (
        <>
          <p className="text-muted">{t("subscription.hint", { cli })}</p>
          {enrollment ? <p role="status">{t("subscription.other")}</p> : <p role="status">{t(revoked ? "subscription.revoked" : expired ? "subscription.expired" : "subscription.notEnrolled")}</p>}
          {enrollment?.signInNeeded && <p className="text-muted">{t("subscription.signInNeededOther")}</p>}
          <Button type="button" disabled={starting} onClick={() => void start()}>{t(starting ? "subscription.starting" : "subscription.start")}</Button>
        </>
      )}
      {error && <p role="alert" className="text-[13px] text-danger">{t(error === "start" ? "subscription.startFailed" : "subscription.revokeFailed")}</p>}
    </div>
  );
}

function Waiting({ harness, cli, pending, onHide }: { harness: Harness; cli: string; pending: Challenge; onHide: () => void }) {
  const { t } = useTranslation("harnesses");
  const format = useFormat();
  return (
    <div className="space-y-3">
      <p role="status">{t("subscription.waiting")}</p>
      <p className="text-muted">{t("subscription.steps", { cli })}</p>
      {/* The command carries no secret: the challenge is typed or pasted when it asks. */}
      <CopyField label={t("subscription.command")} value={`dispand-runner enroll ${harness}`} />
      <CopyField label={t("subscription.challenge")} value={pending.challenge} />
      <p className="text-[13px] text-muted">{t("subscription.expires", { when: format.dateTimeSeconds(pending.expiresAt) })}</p>
      <Button type="button" variant="ghost" onClick={onHide}>{t("subscription.hide")}</Button>
    </div>
  );
}

/** What to run on the machine to sign in again: Dispand never shows a provider link, code or token. */
function SignIn({ text, command }: { text: string; command: string }) {
  const { t } = useTranslation("harnesses");
  return (
    <div role="status" className="space-y-2">
      <p>{text}</p>
      <CopyField label={t("subscription.command")} value={command} />
    </div>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation("harnesses");
  const [state, setState] = useState<"copied" | "failed" | null>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
      setTimeout(() => setState(null), 2000);
    } catch {
      setState("failed");
    }
  }
  return (
    <div className="space-y-1">
      <div className="relative">
        <pre aria-label={label} className="overflow-x-auto whitespace-pre-wrap break-all rounded-xl border border-line bg-bg p-3 pr-12 font-mono text-[12.5px] leading-relaxed">{value}</pre>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={`${t("subscription.copy")} ${label}`} className="absolute right-2 top-2" onClick={() => void copy()}>
          {state === "copied" ? <Check /> : <Copy />}
        </Button>
      </div>
      {state === "failed" && <p role="alert" className="text-[13px] text-danger">{t("subscription.copyFailed")}</p>}
    </div>
  );
}
