import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Ellipsis, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { orpc } from "../../lib/api.ts";

/** A page's "…" menu (never on Home): Rename starts the title's inline edit, Delete asks first, then goes Home. */
export function PageMenu({ page, onRename }: { page: { id: string; title: string }; onRename: () => void }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const [confirming, setConfirming] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const remove = useMutation(
    orpc.pages.delete.mutationOptions({
      onSuccess: async () => {
        await navigate({ to: "/" });
        await queryClient.invalidateQueries({ queryKey: orpc.pages.list.key() });
        queryClient.removeQueries({ queryKey: orpc.pages.get.queryKey({ input: { id: page.id } }) });
      },
    }),
  );
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t("page.options")}>
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-40 rounded-xl border-0 p-2 shadow-pop">
          <DropdownMenuItem onSelect={onRename} className="text-[13px]">
            <Pencil aria-hidden /> {t("page.rename")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setConfirming(true)} className="text-[13px] text-danger focus:text-danger">
            <Trash2 aria-hidden /> {t("page.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogTitle>{t("page.deleteTitle", { title: page.title })}</DialogTitle>
          <DialogDescription>{t("page.deleteText")}</DialogDescription>
          {remove.error && (
            <p role="alert" className="text-[13px] text-danger">
              {t("page.deleteFailed")}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline">{t("common:actions.cancel")}</Button>
            </DialogClose>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate({ id: page.id })}>
              {t("page.deletePage")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
