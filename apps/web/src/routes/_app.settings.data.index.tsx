import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Empty, List } from "../components/settings/parts.tsx";
import { PageHeader } from "../components/Placeholder.tsx";
import { orpc } from "../lib/api.ts";

export const Route = createFileRoute("/_app/settings/data/")({ component: Tables });

function Tables() {
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
        aria-label="Table name"
        placeholder="Table name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setNaming(false)}
        maxLength={100}
        autoFocus
        className="w-56"
      />
      <Button type="submit" disabled={create.isPending || name.trim() === ""}>
        Create
      </Button>
    </form>
  ) : (
    <Button onClick={() => setNaming(true)}>
      <Plus /> New table
    </Button>
  );

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader title="Data" subtitle="Tables that workflows read and write." />
        {tables.data && tables.data.length > 0 && newTable}
      </div>
      {create.error && (
        <p role="alert" className="mb-4 text-[14px] text-danger">
          {create.error.message}
        </p>
      )}
      {tables.error && <p role="alert" className="text-[14px] text-danger">Could not load the tables.</p>}
      {tables.data?.length === 0 && (
        <Empty title="No table yet" text="Tables hold what your workflows create and find.">
          {newTable}
        </Empty>
      )}
      {tables.data && tables.data.length > 0 && (
        <List>
          {tables.data.map((t) => (
            <li key={t.id}>
              <Link to="/settings/data/$tableId" params={{ tableId: t.id }} className="flex items-center justify-between gap-4 px-5 py-4 transition hover:bg-hover">
                <span className="truncate text-[15px] font-medium">{t.name}</span>
                <span className="shrink-0 text-[13px] text-muted">{t.rowCount === 1 ? "1 row" : `${t.rowCount} rows`}</span>
              </Link>
            </li>
          ))}
        </List>
      )}
    </>
  );
}
