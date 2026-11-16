import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { EmptyPage, PageView } from "../components/dashboard/PageView.tsx";
import { orpc } from "../lib/api.ts";
import { getFirstLaunch } from "../server/session.ts";

export const Route = createFileRoute("/_app/")({
  // First launch, a fresh install's or one from before the Assistant: its page, which starts it.
  // Read at every visit, before Home loads: no flash of the dashboard, and no stale status.
  beforeLoad: async () => {
    if (await getFirstLaunch()) throw redirect({ to: "/assistant", replace: true });
  },
  component: Home,
});

function Home() {
  const { t } = useTranslation("dashboard");
  const { user } = Route.useRouteContext();
  const home = useQuery(orpc.pages.home.queryOptions());
  const heading = (
    <>
      <h1 className="text-[28px] font-semibold leading-tight tracking-tight">{t("home.welcome", { name: user.name })}</h1>
      <p className="mt-1 text-[15px] text-muted">{t("home.subtitle")}</p>
    </>
  );

  if (home.error && !home.data) {
    return (
      <>
        <header className="mb-8">{heading}</header>
        <p role="alert" className="text-[14px] text-danger">
          {t("home.failed")}
        </p>
      </>
    );
  }
  if (!home.data) return <header className="mb-8">{heading}</header>;
  return (
    <PageView
      page={home.data}
      heading={heading}
      empty={<EmptyPage text={t("home.empty")} />}
    />
  );
}
