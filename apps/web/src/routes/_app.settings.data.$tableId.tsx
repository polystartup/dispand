import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ChevronLeft, Ellipsis, Trash2, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tabs as TabsPrimitive } from "radix-ui";
import type { RowQuery } from "@dispand/domain/data/query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Grid } from "../components/data/Grid.tsx";
import { PrimitiveDialog } from "../components/data/PrimitiveDialog.tsx";
import { RowDetail } from "../components/data/RowDetail.tsx";
import { MemoryPanel } from "../components/memory/MemoryPanel.tsx";
import { StateTabs } from "../components/settings/Tabs.tsx";
import { type DataSearch, parseDataSearch, toDataSearch } from "../lib/data-search.ts";
import { orpc } from "../lib/api.ts";

const TABS = ["rows", "memory"] as const;

export const Route = createFileRoute("/_app/settings/data/$tableId")({
  // Kept as given; `parseDataSearch` drops what doesn't parse, so an old link still opens the table.
  validateSearch: (search: Record<string, unknown>): DataSearch => ({
    ...(search.q !== undefined && { q: typeof search.q === "string" ? search.q : JSON.stringify(search.q) }),
    ...(typeof search.row === "string" && { row: search.row }),
  }),
  component: TablePage,
});

function TablePage() {
  const { t } = useTranslation("data");
  const { tableId } = Route.useParams();
  const search = Route.useSearch();
  const { query, row } = useMemo(() => parseDataSearch(search), [search]);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const table = useQuery(orpc.tables.get.queryOptions({ input: { id: tableId } }));
  const [name, setName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [settingEvents, setSettingEvents] = useState(false);
  const [shown, setShown] = useState<(typeof TABS)[number]>("rows");
  useEffect(() => setName(table.data?.name ?? ""), [table.data?.name]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.tables.key() });
  /** A schema change: the fields, and the rows whose cells it changed. */
  const schemaChanged = async () => {
    await refresh();
    await queryClient.invalidateQueries({ queryKey: orpc.rows.list.key({ input: { tableId } }) });
  };
  const rename = useMutation(orpc.tables.rename.mutationOptions({ onSuccess: refresh, onError: () => setName(table.data?.name ?? "") }));
  const remove = useMutation(
    orpc.tables.delete.mutationOptions({
      onSuccess: async () => {
        await navigate({ to: "/settings/data" });
        await refresh();
      },
    }),
  );

  const saveName = () => {
    const next = name.trim();
    if (next === "" || next === table.data?.name) return setName(table.data?.name ?? "");
    rename.mutate({ id: tableId, name: next });
  };

  const setQuery = (next: RowQuery) => void navigate({ to: ".", search: toDataSearch(next, row), replace: true });
  const openRow = useCallback((id: string | undefined) => void navigate({ to: ".", search: (prev: DataSearch) => ({ ...prev, row: id }) }), [navigate]);

  if (table.error) return <p role="alert" className="text-[14px] text-danger">{t("table.failed")}</p>;
  if (!table.data) return <p className="text-[14px] text-muted">{t("table.loading")}</p>;

  return (
    <>
      <Link to="/settings/data" className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg">
        <ChevronLeft size={14} aria-hidden /> {t("table.back")}
      </Link>
      <div className="mb-6 flex items-center gap-2">
        <input
          aria-label={t("table.name")}
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setName(table.data?.name ?? "");
              e.currentTarget.blur();
            }
          }}
          className="min-w-0 flex-1 rounded-lg bg-transparent px-1 text-[28px] font-semibold leading-tight tracking-tight outline-none hover:bg-hover focus:bg-hover"
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={t("table.menu")}>
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setSettingEvents(true)}>
              <Zap /> {t("table.events")}
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
              <Trash2 /> {t("table.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {rename.error && (
        <p role="alert" className="mb-4 text-[13px] text-danger">
          {rename.error.message}
        </p>
      )}
      <StateTabs label={t("table.tabs")} tabs={TABS.map((tab) => [tab, t(`table.tab.${tab}`)] as const)} selected={shown} onSelect={setShown}>
        <TabsPrimitive.Content value="rows">
          <Grid
            tableId={tableId}
            fields={table.data.fields}
            onSchemaChanged={schemaChanged}
            query={query}
            onQueryChange={setQuery}
            onOpenRow={openRow}
            requiredParent={table.data.parent?.required ? table.data.fields.find((f) => f.id === table.data.parent!.fieldId) : undefined}
          />
          {row && <RowDetail key={row} tableId={tableId} rowId={row} fields={table.data.fields} onClose={() => openRow(undefined)} />}
        </TabsPrimitive.Content>
        <TabsPrimitive.Content value="memory">
          <MemoryPanel key={tableId} where={{ scope: "table", tableId }} />
        </TabsPrimitive.Content>
      </StateTabs>

      {settingEvents && <PrimitiveDialog table={table.data} open={settingEvents} onOpenChange={setSettingEvents} onSaved={schemaChanged} />}

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogTitle>{t("table.confirm", { name: table.data.name })}</DialogTitle>
          <DialogDescription>{t("table.confirmText")}</DialogDescription>
          {remove.error && <p role="alert" className="text-[13px] text-danger">{remove.error.message}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              {t("table.cancel")}
            </Button>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate({ id: tableId })}>
              {t("table.delete")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
