import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { PageHeader } from "../components/Placeholder.tsx";
import { List } from "../components/settings/parts.tsx";
import { orpc } from "../lib/api.ts";

export const Route = createFileRoute("/_app/settings/people")({ component: People });

type Scope = { organizationId: string; workspaceId: string };

function People() {
  const { t } = useTranslation("settings");
  const managed = useQuery(orpc.workspace.managed.queryOptions({ gcTime: 0 }));
  return <>
    <PageHeader title={t("people.title")} />
    {managed.isError ? <p role="alert">{t("people.loadFailed")}</p>
      : !managed.data ? <p role="status">{t("loading")}</p>
      : managed.data.length === 1 ? <Directory key={managed.data[0]!.workspaceId} scope={managed.data[0]!} />
      : <p>{t("people.unavailable")}</p>}
  </>;
}

function Directory({ scope }: { scope: Scope }) {
  const { t } = useTranslation(["settings", "common"]);
  const client = useQueryClient();
  const people = useQuery(orpc.workspace.people.queryOptions({ input: scope, gcTime: 0, refetchInterval: 5000, retry: false }));
  const [selected, setSelected] = useState<string>();
  const [notice, setNotice] = useState("");
  const remove = useMutation(orpc.workspace.removePerson.mutationOptions({
    onSuccess: async () => {
      const name = people.data?.find((p) => p.userId === selected)?.name;
      setSelected(undefined);
      await Promise.all([
        client.invalidateQueries({ queryKey: orpc.workspace.people.queryKey({ input: scope }) }),
        client.invalidateQueries({ queryKey: orpc.workspace.managed.key() }),
      ]);
      if (name) setNotice(t("people.removed", { name }));
    },
  }));

  if (people.isError) return <p role="alert">{t("people.loadFailed")}</p>;
  if (!people.data || !people.isFetchedAfterMount) return <p role="status">{t("loading")}</p>;
  return <>
    <List>
      {people.data.map((person) => (
        <li key={person.userId} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4">
          <div className="min-w-0 flex-1 basis-40">
            <p className="break-words text-[15px] font-medium">{person.name}</p>
            <p className="break-all text-[13px] text-muted">{person.email}</p>
          </div>
          <span className="text-sm text-muted">{t(`people.role.${person.role}`)}</span>
          {person.role !== "owner" && (
            <Dialog open={selected === person.userId} onOpenChange={(open) => {
              if (remove.isPending) return;
              remove.reset();
              setNotice("");
              setSelected(open ? person.userId : undefined);
            }}>
              <DialogTrigger asChild>
                <Button size="sm" variant="outline" aria-label={t("people.removePerson", { name: person.name })}>{t("people.remove")}</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogTitle>{t("people.confirm", { name: person.name })}</DialogTitle>
                <DialogDescription>{t("people.effect", { email: person.email })}</DialogDescription>
                {remove.isError && <p role="alert" className="text-sm text-danger">{t("people.removeFailed")}</p>}
                <div className="flex justify-end gap-2">
                  <DialogClose asChild><Button variant="outline" disabled={remove.isPending}>{t("common:actions.cancel")}</Button></DialogClose>
                  <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate({ ...scope, userId: person.userId })}>{t("people.remove")}</Button>
                </div>
              </DialogContent>
            </Dialog>
          )}
        </li>
      ))}
    </List>
    <p role="status" className="mt-3 text-sm text-muted">{notice}</p>
  </>;
}
