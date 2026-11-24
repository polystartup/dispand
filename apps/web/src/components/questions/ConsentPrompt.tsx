import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { orpc } from "../../lib/api.ts";
import { refreshRun } from "../../lib/run-watch.ts";

type Consenting = { id: string; runId: string; consent?: "awaiting" | "given"; recovery?: boolean; yoursToConsent?: boolean };

/**
 * Another person's answer to a personal action: its subscriber continues it with one action of their
 * own (`questions.consent`), without answering again; anyone else sees it wait; a paused action's answer
 * waits for its recovery. Nothing for any other question.
 */
export function ConsentPrompt({ question }: { question: Consenting }) {
  const { t } = useTranslation("questions");
  if (question.recovery) return <p role="status" className="text-[13px] text-muted">{t("consent.recovery")}</p>;
  if (question.yoursToConsent) return <Continue question={question} />;
  return question.consent === "awaiting" ? <p role="status" className="text-[13px] text-muted">{t("consent.waiting")}</p> : null;
}

/** Its own component, so only the subscriber's prompt needs the query client. */
function Continue({ question }: { question: Consenting }) {
  const { t } = useTranslation("questions");
  const queryClient = useQueryClient();
  const consent = useMutation(
    orpc.questions.consent.mutationOptions({
      onSettled: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.questions.key() });
        void refreshRun(question.runId).catch(() => undefined);
      },
    }),
  );
  return (
    <div role="status" className="space-y-2 text-[14px]">
      <p>{t("consent.prompt")}</p>
      <Button type="button" disabled={consent.isPending} onClick={() => consent.mutate({ questionId: question.id })}>
        {t("consent.button")}
      </Button>
      {consent.isError && <p role="alert" className="text-[13px] text-danger">{t("consent.failed")}</p>}
    </div>
  );
}
