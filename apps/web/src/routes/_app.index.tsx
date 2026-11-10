import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { FirstLaunch } from "../components/home/FirstLaunch.tsx";
import { EmptyPage, PageView } from "../components/dashboard/PageView.tsx";
import { orpc } from "../lib/api.ts";

export const Route = createFileRoute("/_app/")({ component: Home });

function Home() {
  const { user } = Route.useRouteContext();
  const home = useQuery(orpc.pages.home.queryOptions());
  const onboarding = useQuery(orpc.onboarding.status.queryOptions());
  const widgets = home.data?.widgets ?? [];
  // Wait for both: no flash of the dashboard before the first-launch state.
  const firstLaunch = onboarding.data?.showFirstLaunch === true && widgets.length === 0;
  const heading = (
    <>
      <h1 className="text-[28px] font-semibold leading-tight tracking-tight">{`Welcome, ${user.name}`}</h1>
      <p className="mt-1 text-[15px] text-muted">Start your workflows and talk with your agents.</p>
    </>
  );

  if ((home.error && !home.data) || (onboarding.error && !onboarding.data)) {
    return (
      <>
        <header className="mb-8">{heading}</header>
        <p role="alert" className="text-[14px] text-danger">
          Could not load Home.
        </p>
      </>
    );
  }
  if (!home.data) return <header className="mb-8">{heading}</header>;
  return (
    <PageView
      page={home.data}
      heading={heading}
      actions={!firstLaunch}
      empty={
        !onboarding.data ? null : firstLaunch ? (
          <FirstLaunch status={onboarding.data} />
        ) : (
          <EmptyPage text="Add a widget to start a workflow from here. Workflows need an agent, and agents a harness: both are in Settings." />
        )
      }
    />
  );
}
