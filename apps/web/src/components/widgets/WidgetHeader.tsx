import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { orpc } from "../../lib/api.ts";

/** The title of a widget; in edit mode it renames the widget, deletes it, and carries `extra`. */
export function WidgetHeader({ widget, editing, extra }: { widget: { id: string; title: string }; editing: boolean; extra?: ReactNode }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(widget.title);
  useEffect(() => setTitle(widget.title), [widget.title]);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.pages.key() });
  const rename = useMutation(orpc.widgets.update.mutationOptions({ onSettled: refresh }));
  const remove = useMutation(orpc.widgets.delete.mutationOptions({ onSettled: refresh }));
  const save = () => {
    const next = title.trim();
    if (!next) setTitle(widget.title);
    else if (next !== widget.title) rename.mutate({ id: widget.id, title: next });
  };
  return (
    <header className={cn("flex items-center gap-2 px-5 pb-2 pt-4", editing && "widget-drag cursor-grab")}>
      {editing ? (
        <Input
          aria-label="Widget title"
          value={title}
          maxLength={100}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          className="h-8 flex-1 text-[15px] font-semibold"
        />
      ) : (
        <h2 className="flex-1 truncate text-[17px] font-semibold tracking-tight">{widget.title}</h2>
      )}
      {editing && extra}
      {editing && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Delete ${widget.title}`}
          className="rounded-full text-muted"
          disabled={remove.isPending}
          onClick={() => remove.mutate({ id: widget.id })}
        >
          <X aria-hidden />
        </Button>
      )}
    </header>
  );
}

