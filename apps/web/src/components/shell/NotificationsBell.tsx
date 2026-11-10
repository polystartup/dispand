import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Bell } from "lucide-react";
import { useEffect } from "react";
import { api, orpc } from "../../lib/api.ts";
import { takeNew } from "../../lib/new-questions.ts";

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

function notify(fresh: number) {
  try {
    if (notificationPermission() !== "granted") return;
    new Notification("Dispand", { body: fresh === 1 ? "An agent has a question for you." : `${fresh} agents have questions for you.`, tag: "dispand-questions" });
  } catch {
    // A browser that refuses (some mobile ones need a service worker): the badge still tells.
  }
}

const STREAM_DELAY_MS = 1500;

/** Keeps the pending count current from the server stream (once, in the app shell). */
export function usePendingQuestionsStream() {
  const queryClient = useQueryClient();
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
            const taken: { seen: Set<string>; fresh: unknown[] } = takeNew(seen, items);
            seen = taken.seen;
            if (taken.fresh.length > 0) notify(taken.fresh.length);
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
  }, [queryClient]);
}

export function NotificationsBell({ onNavigate }: { onNavigate: () => void }) {
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
        void navigate({ to: "/notifications" });
      }}
      aria-label={unknown ? "Notifications (couldn't load what's waiting)" : pending > 0 ? `Notifications, ${pending} waiting` : "Notifications"}
      title={unknown ? "Couldn't load what's waiting" : undefined}
      className="relative grid size-8 place-items-center rounded-lg text-muted transition hover:bg-hover hover:text-fg"
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
