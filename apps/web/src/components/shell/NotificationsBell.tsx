import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Bell } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { i18n as I18n } from "i18next";
import { api, orpc } from "../../lib/api.ts";
import { takeNew } from "../../lib/new-questions.ts";
import { currentSubscription } from "../../lib/push.ts";

/** Browser notifications: only on a secure context (HTTPS or localhost), and never required. */
export function notificationsSupported(): boolean {
  try {
    return typeof window !== "undefined" && window.isSecureContext && "Notification" in window;
  } catch {
    return false;
  }
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  try {
    return notificationsSupported() ? Notification.permission : "unsupported";
  } catch {
    return "unsupported";
  }
}

type Fresh = { kind: string; agent: { name: string; builtIn?: string | null } | null; workflow: { name: string } | null };

/**
 * The sentence a push says too (`messages:push.*`, `packages/domain/src/push/sender.ts`): the newest
 * item's agent and kind, and how many came. Only while this browser gets no pushes: they tell it then
 * (`public/sw.js`), and one alert per item is enough.
 */
async function notify(i18n: I18n, fresh: Fresh[]) {
  try {
    if (notificationPermission() !== "granted" || (await currentSubscription().catch(() => null))) return;
    const newest = fresh[0]!;
    const agent = newest.agent?.builtIn === "assistant" ? i18n.t("messages:agent.assistant.name") : ((newest.workflow ?? newest.agent)?.name ?? "");
    const body = i18n.t(newest.kind === "approval" ? "messages:push.approval" : "messages:push.question", { agent, count: fresh.length });
    new Notification("Dispand", { body, tag: "dispand-inbox" });
  } catch {
    // A browser that refuses (some mobile ones need a service worker): the badge still tells.
  }
}

const STREAM_DELAY_MS = 1500;

/** Keeps the pending count current from the server stream (once, in the app shell). */
export function usePendingQuestionsStream() {
  const queryClient = useQueryClient();
  // The instance, not `t`: a notification is written in the language of the moment it shows.
  const { i18n } = useTranslation();
  useEffect(() => {
    const stop = new AbortController();
    let seen: Set<string> | null = null;
    void (async () => {
      // Opened once the page has settled: a connection that stays open would keep the page from
      // ever being network-idle (what e2e tests wait for after a load).
      await new Promise((resolve) => setTimeout(resolve, STREAM_DELAY_MS));
      // The stream ends when the connection drops: reconnect until the shell unmounts.
      while (!stop.signal.aborted) {
        try {
          for await (const { count } of await api.questions.stream(undefined, { signal: stop.signal })) {
            // A notification per new question id (a count can stay the same when one is answered and another asked).
            const items = await api.questions.list({ status: "pending" });
            const taken: { seen: Set<string>; fresh: Fresh[] } = takeNew(seen, items);
            seen = taken.seen;
            if (taken.fresh.length > 0) void notify(i18n, taken.fresh);
            // A count request still in flight read the database earlier: it must not land after this.
            await queryClient.cancelQueries({ queryKey: orpc.questions.count.queryKey() });
            queryClient.setQueryData(orpc.questions.count.queryKey(), { count });
            void queryClient.invalidateQueries({ queryKey: orpc.questions.list.key() });
          }
        } catch {
          // Offline or the server restarted: retry below.
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    })();
    return () => stop.abort();
  }, [queryClient, i18n]);
}

export function NotificationsBell({ onNavigate }: { onNavigate: () => void }) {
  const { t } = useTranslation("shell");
  const { data, error } = useQuery(orpc.questions.count.queryOptions());
  const pending = data?.count ?? 0;
  // Without a count, say so rather than look like nothing waits.
  const unknown = !!error && !data;
  // A button, not a link: a sheet focuses its first button on open (links are skipped), and this one is not a tooltip trigger.
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => {
        onNavigate();
        void navigate({ to: "/inbox" });
      }}
      aria-label={unknown ? t("inbox.unknownLabel") : pending > 0 ? t("inbox.waiting", { count: pending }) : t("inbox.label")}
      title={unknown ? t("inbox.unknown") : undefined}
      className="relative grid size-11 place-items-center rounded-lg text-muted transition hover:bg-hover hover:text-fg"
    >
      <Bell size={17} aria-hidden />
      {unknown && <span aria-hidden className="absolute right-0.5 top-0.5 size-2 rounded-full bg-danger" />}
      {pending > 0 && (
        <span
          data-testid="pending-badge"
          className="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-4 text-accent-foreground"
        >
          {pending > 99 ? "99+" : pending}
        </span>
      )}
    </button>
  );
}
