import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, LayoutGrid, Table2, Workflow } from "lucide-react";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { orpc } from "../../lib/api.ts";
import { DataWidgetForm } from "./DataWidgetForm.tsx";

type Props = { pageId: string; onClose: () => void };

const row = "flex items-center gap-3 rounded-xl px-3 py-3 text-left text-[15px] transition hover:bg-hover disabled:opacity-50";
const icon = "grid size-8 place-items-center rounded-lg bg-hover text-muted";
const kinds = ["grid", "table"] as const;
const section = "px-3 pt-2 text-[12px] font-medium uppercase tracking-wide text-muted";

/** Picks what to add to the page: a form for each manual workflow, or the rows of a table as a Grid or a Table. Mount it only while open. */
export function AddWidgetSheet({ pageId, onClose }: Props) {
  const { t } = useTranslation("dashboard");
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
          <SheetTitle className="text-[20px] tracking-tight">{t("add.title")}</SheetTitle>
          <SheetDescription>{data ? (data === "grid" ? t("add.pickGrid") : t("add.pickTable")) : t("add.pick")}</SheetDescription>
        </SheetHeader>
        {data ? (
          <div className="grid gap-3 px-6 pb-6">
            <button type="button" onClick={() => setData(null)} className="inline-flex items-center gap-1 justify-self-start text-[13px] text-muted hover:text-fg">
              <ChevronLeft size={14} aria-hidden /> {t("add.back")}
            </button>
            <DataWidgetForm
              kind={data}
              submitLabel={t("add.title")}
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
            <h3 className={section}>{t("add.workflows")}</h3>
            {manual.map((w) => (
              <button key={w.id} type="button" disabled={create.isPending} onClick={() => create.mutate({ pageId, type: "workflow-form", workflowId: w.id })} className={row}>
                <span aria-hidden className={icon}>
                  <Workflow size={16} />
                </span>
                {t("add.workflow", { name: w.name })}
              </button>
            ))}
            {workflows.data?.length === 0 && (
              <div className="rounded-xl px-3 py-3">
                <button type="button" disabled className="flex items-center gap-3 text-left text-[15px] opacity-50">
                  <span aria-hidden className={icon}>
                    <Workflow size={16} />
                  </span>
                  {t("add.workflowForm")}
                </button>
                <p className="mt-2 text-[13px] text-muted">
                  <Trans t={t} i18nKey="add.noWorkflows" components={{ go: <Link to="/settings/workflows" className="text-accent hover:underline" onClick={onClose} /> }} />
                </p>
              </div>
            )}
            {workflows.error && !workflows.data && (
              <p role="alert" className="text-[13px] text-danger">
                {t("add.workflowsFailed")}
              </p>
            )}
            <h3 className={`${section} mt-4`}>{t("add.data")}</h3>
            {kinds.map((kind) => {
              const Icon = kind === "grid" ? LayoutGrid : Table2;
              return (
                <button key={kind} type="button" disabled={!tables.data?.length} onClick={() => setData(kind)} className={row}>
                  <span aria-hidden className={icon}>
                    <Icon size={16} />
                  </span>
                  {kind === "grid" ? t("add.grid") : t("add.table")}
                </button>
              );
            })}
            {tables.data?.length === 0 && (
              <p className="px-3 text-[13px] text-muted">
                <Trans t={t} i18nKey="add.noTables" components={{ go: <Link to="/settings/data" className="text-accent hover:underline" onClick={onClose} /> }} />
              </p>
            )}
            {tables.error && !tables.data && (
              <p role="alert" className="text-[13px] text-danger">
                {t("add.tablesFailed")}
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
