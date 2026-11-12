import { createFileRoute } from "@tanstack/react-router";
import { Placeholder } from "../components/Placeholder.tsx";

export const Route = createFileRoute("/_app/help")({
  component: () => <Placeholder title="Help" subtitle="Answers about Dispand will live here. Meanwhile, ask the Assistant." />,
});
