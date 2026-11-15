import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { InboxItem } from "../components/questions/InboxItem.tsx";
import { Empty } from "../components/settings/parts.tsx";
import { PageHeader } from "../components/Placeholder.tsx";
import { notificationPermission } from "../components/shell/NotificationsBell.tsx";
import { orpc } from "../lib/api.ts";

export const Route = createFileRoute("/_app/inbox")({ component: Inbox });

/** Every Question and Approval: what waits first, answerable in place, then what is done. */
function Inbox() {
  const { t } = useTranslation("questions");
  const items = useQuery(orpc.questions.list.queryOptions({ input: { status: "all" } }));
  const open = items.data?.filter((q) => q.status === "pending") ?? [];
  const done = items.data?.filter((q) => q.status !== "pending") ?? [];
  return (
    <>
      <PageHeader title={t("inbox.title")} subtitle={t("inbox.subtitle")} />
      {items.error && !items.data && <p role="alert" className="text-[14px] text-danger">{t("inbox.failed")}</p>}
      {items.data && open.length === 0 && (
        <Empty title={t("inbox.emptyTitle")} text={t("inbox.emptyText")}>
          <span />
        </Empty>
      )}
      {open.length > 0 && (
        <section aria-label={t("inbox.waiting")}>
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
        <section aria-label={t("inbox.done")} className="mt-10">
          <h2 className="mb-3 text-[13px] font-medium uppercase tracking-wide text-muted">{t("inbox.done")}</h2>
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
  const { t } = useTranslation("questions");
  // Read after hydration: the server can't know the browser's permission.
  const [permission, setPermission] = useState<ReturnType<typeof notificationPermission> | null>(null);
  useEffect(() => setPermission(notificationPermission()), []);
  if (permission === null) return null;
  if (permission === "unsupported") {
    return <p className="mt-8 text-[13px] text-faint">{t("inbox.browser.unsupported")}</p>;
  }
  return (
    <div className="mt-8 flex items-center justify-between gap-4 rounded-2xl bg-surface px-5 py-4 shadow-card">
      <div>
        <p className="text-[15px] font-medium">{t("inbox.browser.title")}</p>
        <p className="text-[13px] text-muted">
          {t(`inbox.browser.${permission}`)}
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
          {t("inbox.browser.turnOn")}
        </Button>
      )}
    </div>
  );
}
