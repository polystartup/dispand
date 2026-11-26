import { createFileRoute } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";
import { Recipient } from "./-invitation.tsx";

export const Route = createFileRoute("/invitation")({ component: Invitation });

function subscribe(notify: () => void) {
  window.addEventListener("hashchange", notify);
  return () => window.removeEventListener("hashchange", notify);
}

function Invitation() {
  const { user, enrollsAccounts } = Route.useRouteContext().auth;
  const email = user?.email ?? null;
  const token = useSyncExternalStore(subscribe, () => window.location.hash.slice(1), () => null);
  // The invitation stays in the fragment across sign-in. Only the browser sends it to the RPC.
  return <Recipient key={token} token={token} email={email} enrollsAccounts={enrollsAccounts} refresh={() => window.location.reload()} />;
}
