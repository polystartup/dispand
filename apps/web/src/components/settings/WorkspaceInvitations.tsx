import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, orpc } from "../../lib/api.ts";
import { useFormat } from "../../lib/format.ts";
import { refusal } from "../../lib/refusal.ts";
import { FormField, List } from "./parts.tsx";

type Scope = Parameters<typeof api.workspace.invitations>[0];
type Names = { workspaceName: string; organizationName: string };
type Invitation = Awaited<ReturnType<typeof api.workspace.invitations>>[number];

export function WorkspaceInvitations({ scope, names }: { scope: Scope; names: Names }) {
  const { t } = useTranslation("settings");
  const format = useFormat();
  const client = useQueryClient();
  const options = orpc.workspace.invitations.queryOptions({ input: scope, gcTime: 0, refetchInterval: 5000, refetchIntervalInBackground: true, retry: false });
  const pending = useQuery(options);
  const refresh = () => client.invalidateQueries({ queryKey: options.queryKey });
  async function rememberInvitation(row: Invitation) {
    await client.cancelQueries({ queryKey: options.queryKey });
    // A slower creation response must not repopulate a directory that a newer read denied.
    if (client.getQueryState(options.queryKey)?.status === "success") {
      client.setQueryData(options.queryKey, (rows) => rows && [...rows.filter((old) => old.email !== row.email), row]);
    }
    void refresh();
  }
  const revoke = useMutation(orpc.workspace.revokeInvitation.mutationOptions({ onSettled: refresh }));
  const status = useRef<HTMLParagraphElement>(null);
  const refused = pending.error && "code" in pending.error && ["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"].includes(String(pending.error.code));
  if (refused || pending.fetchStatus === "paused") return <p role="alert">{t("invitations.loadFailed")}</p>;
  if (pending.isPending || !pending.isFetchedAfterMount) return <p role="status">{t("loading")}</p>;

  return <section aria-labelledby="invitations-title" className="mt-8">
    <div className="mb-4 flex items-center justify-between gap-3">
      <h2 id="invitations-title" className="text-lg font-semibold">{t("invitations.title")}</h2>
      <CreateInvitation scope={scope} names={names} pending={pending.isSuccess ? pending.data : undefined} onCreated={rememberInvitation} />
    </div>
    {pending.isError ? <p role="alert">{t("invitations.loadFailed")}</p> : pending.data.length === 0 ? <p className="text-sm text-muted">{t("invitations.empty")}</p> : <List>
      {pending.data.map((invitation) => <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div className="min-w-0">
          <p className="break-all font-medium">{invitation.email}</p>
          <p className="text-sm text-muted">{t("invitations.detail", { role: t(`people.role.${invitation.role}`), date: format.dateTime(invitation.expiresAt) })}</p>
        </div>
        <Button size="sm" variant="outline" disabled={revoke.isPending} aria-label={t("invitations.revokeFor", { email: invitation.email })} onClick={() => { status.current?.focus(); revoke.mutate({ ...scope, id: invitation.id }); }}>{t("invitations.revoke")}</Button>
      </li>)}
    </List>}
    {revoke.error && <p role="alert" className="mt-2 text-sm text-danger">{refusal(revoke.error, t("invitations.revokeFailed"))}</p>}
    <p role="status" ref={status} tabIndex={-1} className="mt-2 text-sm text-muted">{revoke.isPending ? t("invitations.revoking") : revoke.isSuccess && t("invitations.revoked")}</p>
  </section>;
}

type InviteProps = { scope: Scope; names: Names; pending?: Invitation[]; onCreated: (row: Invitation) => Promise<void> };

function CreateInvitation(props: InviteProps) {
  const { t } = useTranslation("settings");
  const [open, setOpen] = useState(false);
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button disabled={!props.pending}>{t("invitations.invite")}</Button></DialogTrigger>
    {open && <InviteForm {...props} />}
  </Dialog>;
}

function InviteForm({ scope, names, pending, onCreated }: InviteProps) {
  const { t } = useTranslation(["settings", "common"]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Invitation["role"]>("member");
  const [issued, setIssued] = useState<{ id: string; link: string; email: string }>();
  const [copied, setCopied] = useState<"copied" | "manual">();
  const field = useRef<HTMLInputElement>(null);
  const invite = useMutation({ mutationFn: async () => {
    // The token lives only in this open dialog. The mutation cache receives no invitation link.
    const { id, token, expiresAt } = await api.workspace.invite({ ...scope, email, role });
    const address = email.trim().toLowerCase();
    await onCreated({ id, expiresAt, email: address, role });
    setIssued({ id, email: address, link: window.location.origin + "/invitation#" + token });
  } });

  if (issued) {
    const available = !pending || pending.some((row) => row.id === issued.id);
    return <DialogContent>
      <DialogTitle>{t("invitations.linkTitle")}</DialogTitle>
      <DialogDescription className="wrap-anywhere">{available ? t("invitations.handoff", { email: issued.email }) : t("invitations.unavailable")}</DialogDescription>
      {available && <>
        <FormField htmlFor="invitation-link" label={t("invitations.linkLabel")}>
          <Input id="invitation-link" ref={field} readOnly value={issued.link} onFocus={(event) => event.target.select()} />
        </FormField>
        <p role="status" className="text-sm text-muted">{copied && t(`invitations.${copied}`)}</p>
      </>}
      <div className="flex justify-end gap-2">
        <DialogClose asChild><Button variant="outline">{t("invitations.done")}</Button></DialogClose>
        {available && <Button onClick={async () => {
          try { await navigator.clipboard.writeText(issued.link); setCopied("copied"); }
          catch { field.current?.focus(); field.current?.select(); setCopied("manual"); }
        }}>{t("invitations.copy")}</Button>}
      </div>
    </DialogContent>;
  }

  return <DialogContent
    onEscapeKeyDown={(event) => { if (invite.isPending) event.preventDefault(); }}
    onInteractOutside={(event) => { if (invite.isPending) event.preventDefault(); }}
  >
    <DialogTitle>{t("invitations.invite")}</DialogTitle>
    <DialogDescription className="wrap-anywhere">{t("invitations.instructions", names)}</DialogDescription>
    <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); invite.mutate(); }}>
      <FormField htmlFor="invite-email" label={t("invitations.email")}><Input id="invite-email" type="email" autoComplete="off" maxLength={254} required value={email} disabled={invite.isPending} onChange={(event) => setEmail(event.target.value)} /></FormField>
      <FormField htmlFor="invite-role" label={t("invitations.role")}>
        <select id="invite-role" className="h-9 w-full rounded-md border border-input bg-surface px-3 text-sm" value={role} disabled={invite.isPending} onChange={(event) => setRole(event.target.value === "manager" ? "manager" : "member")}>
          <option value="member">{t("people.role.member")}</option><option value="manager">{t("people.role.manager")}</option>
        </select>
      </FormField>
      {invite.error && <p role="alert" className="text-sm text-danger">{refusal(invite.error, t("invitations.createFailed"))}</p>}
      <div className="flex justify-end gap-2">
        <DialogClose asChild><Button type="button" variant="outline">{t(invite.isPending ? "invitations.discard" : "common:actions.cancel")}</Button></DialogClose>
        <Button type="submit" disabled={invite.isPending}>{t("invitations.create")}</Button>
      </div>
    </form>
  </DialogContent>;
}
