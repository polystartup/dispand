import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, LayoutGrid, Table2, Workflow } from "lucide-react";
import { useState } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { orpc } from "../../lib/api.ts";
import { DataWidgetForm } from "./DataWidgetForm.tsx";

type Props = { pageId: string; onClose: () => void };

const row = "flex items-center gap-3 rounded-xl px-3 py-3 text-left text-[15px] transition hover:bg-hover disabled:opacity-50";
const icon = "grid size-8 place-items-center rounded-lg bg-hover text-muted";
const section = "px-3 pt-2 text-[12px] font-medium uppercase tracking-wide text-muted";

/** Picks what to add to the page: a form for each manual workflow, or the rows of a table as a Grid or a Table. Mount it only while open. */
export function AddWidgetSheet({ pageId, onClose }: Props) {
  const queryClient = useQueryClient();
  const workflows = useQuery(orpc.workflows.list.queryOptions());
  const tables = useQuery(orpc.tables.list.queryOptions());
  const [data, setData] = useState<"grid" | "table" | null>(null);
  const create = useMutation(
    orpc.widgets.create.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: orpc.pages.key() });
        onClose();
      },
    }),
  );
  // Every workflow has a manual trigger for now.
  const manual = workflows.data ?? [];
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto bg-surface sm:max-w-md">
        <SheetHeader className="px-6 pt-6">
          <SheetTitle className="text-[20px] tracking-tight">Add widget</SheetTitle>
          <SheetDescription>{data ? `The rows of a table, as ${data === "grid" ? "cards" : "a table"}.` : "A form to start a workflow, or the rows of a table."}</SheetDescription>
        </SheetHeader>
        {data ? (
          <div className="grid gap-3 px-6 pb-6">
            <button type="button" onClick={() => setData(null)} className="inline-flex items-center gap-1 justify-self-start text-[13px] text-muted hover:text-fg">
              <ChevronLeft size={14} aria-hidden /> Back
            </button>
            <DataWidgetForm
              kind={data}
              submitLabel="Add widget"
              pending={create.isPending}
              error={create.error?.message}
              onSubmit={({ tableId, config }) =>
                create.mutate(
                  data === "grid"
                    ? { pageId, type: "grid", tableId, config: { fieldIds: config.fieldIds, coverFieldId: config.coverFieldId } }
                    : { pageId, type: "table", tableId, config: { fieldIds: config.fieldIds, sort: config.sort } },
                )
              }
            />
          </div>
        ) : (
          <div className="flex flex-col gap-2 px-6 pb-6">
            <h3 className={section}>Workflows</h3>
            {manual.map((w) => (
              <button key={w.id} type="button" disabled={create.isPending} onClick={() => create.mutate({ pageId, type: "workflow-form", workflowId: w.id })} className={row}>
                <span aria-hidden className={icon}>
                  <Workflow size={16} />
                </span>
                Workflow: {w.name}
              </button>
            ))}
            {workflows.data?.length === 0 && (
              <div className="rounded-xl px-3 py-3">
                <button type="button" disabled className="flex items-center gap-3 text-left text-[15px] opacity-50">
                  <span aria-hidden className={icon}>
                    <Workflow size={16} />
                  </span>
                  Workflow form
                </button>
                <p className="mt-2 text-[13px] text-muted">
                  Create a workflow first, in{" "}
                  <Link to="/settings/workflows" className="text-accent hover:underline" onClick={onClose}>
                    Settings → Workflows
                  </Link>
                  .
                </p>
              </div>
            )}
            {workflows.error && !workflows.data && (
              <p role="alert" className="text-[13px] text-danger">
                Could not load the workflows. Close this and try again.
              </p>
            )}
            <h3 className={`${section} mt-4`}>Data</h3>
            {(
              [
                ["grid", "Grid", LayoutGrid],
                ["table", "Table", Table2],
              ] as const
            ).map(([kind, label, Icon]) => (
              <button key={kind} type="button" disabled={!tables.data?.length} onClick={() => setData(kind)} className={row}>
                <span aria-hidden className={icon}>
                  <Icon size={16} />
                </span>
                {label}
              </button>
            ))}
            {tables.data?.length === 0 && (
              <p className="px-3 text-[13px] text-muted">
                Create a table first, in{" "}
                <Link to="/settings/data" className="text-accent hover:underline" onClick={onClose}>
                  Data
                </Link>
                .
              </p>
            )}
            {tables.error && !tables.data && (
              <p role="alert" className="text-[13px] text-danger">
                Could not load the tables. Close this and try again.
              </p>
            )}
            {create.error && (
              <p role="alert" className="text-[13px] text-danger">
                {create.error.message}
              </p>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
