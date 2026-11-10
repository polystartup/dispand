import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { InboxItem } from "../components/questions/InboxItem.tsx";
import { Empty } from "../components/settings/parts.tsx";
import { PageHeader } from "../components/Placeholder.tsx";
import { notificationPermission } from "../components/shell/NotificationsBell.tsx";
import { orpc } from "../lib/api.ts";

export const Route = createFileRoute("/_app/inbox")({ component: Inbox });

/** Every Question and Approval: what waits first, answerable in place, then what is done. */
function Inbox() {
  const items = useQuery(orpc.questions.list.queryOptions({ input: { status: "all" } }));
  const open = items.data?.filter((q) => q.status === "pending") ?? [];
  const done = items.data?.filter((q) => q.status !== "pending") ?? [];
  return (
    <>
      <PageHeader title="Inbox" subtitle="What your agents ask you, and what was answered." />
      {items.error && !items.data && <p role="alert" className="text-[14px] text-danger">Could not load the Inbox.</p>}
      {items.data && open.length === 0 && (
        <Empty title="Nothing waits for you" text="When an agent needs an answer or an approval, it shows up here.">
          <span />
        </Empty>
      )}
      {open.length > 0 && (
        <section aria-label="Waiting for you">
          <ul className="flex flex-col gap-4">
            {open.map((q) => (
              <li key={q.id}>
                <InboxItem item={q} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {done.length > 0 && (
        <section aria-label="Done" className="mt-10">
          <h2 className="mb-3 text-[13px] font-medium uppercase tracking-wide text-muted">Done</h2>
          <ul className="flex flex-col gap-4">
            {done.map((q) => (
              <li key={q.id}>
                <InboxItem item={q} />
              </li>
            ))}
          </ul>
        </section>
      )}
      <BrowserOptIn />
    </>
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
