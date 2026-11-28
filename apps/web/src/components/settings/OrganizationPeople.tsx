import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { orpc, type api } from "../../lib/api.ts";
import { List } from "./parts.tsx";

type Directory = Awaited<ReturnType<typeof api.organization.directory>>;
type Member = Directory["people"][number];
type Role = "manager" | "member";

const selectClass = "min-h-11 rounded-md border border-input bg-surface px-3 text-sm";

/**
 * Every person of the organization, for its owner, with the workspaces they have a role in: one
 * with no workspace role (just restored, say) is here too. The owner gives a person a role in a
 * workspace, takes it away, removes them from the organization, deletes them, or hands them its
 * ownership (`onTransferred`: the page's own rights have changed).
 */
export function OrganizationPeople({ retentionDays, onTransferred }: { retentionDays: number; onTransferred: (name: string) => void }) {
  const { t } = useTranslation(["settings", "common"]);
  const directory = useQuery(orpc.organization.directory.queryOptions({ retry: false }));
  const status = useRef<HTMLParagraphElement>(null);
  const [said, setSaid] = useState("");
  const done = (text: string) => ({ onSuccess: () => setSaid(text) });
  const assign = useMutation(orpc.organization.assign.mutationOptions());
  const unassign = useMutation(orpc.organization.unassign.mutationOptions());
  const archive = useMutation(orpc.organization.archiveMember.mutationOptions());
  const remove = useMutation(orpc.organization.removeMember.mutationOptions());
  const transfer = useMutation(orpc.organization.transferOwnership.mutationOptions());
  const failed = assign.error ?? unassign.error ?? archive.error ?? remove.error ?? transfer.error;
  const busy = assign.isPending || unassign.isPending || archive.isPending || remove.isPending || transfer.isPending;
  if (directory.isError)
    return (
      <p role="alert" className="mt-8">
        {t("organizationPeople.loadFailed")}
      </p>
    );
  if (!directory.data) return null;
  const names = new Map(directory.data.workspaces.map((w) => [w.workspaceId, w.name]));
  // What the owner keeps after handing ownership over: the roles they were given, if any.
  const kept = directory.data.people.flatMap((p) => (p.role === "owner" ? p.workspaces.map((w) => names.get(w.workspaceId)!) : []));
  const act = (run: () => void) => {
    setSaid("");
    assign.reset();
    unassign.reset();
    archive.reset();
    remove.reset();
    transfer.reset();
    status.current?.focus();
    run();
  };
  return (
    <section aria-labelledby="organization-people" className="mt-8">
      <h2 id="organization-people" className="text-[17px] font-medium tracking-tight">
        {t("organizationPeople.title")}
      </h2>
      <p className="mb-3 text-[13px] text-muted">{t("organizationPeople.text")}</p>
      <List>
        {directory.data.people.map((person) => (
          <MemberRow
            key={person.userId}
            person={person}
            directory={directory.data}
            names={names}
            busy={busy}
            retentionDays={retentionDays}
            kept={kept}
            focusStatus={() => status.current?.focus()}
            onRemove={() => act(() => remove.mutate({ userId: person.userId }, done(t("organizationPeople.left", { name: person.name }))))}
            onTransfer={() => act(() => transfer.mutate({ userId: person.userId }, { onSuccess: () => onTransferred(person.name) }))}
            onAssign={(workspaceId, role) =>
              act(() =>
                assign.mutate(
                  { userId: person.userId, workspaceId, role },
                  done(t("organizationPeople.added", { name: person.name, workspace: names.get(workspaceId) })),
                ),
              )
            }
            onUnassign={(workspaceId) =>
              act(() =>
                unassign.mutate(
                  { userId: person.userId, workspaceId },
                  done(t("organizationPeople.taken", { name: person.name, workspace: names.get(workspaceId) })),
                ),
              )
            }
            onDelete={() => act(() => archive.mutate({ userId: person.userId }, done(t("people.deleted", { name: person.name }))))}
          />
        ))}
      </List>
      {failed && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {failed.message}
        </p>
      )}
      <p ref={status} tabIndex={-1} role="status" className="mt-3 text-sm text-muted">
        {busy ? t("organizationPeople.saving") : said}
      </p>
    </section>
  );
}

function MemberRow({
  person,
  directory,
  names,
  busy,
  retentionDays,
  kept,
  focusStatus,
  onAssign,
  onUnassign,
  onRemove,
  onTransfer,
  onDelete,
}: {
  person: Member;
  directory: Directory;
  names: Map<string, string>;
  busy: boolean;
  retentionDays: number;
  kept: string[];
  focusStatus: () => void;
  onAssign: (workspaceId: string, role: Role) => void;
  onUnassign: (workspaceId: string) => void;
  onRemove: () => void;
  onTransfer: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation("settings");
  const owner = person.role === "owner";
  const open = directory.workspaces.filter((w) => !person.workspaces.some((p) => p.workspaceId === w.workspaceId));
  const [workspaceId, setWorkspaceId] = useState("");
  const [role, setRole] = useState<Role>("member");
  const confirm = { busy, focusStatus };
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
          <div className="flex flex-wrap gap-2">
            <Confirm
              {...confirm}
              label={t("organizationPeople.makeOwner")}
              aria={t("organizationPeople.makeOwnerPerson", { name: person.name })}
              title={t("organizationPeople.makeOwnerConfirm", { name: person.name })}
              effect={`${t("organizationPeople.makeOwnerEffect", { name: person.name })} ${
                kept.length ? t("organizationPeople.makeOwnerKeeps", { workspaces: kept }) : t("organizationPeople.makeOwnerKeepsNone", { name: person.name })
              }`}
              onConfirm={onTransfer}
            />
            <Confirm
              {...confirm}
              label={t("organizationPeople.leave")}
              aria={t("organizationPeople.leavePerson", { name: person.name })}
              title={t("organizationPeople.leaveConfirm", { name: person.name })}
              effect={t("organizationPeople.leaveEffect", { email: person.email })}
              onConfirm={onRemove}
            />
            <Confirm
              {...confirm}
              label={t("people.delete")}
              aria={t("people.deletePerson", { name: person.name })}
              title={t("people.deleteConfirm", { name: person.name })}
              effect={t("people.deleteEffect", { email: person.email, days: retentionDays })}
              onConfirm={onDelete}
            />
          </div>
        )}
      </div>
      {owner ? (
        <p className="text-[13px] text-muted">{t("organizationPeople.everyWorkspace")}</p>
      ) : (
        <>
          {person.workspaces.length === 0 ? (
            <p className="text-[13px] text-muted">{t("organizationPeople.noWorkspace")}</p>
          ) : (
            <ul className="flex flex-wrap gap-2" aria-label={t("organizationPeople.workspacesOf", { name: person.name })}>
              {person.workspaces.map((w) => (
                <li key={w.workspaceId} className="flex items-center gap-2 rounded-full bg-hover pl-3 pr-1 py-0.5 text-[13px]">
                  <span>{t("organizationPeople.roleIn", { workspace: names.get(w.workspaceId), role: t(`people.role.${w.role}`) })}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label={t("organizationPeople.take", { name: person.name, workspace: names.get(w.workspaceId) })}
                    onClick={() => onUnassign(w.workspaceId)}
                  >
                    {t("organizationPeople.remove")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {open.length > 0 && (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (picked) onAssign(picked, role);
              }}
            >
              <label className="sr-only" htmlFor={`add-workspace-${person.userId}`}>
                {t("organizationPeople.workspaceFor", { name: person.name })}
              </label>
              <select
                id={`add-workspace-${person.userId}`}
                className={selectClass}
                value={picked}
                disabled={busy}
                onChange={(e) => setWorkspaceId(e.target.value)}
              >
                {open.map((w) => (
                  <option key={w.workspaceId} value={w.workspaceId}>
                    {w.name}
                  </option>
                ))}
              </select>
              <label className="sr-only" htmlFor={`add-role-${person.userId}`}>
                {t("organizationPeople.roleFor", { name: person.name })}
              </label>
              <select
                id={`add-role-${person.userId}`}
                className={selectClass}
                value={role}
                disabled={busy}
                onChange={(e) => setRole(e.target.value === "manager" ? "manager" : "member")}
              >
                <option value="member">{t("people.role.member")}</option>
                <option value="manager">{t("people.role.manager")}</option>
              </select>
              <Button
                type="submit"
                size="sm"
                variant="outline"
                disabled={busy || !picked}
                aria-label={t("organizationPeople.addPerson", { name: person.name })}
              >
                {t("organizationPeople.add")}
              </Button>
            </form>
          )}
        </>
      )}
    </li>
  );
}

/** A button that asks before it acts; once confirmed, the focus goes to where the outcome is said. */
function Confirm({
  label,
  aria,
  title,
  effect,
  busy,
  focusStatus,
  onConfirm,
}: {
  label: string;
  aria: string;
  title: string;
  effect: string;
  busy: boolean;
  focusStatus: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation("common");
  const [open, setOpen] = useState(false);
  const submitted = useRef(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next || !busy) setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" aria-disabled={busy} aria-label={aria}>
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent
        onCloseAutoFocus={(event) => {
          if (!submitted.current) return;
          event.preventDefault();
          submitted.current = false;
          focusStatus();
        }}
      >
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{effect}</DialogDescription>
        <div className="flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="outline">{t("actions.cancel")}</Button>
          </DialogClose>
          <Button
            variant="destructive"
            onClick={() => {
              submitted.current = true;
              setOpen(false);
              onConfirm();
            }}
          >
            {label}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
