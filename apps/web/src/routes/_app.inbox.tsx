import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { InboxItem } from "../components/questions/InboxItem.tsx";
import { selectClass } from "../components/data/NewFieldPopover.tsx";
import { Empty } from "../components/settings/parts.tsx";
import { PageHeader } from "../components/Placeholder.tsx";
import { notificationPermission } from "../components/shell/NotificationsBell.tsx";
import { orpc } from "../lib/api.ts";
import { currentSubscription, pushSupported, subscribeDevice } from "../lib/push.ts";

// `item`: the one a push was about (`public/sw.js`), scrolled to once the list shows. `actor`: the agent whose inbox is shown, none for yours.
export const Route = createFileRoute("/_app/inbox")({ component: Inbox, validateSearch: z.object({ item: z.string().optional(), actor: z.string().optional() }) });

/** Every Question and Approval: what waits first, answerable in place, then what is done. Or an agent's inbox, read-only. */
function Inbox() {
  const { t } = useTranslation("questions");
  const { item, actor } = Route.useSearch();
  const navigate = Route.useNavigate();
  const agents = useQuery(orpc.agents.list.queryOptions());
  const items = useQuery(orpc.questions.list.queryOptions({ input: { status: "all", ...(actor ? { agentId: actor } : {}) } }));
  const open = items.data?.filter((q) => q.status === "pending") ?? [];
  const done = items.data?.filter((q) => q.status !== "pending") ?? [];
  const loaded = !!items.data;
  // What answers to a plugin update's items couldn't make, by question: kept here, as an answered Approval moves from Waiting to Done.
  const [notices, setNotices] = useState<Record<string, string[]>>({});
  const noticesOf = (id: string) => ({ notices: notices[id], onNotices: (said: string[]) => setNotices((prev) => ({ ...prev, [id]: [...(prev[id] ?? []), ...said] })) });
  useEffect(() => {
    if (loaded && item) document.getElementById(`item-${item}`)?.scrollIntoView({ block: "center" });
  }, [loaded, item]);
  return (
    <>
      <PageHeader title={t("inbox.title")} subtitle={t("inbox.subtitle")} />
      <label className="mb-6 flex items-center gap-2 text-[14px]">
        <span className="text-muted">{t("inbox.actor")}</span>
        <select className={selectClass} value={actor ?? ""} onChange={(e) => void navigate({ search: e.target.value ? { actor: e.target.value } : {} })}>
          <option value="">{t("inbox.me")}</option>
          {agents.data?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      {items.error && !items.data && <p role="alert" className="text-[14px] text-danger">{t("inbox.failed")}</p>}
      {items.data && open.length === 0 && (
        <Empty title={t(actor ? "inbox.agentEmptyTitle" : "inbox.emptyTitle")} text={t(actor ? "inbox.agentEmptyText" : "inbox.emptyText")}>
          <span />
        </Empty>
      )}
      {open.length > 0 && (
        <section aria-label={t("inbox.waiting")}>
          <ul className="flex flex-col gap-4">
            {open.map((q) => (
              <li key={q.id} id={`item-${q.id}`}>
                <InboxItem item={q} {...noticesOf(q.id)} />
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
              <li key={q.id} id={`item-${q.id}`}>
                <InboxItem item={q} {...noticesOf(q.id)} />
              </li>
            ))}
          </ul>
        </section>
      )}
      <BrowserOptIn />
    </>
  );
}

/** Where this browser is: not able, blocked, not on yet (`default`, `off`: allowed but not subscribed), or on. */
type OptIn = ReturnType<typeof notificationPermission> | "off";

/**
 * Opt-in: the browser asks only when the owner clicks, and nothing here is needed for the app.
 * Turned on, this browser is subscribed to Web Push, so what agents wait on reaches it with no tab open.
 */
function BrowserOptIn() {
  const { t } = useTranslation("questions");
  // Read after hydration: the server can't know the browser's permission.
  const [state, setState] = useState<OptIn | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const permission = notificationPermission();
    if (permission !== "granted" || !pushSupported()) return setState(permission);
    // Subscribed: said again, so the server has its current language. Allowed but not subscribed (signed out since): off.
    void currentSubscription()
      .then(async (subscription) => {
        if (subscription) await subscribeDevice();
        setState(subscription ? "granted" : "off");
      })
      .catch(() => setState("off"));
  }, []);
  if (state === null) return null;
  if (state === "unsupported") {
    return <p className="mt-8 text-[13px] text-faint">{t("inbox.browser.unsupported")}</p>;
  }
  const turnOn = async () => {
    setFailed(false);
    try {
      const permission = await Notification.requestPermission();
      if (permission === "granted" && pushSupported()) await subscribeDevice();
      setState(permission);
    } catch {
      setFailed(true);
    }
  };
  return (
    <div className="mt-8 flex items-center justify-between gap-4 rounded-2xl bg-surface px-5 py-4 shadow-card">
      <div>
        <p className="text-[15px] font-medium">{t("inbox.browser.title")}</p>
        <p className="text-[13px] text-muted">{t(`inbox.browser.${state === "off" ? "default" : state}`)}</p>
        {failed && (
          <p role="alert" className="text-[13px] text-danger">
            {t("inbox.browser.failed")}
          </p>
        )}
      </div>
      {(state === "default" || state === "off") && (
        <Button variant="outline" onClick={() => void turnOn()}>
          {t("inbox.browser.turnOn")}
        </Button>
      )}
    </div>
  );
}
