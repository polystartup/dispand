import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Settings2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { orpc } from "../../lib/api.ts";
import type { DataWidget } from "../widgets/data-widget.tsx";
import { DataWidgetForm } from "./DataWidgetForm.tsx";

/** In edit mode, the button that changes the fields a Grid or Table widget shows. */
export function DataWidgetSettings({ widget }: { widget: DataWidget }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const save = useMutation(
    orpc.widgets.update.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: orpc.pages.key() });
        setOpen(false);
      },
    }),
  );
  return (
    <>
      <Button variant="ghost" size="icon-sm" aria-label={`Settings of ${widget.title}`} className="rounded-full text-muted" onClick={() => setOpen(true)}>
        <Settings2 aria-hidden />
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) save.reset();
        }}
      >
        <DialogContent>
          <DialogTitle>Widget settings</DialogTitle>
          <DialogDescription>The table's rows are shown with these fields.</DialogDescription>
          <DataWidgetForm
            kind={widget.type}
            initial={{ tableId: widget.tableId, config: widget.config }}
            submitLabel="Save"
            pending={save.isPending}
            error={save.error?.message}
            onSubmit={({ config }) => save.mutate({ id: widget.id, config })}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
