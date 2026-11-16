import type { FieldSchema } from "@dispand/domain/data/fields";
import { useMutation } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, ChevronDown, Pencil, Repeat, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { orpc } from "../../lib/api.ts";
import { RetypeDialog } from "./RetypeDialog.tsx";

type Props = { field: FieldSchema; fields: FieldSchema[]; tableId: string; onChanged: () => void };

/** A field's header menu: rename, change type, move left or right, delete. */
export function FieldMenu({ field, fields, tableId, onChanged }: Props) {
  const { t } = useTranslation("data");
  const [dialog, setDialog] = useState<"rename" | "retype" | "delete" | null>(null);
  const [name, setName] = useState(field.name);
  const index = fields.findIndex((f) => f.id === field.id);
  const close = () => setDialog(null);
  const done = { onSuccess: () => (close(), onChanged()) };
  const rename = useMutation(orpc.fields.update.mutationOptions(done));
  const remove = useMutation(orpc.fields.delete.mutationOptions(done));
  const reorder = useMutation(orpc.fields.reorder.mutationOptions({ onSuccess: onChanged }));

  const move = (by: -1 | 1) => {
    const ids = fields.map((f) => f.id);
    [ids[index], ids[index + by]] = [ids[index + by]!, ids[index]!];
    reorder.mutate({ tableId, fieldIds: ids });
  };
  const submitRename = (e: FormEvent) => {
    e.preventDefault();
    rename.mutate({ id: field.id, name: name.trim() });
  };
  const open = (which: NonNullable<typeof dialog>) => {
    rename.reset();
    remove.reset();
    setName(field.name);
    setDialog(which);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label={t("fieldMenu.label", { name: field.name })} className="grid size-6 shrink-0 place-items-center rounded-md text-muted hover:bg-hover">
            <ChevronDown size={14} aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => open("rename")}>
            <Pencil /> {t("fieldMenu.rename")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => open("retype")}>
            <Repeat /> {t("fieldMenu.retype")}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={index <= 0} onSelect={() => move(-1)}>
            <ArrowLeft /> {t("fieldMenu.left")}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={index >= fields.length - 1} onSelect={() => move(1)}>
            <ArrowRight /> {t("fieldMenu.right")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" disabled={fields.length <= 1} onSelect={() => open("delete")}>
            <Trash2 /> {t("fieldMenu.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={dialog === "rename"} onOpenChange={(o) => !o && close()}>
        <DialogContent>
          <DialogTitle>{t("fieldMenu.renameTitle", { name: field.name })}</DialogTitle>
          <form onSubmit={submitRename} className="grid gap-4">
            <label className="grid gap-1 text-[13px] font-medium text-muted">
              {t("fieldMenu.name")}
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required autoFocus />
            </label>
            {rename.error && <p role="alert" className="text-[13px] text-danger">{rename.error.message}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={close}>
                {t("fieldMenu.cancel")}
              </Button>
              <Button type="submit" disabled={rename.isPending || name.trim() === ""}>
                {t("fieldMenu.rename")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <RetypeDialog field={field} open={dialog === "retype"} onOpenChange={(o) => !o && close()} onDone={onChanged} />

      <Dialog open={dialog === "delete"} onOpenChange={(o) => !o && close()}>
        <DialogContent>
          <DialogTitle>{t("fieldMenu.deleteTitle", { name: field.name })}</DialogTitle>
          <DialogDescription>{t("fieldMenu.deleteText")}</DialogDescription>
          {remove.error && <p role="alert" className="text-[13px] text-danger">{remove.error.message}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>
              {t("fieldMenu.cancel")}
            </Button>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate({ id: field.id })}>
              {t("fieldMenu.delete")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
