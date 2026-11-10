import { createFileRoute, redirect } from "@tanstack/react-router";

// The Inbox's earlier address: links and bookmarks keep working.
export const Route = createFileRoute("/_app/notifications")({
  beforeLoad: () => {
    throw redirect({ to: "/inbox" });
  },
});
