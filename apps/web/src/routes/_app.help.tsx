import { createFileRoute } from "@tanstack/react-router";
import { Placeholder } from "../components/Placeholder.tsx";

export const Route = createFileRoute("/_app/help")({
  component: () => <Placeholder title="Help" subtitle="The guided tour and answers will live here." />,
});
