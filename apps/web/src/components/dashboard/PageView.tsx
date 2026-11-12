import { Plus } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { Widget } from "../widgets/WorkflowFormWidget.tsx";
import { AddWidgetSheet } from "./AddWidgetSheet.tsx";
import { Dashboard } from "./Dashboard.tsx";

/**
 * A page: its header (title and what the page adds, then Add widget and Edit), and its widgets,
 * or `empty` when it has none. Home and every other page share it.
 */
export function PageView({
  page,
  heading,
  empty,
}: {
  page: { id: string; widgets: Widget[] };
  heading: ReactNode;
  empty: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const widgets = page.widgets;
  return (
    <>
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">{heading}</div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setAdding(true)}>
            <Plus aria-hidden />
            Add widget
          </Button>
          {widgets.length > 0 && (
            <Button variant={editing ? "default" : "outline"} onClick={() => setEditing((e) => !e)}>
              {editing ? "Done" : "Edit"}
            </Button>
          )}
        </div>
      </header>
      {widgets.length === 0 ? empty : <Dashboard pageId={page.id} widgets={widgets} editing={editing} />}
      {adding && <AddWidgetSheet pageId={page.id} onClose={() => setAdding(false)} />}
    </>
  );
}

/** "Nothing here yet", for a page without widgets. */
export function EmptyPage({ text }: { text: string }) {
  return (
    <div className="grid place-items-center rounded-2xl bg-surface px-6 py-16 text-center shadow-card">
      <p className="text-[17px] font-medium">Nothing here yet</p>
      <p className="mt-1 max-w-sm text-[14px] text-muted">{text}</p>
    </div>
  );
}
