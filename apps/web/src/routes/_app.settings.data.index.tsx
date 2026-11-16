import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Empty, List } from "../components/settings/parts.tsx";
import { PageHeader } from "../components/Placeholder.tsx";
import { orpc } from "../lib/api.ts";
import { qualifiedName } from "@dispand/domain/plugins/names";

export const Route = createFileRoute("/_app/settings/data/")({ component: Tables });

function Tables() {
  const { t } = useTranslation("data");
  const tables = useQuery(orpc.tables.list.queryOptions());
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const create = useMutation(
    orpc.tables.create.mutationOptions({
      onSuccess: async (table) => {
        await queryClient.invalidateQueries({ queryKey: orpc.tables.key() });
        await navigate({ to: "/settings/data/$tableId", params: { tableId: table.id } });
      },
    }),
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({ name: name.trim() });
  };

  const newTable = naming ? (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <Input
        aria-label={t("tables.name")}
        placeholder={t("tables.name")}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setNaming(false)}
        maxLength={100}
        autoFocus
        className="w-56"
      />
      <Button type="submit" disabled={create.isPending || name.trim() === ""}>
        {t("tables.create")}
      </Button>
    </form>
  ) : (
    <Button onClick={() => setNaming(true)}>
      <Plus /> {t("tables.new")}
    </Button>
  );

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader title={t("tables.title")} subtitle={t("tables.subtitle")} />
        {tables.data && tables.data.length > 0 && newTable}
      </div>
      {create.error && (
        <p role="alert" className="mb-4 text-[14px] text-danger">
          {create.error.message}
        </p>
      )}
      {tables.error && <p role="alert" className="text-[14px] text-danger">{t("tables.failed")}</p>}
      {tables.data?.length === 0 && (
        <Empty title={t("tables.emptyTitle")} text={t("tables.emptyText")}>
          {newTable}
        </Empty>
      )}
      {tables.data && tables.data.length > 0 && (
        <List>
          {tables.data.map((table) => (
            <li key={table.id}>
              <Link to="/settings/data/$tableId" params={{ tableId: table.id }} className="flex items-center justify-between gap-4 px-5 py-4 transition hover:bg-hover">
                <span className="truncate text-[15px] font-medium">{qualifiedName(table.plugin?.name ?? null, table.name)}</span>
                <span className="shrink-0 text-[13px] text-muted">{t("tables.rows", { count: table.rowCount })}</span>
              </Link>
            </li>
          ))}
        </List>
      )}
    </>
  );
}
