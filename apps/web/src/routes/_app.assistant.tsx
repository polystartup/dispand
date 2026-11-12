import { createFileRoute } from "@tanstack/react-router";
import { AssistantChat } from "../components/assistant/AssistantChat.tsx";
import { PageHeader } from "../components/Placeholder.tsx";

export const Route = createFileRoute("/_app/assistant")({ component: Assistant });

function Assistant() {
  return (
    <>
      <PageHeader title="Assistant" subtitle="Ask about the platform, your setup and your business, or ask it to set something up." />
      <AssistantChat />
    </>
  );
}
