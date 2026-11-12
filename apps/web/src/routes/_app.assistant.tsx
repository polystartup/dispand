import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { AssistantChat } from "../components/assistant/AssistantChat.tsx";
import { PageHeader } from "../components/Placeholder.tsx";

export const Route = createFileRoute("/_app/assistant")({ component: Assistant, validateSearch: z.object({ run: z.string().max(100).optional() }) });

function Assistant() {
  const { run } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <>
      <PageHeader title="Assistant" subtitle="Ask about the platform, your setup and your business, or ask it to set something up." />
      <AssistantChat run={run} onOpen={(next, options) => void navigate({ search: { run: next }, replace: options?.replace })} />
    </>
  );
}
