import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { orpc, type api } from "../../lib/api.ts";
import { List } from "./parts.tsx";

type Directory = Awaited<ReturnType<typeof api.organization.directory>>;
type Member = Directory["people"][number];
type Role = "manager" | "member";

const selectClass = "h-9 rounded-md border border-input bg-surface px-3 text-sm";

/**
 * Every person of the organization, for its owner, with the workspaces they have a role in: one
 * with no workspace role (just restored, say) is here too. The owner gives a person a role in a
 * workspace, takes it away, or deletes them.
 */
export function OrganizationPeople({ retentionDays }: { retentionDays: number }) {
  const { t } = useTranslation(["settings", "common"]);
  const client = useQueryClient();
  const directory = useQuery(orpc.organization.directory.queryOptions({ retry: false }));
  const status = useRef<HTMLParagraphElement>(null);
  const [said, setSaid] = useState("");
  const refresh = () => Promise.all([
    client.invalidateQueries({ queryKey: orpc.organization.directory.key() }),
    client.invalidateQueries({ queryKey: orpc.organization.archived.key() }),
    client.invalidateQueries({ queryKey: orpc.workspace.people.key() }),
  ]);
  const done = (text: string) => ({ onSuccess: async () => { await refresh(); setSaid(text); } });
  const assign = useMutation(orpc.organization.assign.mutationOptions());
  const unassign = useMutation(orpc.organization.unassign.mutationOptions());
  const archive = useMutation(orpc.organization.archiveMember.mutationOptions());
  const failed = assign.error ?? unassign.error ?? archive.error;
  const busy = assign.isPending || unassign.isPending || archive.isPending;
  if (directory.isError) return <p role="alert" className="mt-8">{t("organizationPeople.loadFailed")}</p>;
  if (!directory.data) return null;
  const names = new Map(directory.data.workspaces.map((w) => [w.workspaceId, w.name]));
  const act = (run: () => void) => { setSaid(""); assign.reset(); unassign.reset(); archive.reset(); status.current?.focus(); run(); };
  return (
    <section aria-labelledby="organization-people" className="mt-8">
      <h2 id="organization-people" className="text-[17px] font-medium tracking-tight">{t("organizationPeople.title")}</h2>
      <p className="mb-3 text-[13px] text-muted">{t("organizationPeople.text")}</p>
      <List>
        {directory.data.people.map((person) => (
          <MemberRow key={person.userId} person={person} directory={directory.data} names={names} busy={busy} retentionDays={retentionDays}
            onAssign={(workspaceId, role) => act(() => assign.mutate({ userId: person.userId, workspaceId, role }, done(t("organizationPeople.added", { name: person.name, workspace: names.get(workspaceId) }))))}
            onUnassign={(workspaceId) => act(() => unassign.mutate({ userId: person.userId, workspaceId }, done(t("organizationPeople.taken", { name: person.name, workspace: names.get(workspaceId) }))))}
            onDelete={() => act(() => archive.mutate({ userId: person.userId }, done(t("people.deleted", { name: person.name }))))} />
        ))}
      </List>
      {failed && <p role="alert" className="mt-3 text-sm text-danger">{failed.message}</p>}
      <p ref={status} tabIndex={-1} role="status" className="mt-3 text-sm text-muted">{busy ? t("organizationPeople.saving") : said}</p>
    </section>
  );
}

function MemberRow({ person, directory, names, busy, retentionDays, onAssign, onUnassign, onDelete }: {
  person: Member; directory: Directory; names: Map<string, string>; busy: boolean; retentionDays: number;
  onAssign: (workspaceId: string, role: Role) => void; onUnassign: (workspaceId: string) => void; onDelete: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const owner = person.role === "owner";
  const open = directory.workspaces.filter((w) => !person.workspaces.some((p) => p.workspaceId === w.workspaceId));
  const [workspaceId, setWorkspaceId] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [confirming, setConfirming] = useState(false);
  const picked = open.some((w) => w.workspaceId === workspaceId) ? workspaceId : (open[0]?.workspaceId ?? "");
  return (
    <li className="flex flex-col gap-3 px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-40">
          <p className="break-words text-[15px] font-medium">{person.name}</p>
          <p className="break-all text-[13px] text-muted">{person.email}</p>
        </div>
        <span className="text-sm text-muted">{owner ? t("people.role.owner") : t("organizationPeople.member")}</span>
        {!owner && (
          <Dialog open={confirming} onOpenChange={(next) => { if (!next || !busy) setConfirming(next); }}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline" aria-disabled={busy} aria-label={t("people.deletePerson", { name: person.name })}>{t("people.delete")}</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogTitle>{t("people.deleteConfirm", { name: person.name })}</DialogTitle>
              <DialogDescription>{t("people.deleteEffect", { email: person.email, days: retentionDays })}</DialogDescription>
              <div className="flex justify-end gap-2">
                <DialogClose asChild><Button variant="outline">{t("common:actions.cancel")}</Button></DialogClose>
                <Button variant="destructive" onClick={() => { setConfirming(false); onDelete(); }}>{t("people.delete")}</Button>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </div>
      {owner ? <p className="text-[13px] text-muted">{t("organizationPeople.everyWorkspace")}</p> : (
        <>
          {person.workspaces.length === 0 ? <p className="text-[13px] text-muted">{t("organizationPeople.noWorkspace")}</p> : (
            <ul className="flex flex-wrap gap-2" aria-label={t("organizationPeople.workspacesOf", { name: person.name })}>
              {person.workspaces.map((w) => (
                <li key={w.workspaceId} className="flex items-center gap-2 rounded-full bg-hover pl-3 pr-1 py-0.5 text-[13px]">
                  <span>{t("organizationPeople.roleIn", { workspace: names.get(w.workspaceId), role: t(`people.role.${w.role}`) })}</span>
                  <Button size="sm" variant="ghost" disabled={busy} aria-label={t("organizationPeople.take", { name: person.name, workspace: names.get(w.workspaceId) })} onClick={() => onUnassign(w.workspaceId)}>
                    {t("organizationPeople.remove")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {open.length > 0 && (
            <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (picked) onAssign(picked, role); }}>
              <label className="sr-only" htmlFor={`add-workspace-${person.userId}`}>{t("organizationPeople.workspaceFor", { name: person.name })}</label>
              <select id={`add-workspace-${person.userId}`} className={selectClass} value={picked} disabled={busy} onChange={(e) => setWorkspaceId(e.target.value)}>
                {open.map((w) => <option key={w.workspaceId} value={w.workspaceId}>{w.name}</option>)}
              </select>
              <label className="sr-only" htmlFor={`add-role-${person.userId}`}>{t("organizationPeople.roleFor", { name: person.name })}</label>
              <select id={`add-role-${person.userId}`} className={selectClass} value={role} disabled={busy} onChange={(e) => setRole(e.target.value === "manager" ? "manager" : "member")}>
                <option value="member">{t("people.role.member")}</option>
                <option value="manager">{t("people.role.manager")}</option>
              </select>
              <Button type="submit" size="sm" variant="outline" disabled={busy || !picked} aria-label={t("organizationPeople.addPerson", { name: person.name })}>{t("organizationPeople.add")}</Button>
            </form>
          )}
        </>
      )}
    </li>
  );
}
