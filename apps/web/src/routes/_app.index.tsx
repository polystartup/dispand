import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
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
  const { user } = Route.useRouteContext();
  const home = useQuery(orpc.pages.home.queryOptions());
  const heading = (
    <>
      <h1 className="text-[28px] font-semibold leading-tight tracking-tight">{`Welcome, ${user.name}`}</h1>
      <p className="mt-1 text-[15px] text-muted">Start your workflows and talk with your agents.</p>
    </>
  );

  if (home.error && !home.data) {
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
      empty={<EmptyPage text="Add a widget to start a workflow from here, or ask the Assistant to set one up." />}
    />
  );
}
