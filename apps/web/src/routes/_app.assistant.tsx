import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { AssistantChat } from "../components/assistant/AssistantChat.tsx";

export const Route = createFileRoute("/_app/assistant")({ component: Assistant, validateSearch: z.object({ run: z.string().max(100).optional() }) });

function Assistant() {
  const { run } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <>
      <h1 className="mb-3 shrink-0 text-[22px] font-semibold tracking-tight">Assistant</h1>
      <AssistantChat run={run} onOpen={(next, options) => void navigate({ search: { run: next }, replace: options?.replace })} />
    </>
  );
}
