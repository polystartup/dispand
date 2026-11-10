import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Ellipsis, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { orpc } from "../../lib/api.ts";

/** A page's "…" menu (never on Home): Rename starts the title's inline edit, Delete asks first, then goes Home. */
export function PageMenu({ page, onRename }: { page: { id: string; title: string }; onRename: () => void }) {
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
          <Button variant="ghost" size="icon-sm" aria-label="Page options">
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-40 rounded-xl border-0 p-2 shadow-pop">
          <DropdownMenuItem onSelect={onRename} className="text-[13px]">
            <Pencil aria-hidden /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setConfirming(true)} className="text-[13px] text-danger focus:text-danger">
            <Trash2 aria-hidden /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogTitle>{`Delete “${page.title}” and its widgets?`}</DialogTitle>
          <DialogDescription>The workflows and tables they show stay.</DialogDescription>
          {remove.error && (
            <p role="alert" className="text-[13px] text-danger">
              Could not delete the page. Try again.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate({ id: page.id })}>
              Delete page
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
