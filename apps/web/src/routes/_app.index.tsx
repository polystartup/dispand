import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { EmptyPage, PageView } from "../components/dashboard/PageView.tsx";
import { orpc } from "../lib/api.ts";

export const Route = createFileRoute("/_app/")({ component: Home });

function Home() {
  const { user } = Route.useRouteContext();
  const home = useQuery(orpc.pages.home.queryOptions());
  const onboarding = useQuery(orpc.onboarding.status.queryOptions());
  const heading = (
    <>
      <h1 className="text-[28px] font-semibold leading-tight tracking-tight">{`Welcome, ${user.name}`}</h1>
      <p className="mt-1 text-[15px] text-muted">Start your workflows and talk with your agents.</p>
    </>
  );

  // First launch, a fresh install's or one from before the Assistant: its page, which starts it.
  // Only on a status just read: a cached one may predate the Assistant.
  const firstLaunch = onboarding.data?.assistant === null;
  if (firstLaunch && !onboarding.isFetching) return <Navigate to="/assistant" replace />;
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
  // Wait for both: no flash of the dashboard before the redirect.
  if (!home.data || !onboarding.data || firstLaunch) return <header className="mb-8">{heading}</header>;
  return (
    <PageView
      page={home.data}
      heading={heading}
      empty={<EmptyPage text="Add a widget to start a workflow from here, or ask the Assistant to set one up." />}
    />
  );
}
