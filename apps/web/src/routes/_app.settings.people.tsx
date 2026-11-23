import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { PageHeader } from "../components/Placeholder.tsx";
import { WorkspaceInvitations } from "../components/settings/WorkspaceInvitations.tsx";
import { List } from "../components/settings/parts.tsx";
import { orpc, type api } from "../lib/api.ts";
import { useWorkspaces } from "../lib/workspace.tsx";

export const Route = createFileRoute("/_app/settings/people")({ component: People });

type Scope = { organizationId: string; workspaceId: string };

function People() {
  const { t } = useTranslation("settings");
  const managed = useQuery(orpc.workspace.managed.queryOptions({ gcTime: 0 }));
  // Only the tab's workspace: another one the person manages is managed from its own tab.
  const { current } = useWorkspaces();
  const scope = managed.data?.find((m) => m.workspaceId === current?.workspaceId);
  return <>
    <PageHeader title={t("people.title")} />
    {managed.isError ? <p role="alert">{t("people.loadFailed")}</p>
      : !managed.data ? <p role="status">{t("loading")}</p>
      : scope ? <WorkspacePeople key={scope.workspaceId} scope={scope} />
      : <p>{t("people.unavailable")}</p>}
  </>;
}

function WorkspacePeople({ scope: workspace }: { scope: Awaited<ReturnType<typeof api.workspace.managed>>[number] }) {
  const scope = { workspaceId: workspace.workspaceId, organizationId: workspace.organizationId };
  return <><Directory scope={scope} /><WorkspaceInvitations scope={scope} names={workspace} /></>;
}

function Directory({ scope }: { scope: Scope }) {
  const { t } = useTranslation("settings");
  const people = useQuery(orpc.workspace.people.queryOptions({
    input: scope, gcTime: 0, refetchInterval: 5000, refetchIntervalInBackground: true, retry: false,
  }));
  const client = useQueryClient();
  const status = useRef<HTMLParagraphElement>(null);
  const remove = useMutation(orpc.workspace.removePerson.mutationOptions({
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: orpc.workspace.people.queryKey({ input: scope }) }),
        client.invalidateQueries({ queryKey: orpc.workspace.managed.key() }),
      ]);
    },
  }));
  const [name, setName] = useState("");
  if (people.isError || people.fetchStatus === "paused") return <p role="alert">{t("people.loadFailed")}</p>;
  if (!people.data || !people.isFetchedAfterMount) return <p role="status">{t("loading")}</p>;

  return <>
    <PeopleList people={people.data} busy={remove.isPending} focusStatus={() => status.current?.focus()} onRemove={(person) => {
      setName(person.name);
      remove.mutate({ ...scope, userId: person.userId });
    }} />
    {remove.isError && <p role="alert" className="mt-3 text-sm text-danger">{t("people.removeFailed")}</p>}
    <p ref={status} tabIndex={-1} role="status" className="mt-3 text-sm text-muted">
      {remove.isPending ? t("people.removing", { name }) : remove.isSuccess && t("people.removed", { name })}
    </p>
  </>;
}

type Person = Awaited<ReturnType<typeof api.workspace.people>>[number];

function PeopleList({ people, busy, focusStatus, onRemove }: { people: Person[]; busy: boolean; focusStatus: () => void; onRemove: (person: Person) => void }) {
  const { t } = useTranslation(["settings", "common"]);
  const submitted = useRef(false);
  const [selected, setSelected] = useState<string>();
  return <List>
      {people.map((person) => (
        <li key={person.userId} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4">
          <div className="min-w-0 flex-1 basis-40">
            <p className="break-words text-[15px] font-medium">{person.name}</p>
            <p className="break-all text-[13px] text-muted">{person.email}</p>
          </div>
          <span className="text-sm text-muted">{t(`people.role.${person.role}`)}</span>
          {person.role !== "owner" && (
            <Dialog open={selected === person.userId} onOpenChange={(open) => {
              if (!open || !busy) setSelected(open ? person.userId : undefined);
            }}>
              <DialogTrigger asChild>
                <Button size="sm" variant="outline" aria-disabled={busy} aria-label={t("people.removePerson", { name: person.name })}>{t("people.remove")}</Button>
              </DialogTrigger>
              <DialogContent onCloseAutoFocus={(event) => {
                if (submitted.current) {
                  event.preventDefault();
                  submitted.current = false;
                  focusStatus();
                }
              }}>
                <DialogTitle>{t("people.confirm", { name: person.name })}</DialogTitle>
                <DialogDescription>{t("people.effect", { email: person.email })}</DialogDescription>
                <div className="flex justify-end gap-2">
                  <DialogClose asChild><Button variant="outline">{t("common:actions.cancel")}</Button></DialogClose>
                  <Button variant="destructive" onClick={() => { submitted.current = true; setSelected(undefined); onRemove(person); }}>{t("people.remove")}</Button>
                </div>
              </DialogContent>
            </Dialog>
          )}
        </li>
      ))}
    </List>;
}
