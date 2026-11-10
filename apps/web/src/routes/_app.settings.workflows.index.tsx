import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Empty, List } from "../components/settings/parts.tsx";
import { PageHeader } from "../components/Placeholder.tsx";
import { WorkflowsTabs } from "../components/workflow/Runs.tsx";
import { orpc } from "../lib/api.ts";

export const Route = createFileRoute("/_app/settings/workflows/")({ component: Workflows });

const edited = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function Workflows() {
  const workflows = useQuery(orpc.workflows.list.queryOptions());
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const create = useMutation(
    orpc.workflows.create.mutationOptions({
      onSuccess: async (wf) => {
        await queryClient.invalidateQueries({ queryKey: orpc.workflows.key() });
        await navigate({ to: "/settings/workflows/$id", params: { id: wf.id } });
      },
      onError: () => setError("Could not create the workflow. Try again."),
    }),
  );

  const button = (
    <Button disabled={create.isPending} onClick={() => create.mutate({ name: "Untitled workflow" })}>
      <Plus /> New workflow
    </Button>
  );

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <PageHeader title="Workflows" subtitle="Chain agent steps behind a button or a chat." />
        {workflows.data && workflows.data.length > 0 && button}
      </div>
      <WorkflowsTabs />
      {error && <p role="alert" className="mb-4 text-[14px] text-danger">{error}</p>}
      {workflows.error && <p role="alert" className="text-[14px] text-danger">Could not load the workflows.</p>}
      {workflows.data?.length === 0 && (
        <Empty title="No workflow yet" text="A workflow starts from a button or a chat, then hands the results to agent steps.">
          {button}
        </Empty>
      )}
      {workflows.data && workflows.data.length > 0 && (
        <List>
          {workflows.data.map((w) => (
            <li key={w.id}>
              <Link
                to="/settings/workflows/$id"
                params={{ id: w.id }}
                className="flex items-center justify-between gap-4 px-5 py-4 transition hover:bg-hover"
              >
                <span className="truncate text-[15px] font-medium">{w.name}</span>
                <span className="shrink-0 text-[13px] text-muted">
                  Version {w.version} · {edited.format(w.updatedAt)}
                </span>
              </Link>
            </li>
          ))}
        </List>
      )}
    </>
  );
}
